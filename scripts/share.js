const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { spawn } = require("child_process");

const ROOT_DIR = path.join(__dirname, "..");
const PORT = String(process.env.PORT || "3000");
const HEALTH_URL = `http://127.0.0.1:${PORT}/healthz`;
const TOOLS_DIR = path.join(ROOT_DIR, ".tools");
const CLOUDFLARED_BIN = path.join(TOOLS_DIR, "cloudflared");
const CLOUDFLARED_ARCHIVE = path.join(TOOLS_DIR, "cloudflared.tgz");

let serverProcess = null;
let tunnelProcess = null;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Unexpected status ${res.statusCode}`));
          return;
        }

        resolve(JSON.parse(data));
      });
    }).on("error", reject);
  });
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await requestJson(HEALTH_URL);
      return;
    } catch (error) {
      await delay(500);
    }
  }

  throw new Error("Timed out waiting for the local server to become healthy.");
}

function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination);

    function fetchUrl(currentUrl) {
      https.get(currentUrl, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          const nextUrl = new URL(res.headers.location, currentUrl).toString();
          res.resume();
          fetchUrl(nextUrl);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`Download failed with status ${res.statusCode}`));
          return;
        }

        res.pipe(file);
      }).on("error", reject);
    }

    file.on("finish", () => {
      file.close(resolve);
    });

    file.on("error", reject);
    fetchUrl(url);
  });
}

function runChild(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);

    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

async function ensureCloudflared() {
  if (fs.existsSync(CLOUDFLARED_BIN)) {
    return CLOUDFLARED_BIN;
  }

  if (process.platform !== "darwin") {
    throw new Error("scripts/share.js currently auto-downloads cloudflared only on macOS.");
  }

  const archMap = {
    arm64: "arm64",
    x64: "amd64"
  };
  const arch = archMap[process.arch];

  if (!arch) {
    throw new Error(`Unsupported macOS architecture: ${process.arch}`);
  }

  fs.mkdirSync(TOOLS_DIR, { recursive: true });

  const downloadUrl = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${arch}.tgz`;
  console.log("Downloading cloudflared for local sharing...");
  await downloadFile(downloadUrl, CLOUDFLARED_ARCHIVE);
  await runChild("tar", ["-xzf", CLOUDFLARED_ARCHIVE, "-C", TOOLS_DIR], {
    cwd: ROOT_DIR,
    stdio: "ignore"
  });
  fs.rmSync(CLOUDFLARED_ARCHIVE, { force: true });
  fs.chmodSync(CLOUDFLARED_BIN, 0o755);

  return CLOUDFLARED_BIN;
}

async function ensureServer() {
  try {
    await requestJson(HEALTH_URL);
    console.log(`Using existing local server at http://127.0.0.1:${PORT}`);
    return;
  } catch (error) {
    console.log("Starting local PVT Area server...");
  }

  serverProcess = spawn(process.execPath, ["server.js"], {
    cwd: ROOT_DIR,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  serverProcess.stdout.on("data", (chunk) => {
    process.stdout.write(`[server] ${chunk}`);
  });

  serverProcess.stderr.on("data", (chunk) => {
    process.stderr.write(`[server] ${chunk}`);
  });

  await waitForHealth();
}

function watchForQuickTunnelUrl(child) {
  return new Promise((resolve, reject) => {
    const pattern = /https:\/\/[a-z0-9.-]+trycloudflare\.com/i;

    function handleChunk(chunk) {
      const text = chunk.toString();
      process.stdout.write(`[tunnel] ${text}`);
      const match = text.match(pattern);
      if (match) {
        resolve(match[0]);
      }
    }

    child.stdout.on("data", handleChunk);
    child.stderr.on("data", handleChunk);
    child.once("error", reject);
    child.once("exit", (code) => {
      reject(new Error(`cloudflared exited before a share link was created (code ${code}).`));
    });
  });
}

function cleanupAndExit(code) {
  if (tunnelProcess) {
    tunnelProcess.kill("SIGTERM");
  }

  if (serverProcess) {
    serverProcess.kill("SIGTERM");
  }

  process.exit(code);
}

async function main() {
  process.on("SIGINT", () => cleanupAndExit(0));
  process.on("SIGTERM", () => cleanupAndExit(0));

  await ensureServer();
  const cloudflaredPath = await ensureCloudflared();

  console.log("Creating a public host link...");
  tunnelProcess = spawn(cloudflaredPath, ["tunnel", "--url", `http://127.0.0.1:${PORT}`], {
    cwd: ROOT_DIR,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  const publicUrl = await watchForQuickTunnelUrl(tunnelProcess);

  console.log("");
  console.log("PVT Area is now publicly reachable.");
  console.log(`Open this URL on your laptop: ${publicUrl}`);
  console.log("Join a room, then use the Copy room link button to send the room-specific invite.");
  console.log("Keep this terminal open while you host.");
}

main().catch((error) => {
  console.error(error.message);
  cleanupAndExit(1);
});
