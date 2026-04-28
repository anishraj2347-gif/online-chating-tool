const dom = {
  joinForm: document.querySelector("#join-form"),
  chatForm: document.querySelector("#chat-form"),
  nameInput: document.querySelector("#name"),
  roomInput: document.querySelector("#room-id"),
  secretInput: document.querySelector("#room-secret"),
  adminPasswordInput: document.querySelector("#admin-password"),
  messageInput: document.querySelector("#message-input"),
  sendBtn: document.querySelector("#send-btn"),
  leaveBtn: document.querySelector("#leave-btn"),
  endSessionBtn: document.querySelector("#end-session-btn"),
  messages: document.querySelector("#messages"),
  roomLabel: document.querySelector("#room-label"),
  sessionMode: document.querySelector("#session-mode"),
  archiveState: document.querySelector("#archive-state"),
  adminBadge: document.querySelector("#admin-badge"),
  presenceCount: document.querySelector("#presence-count"),
  inviteLink: document.querySelector("#invite-link"),
  copyLinkBtn: document.querySelector("#copy-link-btn"),
  typingIndicator: document.querySelector("#typing-indicator"),
  sessionBannerText: document.querySelector("#session-banner-text"),
  sessionLinkState: document.querySelector("#session-link-state"),
  historyState: document.querySelector("#history-state"),
  cameraBtn: document.querySelector("#camera-btn"),
  screenBtn: document.querySelector("#screen-btn"),
  muteBtn: document.querySelector("#mute-btn"),
  localVideo: document.querySelector("#local-video"),
  selfStreamLabel: document.querySelector("#self-stream-label"),
  videoGrid: document.querySelector("#video-grid"),
  messageTemplate: document.querySelector("#message-template"),
  remoteVideoTemplate: document.querySelector("#remote-video-template")
};

const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

const state = {
  roomId: "",
  clientId: "",
  name: "",
  secret: "",
  adminPassword: "",
  keyMaterial: null,
  peers: new Map(),
  remoteCards: new Map(),
  participants: new Map(),
  localStream: null,
  screenStream: null,
  typingTimeout: null,
  mute: false,
  pollActive: false,
  pollController: null,
  isAdmin: false
};

async function deriveChatKey(secret, roomId) {
  const encoder = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode(`cipherchat:${roomId}`),
      iterations: 120000,
      hash: "SHA-256"
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function toBase64(bytes) {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary);
}

function fromBase64(base64) {
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function encryptPayload(payload) {
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = encoder.encode(JSON.stringify(payload));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    state.keyMaterial,
    encoded
  );

  return {
    iv: toBase64(iv),
    cipherText: toBase64(new Uint8Array(cipher))
  };
}

async function decryptPayload(envelope) {
  const decoder = new TextDecoder();
  const plainBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(envelope.iv) },
    state.keyMaterial,
    fromBase64(envelope.cipherText)
  );

  return JSON.parse(decoder.decode(plainBuffer));
}

function setConnectedUi(connected) {
  dom.messageInput.disabled = !connected;
  dom.sendBtn.disabled = !connected;
  dom.leaveBtn.disabled = !connected;
  dom.copyLinkBtn.disabled = !connected;
  dom.cameraBtn.disabled = !connected;
  dom.screenBtn.disabled = !connected;
  dom.muteBtn.disabled = !connected;
  dom.endSessionBtn.disabled = !connected || !state.isAdmin;
}

function renderPresence() {
  dom.presenceCount.textContent = state.clientId ? `${state.participants.size + 1} online` : "0 online";
}

function resetMessages() {
  dom.messages.innerHTML = `
    <div class="empty-state">
      <strong>No room messages yet</strong>
      <p>When the admin reopens an archived session, older encrypted messages will appear here after the correct room secret decrypts them.</p>
    </div>
  `;
}

function clearEmptyState() {
  const empty = dom.messages.querySelector(".empty-state");
  if (empty) {
    empty.remove();
  }
}

function appendMessage(message, isSelf, kind = "user") {
  clearEmptyState();
  const node = dom.messageTemplate.content.firstElementChild.cloneNode(true);
  node.classList.toggle("self", isSelf);
  if (kind === "system") {
    node.classList.add("system");
  }
  node.querySelector(".message-name").textContent = message.name;
  node.querySelector(".message-time").textContent = new Date(message.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
  node.querySelector(".message-text").textContent = message.text;
  dom.messages.appendChild(node);
  dom.messages.scrollTop = dom.messages.scrollHeight;
}

function appendSystemMessage(text) {
  appendMessage(
    {
      name: "System",
      text,
      timestamp: Date.now()
    },
    false,
    "system"
  );
}

function setTypingLabel(label) {
  dom.typingIndicator.textContent = label;
}

function updateSessionUi(mode) {
  dom.roomLabel.textContent = state.clientId ? `#${state.roomId}` : "Not connected";
  dom.sessionMode.textContent = mode;
  dom.archiveState.textContent = mode === "Reopened archive" ? "Restored" : "Live";
  dom.adminBadge.textContent = state.isAdmin ? "Admin" : "Guest";
  dom.sessionBannerText.textContent = state.clientId
    ? `Room #${state.roomId} is active. Two or more devices can join with the same room number and secret phrase.`
    : "Join a room to start the multi-device session.";
}

function buildInviteLink() {
  if (!state.roomId) {
    return "";
  }

  const url = new URL(window.location.href);
  url.searchParams.set("room", state.roomId);
  url.hash = "";
  return url.toString();
}

function updateInviteLink() {
  const inviteUrl = state.clientId ? buildInviteLink() : "";

  if (!inviteUrl) {
    dom.inviteLink.textContent = "Join a room to generate a room-specific invite link.";
    dom.sessionLinkState.textContent = "No";
    dom.copyLinkBtn.disabled = true;
    return;
  }

  dom.inviteLink.textContent = inviteUrl;
  dom.sessionLinkState.textContent = "Yes";
  dom.copyLinkBtn.disabled = false;
  window.history.replaceState({}, "", inviteUrl);
}

async function copyInviteLink() {
  const inviteUrl = buildInviteLink();
  if (!inviteUrl) {
    return;
  }

  await navigator.clipboard.writeText(inviteUrl);
  const previous = dom.copyLinkBtn.textContent;
  dom.copyLinkBtn.textContent = "Copied";
  setTimeout(() => {
    dom.copyLinkBtn.textContent = previous;
  }, 1400);
}

async function sendEvent(event) {
  await fetch("/api/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...event,
      roomId: state.roomId,
      clientId: state.clientId
    })
  });
}

function ensureRemoteCard(peerId, name) {
  if (state.remoteCards.has(peerId)) {
    const existing = state.remoteCards.get(peerId);
    existing.querySelector(".peer-name").textContent = name || "Peer";
    return existing;
  }

  const node = dom.remoteVideoTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.peerId = peerId;
  node.querySelector(".peer-name").textContent = name || "Peer";
  dom.videoGrid.appendChild(node);
  state.remoteCards.set(peerId, node);
  return node;
}

function removeRemoteCard(peerId) {
  const card = state.remoteCards.get(peerId);
  if (card) {
    card.remove();
    state.remoteCards.delete(peerId);
  }
}

function updateLocalStreamLabel() {
  if (state.screenStream) {
    dom.selfStreamLabel.textContent = "Screen sharing";
  } else if (state.localStream) {
    dom.selfStreamLabel.textContent = state.mute ? "Mic muted" : "Camera live";
  } else {
    dom.selfStreamLabel.textContent = "No media";
  }

  dom.cameraBtn.textContent = state.localStream ? "Camera Ready" : "Start Camera";
  dom.screenBtn.textContent = state.screenStream ? "Screen Live" : "Share Screen";
  dom.muteBtn.textContent = state.mute ? "Unmute Mic" : "Mute Mic";
}

function stopTrackGroup(stream) {
  if (!stream) {
    return;
  }

  for (const track of stream.getTracks()) {
    track.stop();
  }
}

function attachTracks(peerConnection) {
  const tracks = [];

  if (state.localStream) {
    tracks.push(...state.localStream.getTracks());
  }

  if (state.screenStream) {
    tracks.push(...state.screenStream.getVideoTracks());
  }

  for (const track of tracks) {
    const alreadyAdded = peerConnection.getSenders().some((sender) => sender.track?.id === track.id);
    if (!alreadyAdded) {
      peerConnection.addTrack(track, state.screenStream || state.localStream);
    }
  }
}

function resetTyping(peerName) {
  setTypingLabel(`${peerName} is typing...`);
  clearTimeout(state.typingTimeout);
  state.typingTimeout = setTimeout(() => {
    setTypingLabel("Nobody is typing");
  }, 1800);
}

async function createPeerConnection(peerId, peerName, isOfferer) {
  if (state.peers.has(peerId)) {
    return state.peers.get(peerId);
  }

  const peerConnection = new RTCPeerConnection(rtcConfig);
  const card = ensureRemoteCard(peerId, peerName);
  const video = card.querySelector("video");
  const remoteStream = new MediaStream();
  const peerState = card.querySelector(".peer-state");

  video.srcObject = remoteStream;
  attachTracks(peerConnection);

  peerConnection.ontrack = (event) => {
    for (const track of event.streams[0].getTracks()) {
      if (!remoteStream.getTracks().some((existing) => existing.id === track.id)) {
        remoteStream.addTrack(track);
      }
    }
    peerState.textContent = "Live";
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      void sendEvent({
        type: "signal",
        signalType: "ice",
        targetClientId: peerId,
        candidate: event.candidate
      });
    }
  };

  peerConnection.onconnectionstatechange = () => {
    peerState.textContent = peerConnection.connectionState;
    if (["failed", "closed", "disconnected"].includes(peerConnection.connectionState)) {
      removeRemoteCard(peerId);
      state.peers.delete(peerId);
    }
  };

  peerConnection.onnegotiationneeded = async () => {
    if (peerConnection.signalingState !== "stable") {
      return;
    }

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    await sendEvent({
      type: "signal",
      signalType: "offer",
      targetClientId: peerId,
      description: offer
    });
  };

  state.peers.set(peerId, peerConnection);

  if (isOfferer) {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    await sendEvent({
      type: "signal",
      signalType: "offer",
      targetClientId: peerId,
      description: offer
    });
  }

  return peerConnection;
}

async function handleSignal(event) {
  const peerName = state.participants.get(event.clientId)?.name || "Peer";
  const peerConnection = await createPeerConnection(event.clientId, peerName, false);

  if (event.signalType === "offer") {
    await peerConnection.setRemoteDescription(event.description);
    attachTracks(peerConnection);
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    await sendEvent({
      type: "signal",
      signalType: "answer",
      targetClientId: event.clientId,
      description: answer
    });
    return;
  }

  if (event.signalType === "answer") {
    await peerConnection.setRemoteDescription(event.description);
    return;
  }

  if (event.signalType === "ice" && event.candidate) {
    await peerConnection.addIceCandidate(event.candidate);
  }
}

async function startCamera() {
  if (!state.localStream) {
    state.localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });
    dom.localVideo.srcObject = state.localStream;
  }

  for (const peerConnection of state.peers.values()) {
    attachTracks(peerConnection);
  }

  if (!state.screenStream) {
    dom.localVideo.srcObject = state.localStream;
  }

  updateLocalStreamLabel();
}

async function startScreenShare() {
  state.screenStream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: true
  });

  const [screenTrack] = state.screenStream.getVideoTracks();
  screenTrack.onended = () => {
    state.screenStream = null;
    dom.localVideo.srcObject = state.localStream;
    for (const peerConnection of state.peers.values()) {
      const cameraTrack = state.localStream?.getVideoTracks()[0];
      const sender = peerConnection.getSenders().find((item) => item.track?.kind === "video");
      if (sender && cameraTrack) {
        void sender.replaceTrack(cameraTrack);
      }
    }
    updateLocalStreamLabel();
  };

  for (const peerConnection of state.peers.values()) {
    const sender = peerConnection.getSenders().find((item) => item.track?.kind === "video");
    if (sender && screenTrack) {
      await sender.replaceTrack(screenTrack);
    } else {
      attachTracks(peerConnection);
    }
  }

  dom.localVideo.srcObject = state.screenStream;
  updateLocalStreamLabel();
}

function toggleMute() {
  if (!state.localStream) {
    return;
  }

  state.mute = !state.mute;
  for (const track of state.localStream.getAudioTracks()) {
    track.enabled = !state.mute;
  }
  updateLocalStreamLabel();
}

function handlePresence(event) {
  if (event.action === "join") {
    state.participants.set(event.clientId, { name: event.name });
    appendSystemMessage(`${event.name} joined the room.`);
  }

  if (event.action === "leave") {
    state.participants.delete(event.clientId);
    const peerConnection = state.peers.get(event.clientId);
    if (peerConnection) {
      peerConnection.close();
      state.peers.delete(event.clientId);
    }
    removeRemoteCard(event.clientId);
    appendSystemMessage(`${event.name} left the room.`);
  }

  renderPresence();
}

async function processEvent(event) {
  if (event.type === "presence") {
    handlePresence(event);
    return;
  }

  if (event.type === "typing") {
    const peer = state.participants.get(event.clientId);
    if (peer) {
      resetTyping(peer.name);
    }
    return;
  }

  if (event.type === "signal") {
    await handleSignal(event);
    return;
  }

  if (event.type === "session" && event.action === "ended") {
    appendSystemMessage(`Session ended by ${event.endedBy}.`);
    await leaveRoom(false, true);
    updateSessionUi("Archived");
    dom.archiveState.textContent = "Archived";
    dom.sessionBannerText.textContent = "This room session was ended. The admin can reopen it later with the admin password.";
    return;
  }

  if (event.type === "chat") {
    try {
      const payload = await decryptPayload(event.envelope);
      appendMessage(payload, event.clientId === state.clientId);
    } catch (error) {
      appendSystemMessage("A message could not be decrypted. Make sure every device uses the same room secret.");
    }
  }
}

async function pollLoop() {
  state.pollActive = true;

  while (state.pollActive && state.clientId) {
    state.pollController = new AbortController();

    try {
      const pollUrl = `/api/poll?roomId=${encodeURIComponent(state.roomId)}&clientId=${encodeURIComponent(state.clientId)}`;
      const response = await fetch(pollUrl, {
        cache: "no-store",
        signal: state.pollController.signal
      });

      if (!response.ok) {
        throw new Error("Polling failed");
      }

      const result = await response.json();
      for (const event of result.events || []) {
        await processEvent(event);
      }
    } catch (error) {
      if (!state.pollActive || error.name === "AbortError") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } finally {
      state.pollController = null;
    }
  }
}

function stopPolling() {
  state.pollActive = false;
  if (state.pollController) {
    state.pollController.abort();
    state.pollController = null;
  }
}

async function notifyLeave() {
  if (!state.clientId || !state.roomId) {
    return;
  }

  await fetch("/api/leave", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      roomId: state.roomId,
      clientId: state.clientId
    }),
    keepalive: true
  });
}

function resetRoomState() {
  stopPolling();

  for (const peerConnection of state.peers.values()) {
    peerConnection.close();
  }
  state.peers.clear();

  for (const peerId of Array.from(state.remoteCards.keys())) {
    removeRemoteCard(peerId);
  }

  stopTrackGroup(state.localStream);
  stopTrackGroup(state.screenStream);
  state.localStream = null;
  state.screenStream = null;
  dom.localVideo.srcObject = null;

  state.participants.clear();
  state.roomId = "";
  state.clientId = "";
  state.secret = "";
  state.keyMaterial = null;
  state.isAdmin = false;
  state.mute = false;

  resetMessages();
  renderPresence();
  setTypingLabel("Nobody is typing");
  updateInviteLink();
  updateSessionUi("Waiting");
  dom.historyState.textContent = "Live only";
  updateLocalStreamLabel();
  setConnectedUi(false);
}

async function leaveRoom(notifyServer = true, silent = false) {
  if (notifyServer) {
    await notifyLeave().catch(() => {});
  }

  resetRoomState();

  if (!silent) {
    appendSystemMessage("You left the room.");
  }
}

async function endSession() {
  if (!state.clientId || !state.isAdmin) {
    return;
  }

  if (!state.adminPassword) {
    alert("The admin password is required to end this archived session cleanly.");
    return;
  }

  const response = await fetch("/api/end-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      roomId: state.roomId,
      clientId: state.clientId,
      adminPassword: state.adminPassword
    })
  });

  const result = await response.json();
  if (!response.ok) {
    alert(result.error || "Could not end the session.");
    return;
  }
}

async function joinRoom(event) {
  event.preventDefault();

  const nextName = dom.nameInput.value.trim();
  const nextRoomId = dom.roomInput.value.trim().toLowerCase();
  const nextSecret = dom.secretInput.value;
  const nextAdminPassword = dom.adminPasswordInput.value;

  if (!nextName || !nextRoomId || !nextSecret) {
    return;
  }

  if (state.clientId) {
    await leaveRoom(true, true);
  }

  state.name = nextName;
  state.roomId = nextRoomId;
  state.secret = nextSecret;
  state.adminPassword = nextAdminPassword;
  state.keyMaterial = await deriveChatKey(state.secret, state.roomId);

  const response = await fetch("/api/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      roomId: state.roomId,
      name: state.name,
      adminPassword: state.adminPassword
    })
  });

  const result = await response.json();

  if (!response.ok) {
    resetRoomState();
    alert(result.error || "Could not join the room.");
    return;
  }

  state.clientId = result.clientId;
  state.isAdmin = result.isAdmin;
  state.participants.clear();

  for (const participant of result.participants) {
    state.participants.set(participant.id, { name: participant.name });
  }

  setConnectedUi(true);
  updateInviteLink();
  updateSessionUi(result.roomState === "reopened" ? "Reopened archive" : "Live");
  dom.historyState.textContent = result.archivedHistory?.length ? "Archive restored" : "Live only";

  if (result.roomState === "reopened") {
    appendSystemMessage("Archived session reopened by the admin.");
  }

  for (const item of result.archivedHistory || []) {
    try {
      const payload = await decryptPayload(item.envelope);
      appendMessage(payload, false);
    } catch (error) {
      appendSystemMessage("Some archived messages could not be decrypted with this room secret.");
      break;
    }
  }

  for (const item of result.history || []) {
    try {
      const payload = await decryptPayload(item.envelope);
      appendMessage(payload, item.clientId === state.clientId);
    } catch (error) {
      appendSystemMessage("A live room message could not be decrypted with this room secret.");
    }
  }

  for (const [peerId, participant] of state.participants.entries()) {
    await createPeerConnection(peerId, participant.name, true);
  }

  renderPresence();
  void pollLoop();
}

async function sendMessage(event) {
  event.preventDefault();
  const text = dom.messageInput.value.trim();
  if (!text) {
    return;
  }

  const payload = {
    name: state.name,
    text,
    timestamp: Date.now()
  };
  const envelope = await encryptPayload(payload);

  appendMessage(payload, true);
  dom.messageInput.value = "";
  setTypingLabel("Nobody is typing");

  await sendEvent({
    type: "chat",
    envelope
  });
}

let typingDebounce;
function announceTyping() {
  clearTimeout(typingDebounce);
  typingDebounce = setTimeout(() => {
    if (state.clientId) {
      void sendEvent({ type: "typing" });
    }
  }, 120);
}

function applyRoomPrefill() {
  const params = new URLSearchParams(window.location.search);
  const room = params.get("room");
  if (room && !dom.roomInput.value) {
    dom.roomInput.value = room.toLowerCase();
  }
}

window.addEventListener("pagehide", () => {
  void notifyLeave().catch(() => {});
});

applyRoomPrefill();
resetRoomState();

dom.joinForm.addEventListener("submit", joinRoom);
dom.chatForm.addEventListener("submit", sendMessage);
dom.messageInput.addEventListener("input", announceTyping);
dom.leaveBtn.addEventListener("click", () => {
  void leaveRoom(true, true);
});
dom.endSessionBtn.addEventListener("click", () => {
  void endSession();
});
dom.cameraBtn.addEventListener("click", () => {
  void startCamera();
});
dom.screenBtn.addEventListener("click", () => {
  void startScreenShare();
});
dom.muteBtn.addEventListener("click", toggleMute);
dom.copyLinkBtn.addEventListener("click", () => {
  void copyInviteLink();
});
