const http = require("http");
const fs = require("fs");
const path = require("path");
const {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual
} = require("crypto");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const POLL_TIMEOUT_MS = 25000;
const CLIENT_TTL_MS = 45000;
const CLEANUP_INTERVAL_MS = 10000;
const ADMIN_CONTEXT = "pvt-area-admin-lock";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon"
};

const rooms = new Map();

function ensureDataStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SESSIONS_FILE)) {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify({ rooms: {} }, null, 2));
  }
}

function loadStore() {
  ensureDataStore();

  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
  } catch (error) {
    return { rooms: {} };
  }
}

const sessionStore = loadStore();

function saveStore() {
  ensureDataStore();
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessionStore, null, 2));
}

function getSessionRecord(roomId) {
  return sessionStore.rooms[roomId] || null;
}

function setSessionRecord(record) {
  sessionStore.rooms[record.roomId] = record;
  saveStore();
}

function deriveAdminKey(password, saltBase64) {
  return scryptSync(password, Buffer.from(saltBase64, "base64"), 32);
}

function buildAdminVerifier(keyBuffer) {
  return createHash("sha256")
    .update(Buffer.concat([keyBuffer, Buffer.from(ADMIN_CONTEXT)]))
    .digest("base64");
}

function createAdminLock(password) {
  const salt = randomBytes(16).toString("base64");
  const key = deriveAdminKey(password, salt);

  return {
    salt,
    verifier: buildAdminVerifier(key),
    key
  };
}

function verifyAdminPassword(record, password) {
  if (!record?.admin || !password) {
    return null;
  }

  const key = deriveAdminKey(password, record.admin.salt);
  const verifier = buildAdminVerifier(key);
  const actual = Buffer.from(verifier);
  const expected = Buffer.from(record.admin.verifier);

  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return null;
  }

  return key;
}

function encryptForStorage(payload, keyBuffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBuffer, iv);
  const plain = Buffer.from(JSON.stringify(payload), "utf8");
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    cipherText: encrypted.toString("base64")
  };
}

function decryptFromStorage(envelope, keyBuffer) {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    keyBuffer,
    Buffer.from(envelope.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(envelope.cipherText, "base64")),
    decipher.final()
  ]);

  return JSON.parse(decrypted.toString("utf8"));
}

function getRoom(roomId, storageKey) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      roomId,
      clients: new Map(),
      liveHistory: [],
      storageKey: storageKey || null
    });
  }

  const room = rooms.get(roomId);
  if (!room.storageKey && storageKey) {
    room.storageKey = storageKey;
  }

  return room;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 2e6) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function touchClient(client) {
  client.lastSeenAt = Date.now();
}

function clearPendingPoll(client) {
  if (client.pendingTimer) {
    clearTimeout(client.pendingTimer);
    client.pendingTimer = null;
  }

  client.pendingRes = null;
}

function flushClientQueue(client) {
  if (!client.pendingRes || client.eventQueue.length === 0) {
    return;
  }

  const res = client.pendingRes;
  const events = client.eventQueue.splice(0);
  clearPendingPoll(client);
  sendJson(res, 200, { events });
}

function queueEvent(client, event) {
  client.eventQueue.push(event);
  flushClientQueue(client);
}

function broadcast(room, event, excludeClientId) {
  for (const [clientId, client] of room.clients.entries()) {
    if (excludeClientId && excludeClientId === clientId) {
      continue;
    }

    queueEvent(client, event);
  }
}

function persistArchivedEvent(roomId, room, event) {
  const record = getSessionRecord(roomId);
  if (!record || !room.storageKey) {
    return;
  }

  if (!Array.isArray(record.archive)) {
    record.archive = [];
  }

  record.archive.push(encryptForStorage(event, room.storageKey));
  record.updatedAt = Date.now();
  setSessionRecord(record);
}

function decryptArchive(record, keyBuffer) {
  if (!record?.archive?.length || !keyBuffer) {
    return [];
  }

  return record.archive.map((item) => decryptFromStorage(item, keyBuffer));
}

function removeClient(roomId, clientId, notify) {
  const room = rooms.get(roomId);
  const client = room?.clients.get(clientId);

  if (!room || !client) {
    return;
  }

  clearPendingPoll(client);
  room.clients.delete(clientId);

  if (notify) {
    broadcast(room, {
      type: "presence",
      action: "leave",
      clientId,
      name: client.name
    });
  }

  if (room.clients.size === 0) {
    rooms.delete(roomId);
  }
}

function pruneStaleClients() {
  const now = Date.now();

  for (const [roomId, room] of rooms.entries()) {
    for (const [clientId, client] of room.clients.entries()) {
      if (now - client.lastSeenAt > CLIENT_TTL_MS) {
        removeClient(roomId, clientId, true);
      }
    }
  }
}

function serveStatic(req, res) {
  const urlPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const unsafePath = path.normalize(path.join(PUBLIC_DIR, urlPath));

  if (!unsafePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  fs.readFile(unsafePath, (error, file) => {
    if (error) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    const ext = path.extname(unsafePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(file);
  });
}

setInterval(pruneStaleClients, CLEANUP_INTERVAL_MS).unref();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/healthz") {
      sendJson(res, 200, {
        ok: true,
        service: "pvt-area",
        uptime: Math.round(process.uptime())
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/join") {
      const rawBody = await collectBody(req);
      const body = JSON.parse(rawBody || "{}");
      const roomId = String(body.roomId || "").trim().toLowerCase();
      const name = String(body.name || "").trim().slice(0, 32);
      const adminPassword = String(body.adminPassword || "");

      if (!roomId || !name) {
        sendJson(res, 400, { error: "Room number and name are required." });
        return;
      }

      let record = getSessionRecord(roomId);
      let adminKey = null;
      let isAdmin = false;

      if (!record) {
        if (!adminPassword) {
          sendJson(res, 400, {
            error: "Admin password is required to create a new room session."
          });
          return;
        }

        const adminLock = createAdminLock(adminPassword);
        record = {
          roomId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          endedAt: null,
          admin: {
            salt: adminLock.salt,
            verifier: adminLock.verifier
          },
          archive: []
        };
        setSessionRecord(record);
        adminKey = adminLock.key;
        isAdmin = true;
      } else if (adminPassword) {
        adminKey = verifyAdminPassword(record, adminPassword);
        isAdmin = Boolean(adminKey);
      }

      const archived = Boolean(record.endedAt);
      if (archived && !isAdmin) {
        sendJson(res, 409, {
          error: "This room session is archived. The admin password is required to reopen it."
        });
        return;
      }

      const archivedHistory = isAdmin ? decryptArchive(record, adminKey) : [];

      if (archived) {
        record.endedAt = null;
        record.updatedAt = Date.now();
        setSessionRecord(record);
      }

      const room = getRoom(roomId, adminKey);
      const clientId = randomUUID();
      room.clients.set(clientId, {
        id: clientId,
        name,
        eventQueue: [],
        pendingRes: null,
        pendingTimer: null,
        lastSeenAt: Date.now(),
        isAdmin
      });

      const participants = Array.from(room.clients.values())
        .filter((client) => client.id !== clientId)
        .map((client) => ({ id: client.id, name: client.name }));

      sendJson(res, 200, {
        clientId,
        participants,
        history: room.liveHistory,
        archivedHistory,
        isAdmin,
        roomState: archived ? "reopened" : "live"
      });

      broadcast(room, {
        type: "presence",
        action: "join",
        clientId,
        name
      }, clientId);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/poll") {
      const roomId = String(url.searchParams.get("roomId") || "").trim().toLowerCase();
      const clientId = String(url.searchParams.get("clientId") || "").trim();

      if (!roomId || !clientId) {
        sendJson(res, 400, { error: "Missing roomId or clientId." });
        return;
      }

      const room = rooms.get(roomId);
      const client = room?.clients.get(clientId);

      if (!room || !client) {
        sendJson(res, 404, { error: "Client not found." });
        return;
      }

      touchClient(client);

      if (client.eventQueue.length > 0) {
        sendJson(res, 200, { events: client.eventQueue.splice(0) });
        return;
      }

      clearPendingPoll(client);
      client.pendingRes = res;
      client.pendingTimer = setTimeout(() => {
        if (client.pendingRes === res) {
          clearPendingPoll(client);
          sendJson(res, 200, { events: [] });
        }
      }, POLL_TIMEOUT_MS);

      req.on("close", () => {
        if (client.pendingRes === res) {
          clearPendingPoll(client);
        }
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/leave") {
      const rawBody = await collectBody(req);
      const body = JSON.parse(rawBody || "{}");
      const roomId = String(body.roomId || "").trim().toLowerCase();
      const clientId = String(body.clientId || "").trim();

      if (!roomId || !clientId) {
        sendJson(res, 400, { error: "Missing roomId or clientId." });
        return;
      }

      removeClient(roomId, clientId, true);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/end-session") {
      const rawBody = await collectBody(req);
      const body = JSON.parse(rawBody || "{}");
      const roomId = String(body.roomId || "").trim().toLowerCase();
      const clientId = String(body.clientId || "").trim();
      const adminPassword = String(body.adminPassword || "");

      if (!roomId || !clientId || !adminPassword) {
        sendJson(res, 400, { error: "Room, client, and admin password are required." });
        return;
      }

      const room = rooms.get(roomId);
      const sender = room?.clients.get(clientId);
      const record = getSessionRecord(roomId);

      if (!room || !sender || !record) {
        sendJson(res, 404, { error: "Active room not found." });
        return;
      }

      const adminKey = verifyAdminPassword(record, adminPassword);
      if (!adminKey) {
        sendJson(res, 403, { error: "Admin password is invalid." });
        return;
      }

      record.endedAt = Date.now();
      record.updatedAt = Date.now();
      setSessionRecord(record);

      const closingEvent = {
        type: "session",
        action: "ended",
        roomId,
        endedBy: sender.name,
        serverTimestamp: Date.now()
      };

      broadcast(room, closingEvent);
      setTimeout(() => {
        rooms.delete(roomId);
      }, 1500).unref();

      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/event") {
      const rawBody = await collectBody(req);
      const event = JSON.parse(rawBody || "{}");
      const roomId = String(event.roomId || "").trim().toLowerCase();
      const clientId = String(event.clientId || "").trim();

      if (!roomId || !clientId) {
        sendJson(res, 400, { error: "Missing roomId or clientId." });
        return;
      }

      const room = rooms.get(roomId);
      const sender = room?.clients.get(clientId);

      if (!room || !sender) {
        sendJson(res, 404, { error: "Unknown sender." });
        return;
      }

      touchClient(sender);

      const outbound = {
        ...event,
        serverTimestamp: Date.now()
      };

      if (event.type === "chat") {
        room.liveHistory.push(outbound);
        if (room.liveHistory.length > 200) {
          room.liveHistory.shift();
        }
        persistArchivedEvent(roomId, room, outbound);
      }

      if (event.targetClientId) {
        const target = room.clients.get(event.targetClientId);
        if (target) {
          queueEvent(target, outbound);
        }
      } else {
        broadcast(room, outbound, clientId);
      }

      sendJson(res, 200, { ok: true });
      return;
    }

    serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Server error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`PVT Area running at http://localhost:${PORT}`);
});
