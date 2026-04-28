const dom = {
  joinForm: document.querySelector("#join-form"),
  joinBtn: document.querySelector("#join-btn"),
  chatForm: document.querySelector("#chat-form"),
  nameInput: document.querySelector("#name"),
  roomInput: document.querySelector("#room-id"),
  secretInput: document.querySelector("#room-secret"),
  messageInput: document.querySelector("#message-input"),
  sendBtn: document.querySelector("#send-btn"),
  messages: document.querySelector("#messages"),
  emptyState: document.querySelector("#empty-state"),
  roomLabel: document.querySelector("#room-label"),
  roomBadge: document.querySelector("#room-badge"),
  presenceCount: document.querySelector("#presence-count"),
  participantList: document.querySelector("#participant-list"),
  safetyCode: document.querySelector("#safety-code"),
  messageCount: document.querySelector("#message-count"),
  typingIndicator: document.querySelector("#typing-indicator"),
  connectionState: document.querySelector("#connection-state"),
  cameraBtn: document.querySelector("#camera-btn"),
  screenBtn: document.querySelector("#screen-btn"),
  muteBtn: document.querySelector("#mute-btn"),
  localVideo: document.querySelector("#local-video"),
  selfStreamLabel: document.querySelector("#self-stream-label"),
  videoGrid: document.querySelector("#video-grid"),
  localCard: document.querySelector(".video-card.self"),
  messageTemplate: document.querySelector("#message-template"),
  remoteVideoTemplate: document.querySelector("#remote-video-template")
};

const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" }
  ]
};

const state = {
  roomId: "",
  clientId: "",
  name: "",
  keyMaterial: null,
  eventSource: null,
  peers: new Map(),
  remoteCards: new Map(),
  participants: new Map(),
  localStream: null,
  screenStream: null,
  typingTimeout: null,
  mute: false,
  messageCount: 0
};

function initials(name) {
  return (name || "?").trim().charAt(0).toUpperCase() || "?";
}

function formatMessageCount(count) {
  return `${count} ${count === 1 ? "message" : "messages"}`;
}

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

async function buildSafetyCode(secret, roomId) {
  const encoder = new TextEncoder();
  const payload = encoder.encode(`cipherchat:verify:${roomId}:${secret}`);
  const digest = await crypto.subtle.digest("SHA-256", payload);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 16).match(/.{1,4}/g).join(" ");
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

function updateMessageCount() {
  dom.messageCount.textContent = formatMessageCount(state.messageCount);
  dom.emptyState.hidden = state.messageCount > 0;
}

function setTypingLabel(label) {
  dom.typingIndicator.textContent = label;
}

function createParticipantItem(name, detail, isSelf) {
  const item = document.createElement("li");
  item.className = `participant${isSelf ? " self" : ""}`;

  const avatar = document.createElement("span");
  avatar.className = "participant-avatar";
  avatar.textContent = initials(name);

  const copy = document.createElement("div");
  copy.className = "participant-copy";

  const title = document.createElement("strong");
  title.textContent = name;

  const subtitle = document.createElement("span");
  subtitle.textContent = detail;

  copy.append(title, subtitle);
  item.append(avatar, copy);
  return item;
}

function renderPresence() {
  const connected = Boolean(state.clientId);

  if (!connected) {
    dom.presenceCount.textContent = "0 online";
    dom.participantList.innerHTML = "";
    dom.participantList.appendChild(createParticipantItem("You", "Join a room to see live peers.", false));
    dom.participantList.firstElementChild.classList.add("placeholder");
    return;
  }

  dom.presenceCount.textContent = `${state.participants.size + 1} online`;
  dom.participantList.innerHTML = "";
  dom.participantList.appendChild(createParticipantItem(`${state.name} (You)`, "This device is active in the room.", true));

  const peers = Array.from(state.participants.entries()).sort((a, b) => a[1].name.localeCompare(b[1].name));
  for (const [, participant] of peers) {
    dom.participantList.appendChild(createParticipantItem(participant.name, "Live in this encrypted room.", false));
  }
}

function setConnectedUi(connected) {
  dom.messageInput.disabled = !connected;
  dom.sendBtn.disabled = !connected;
  dom.cameraBtn.disabled = !connected;
  dom.screenBtn.disabled = !connected;
  dom.muteBtn.disabled = !connected;

  dom.messageInput.placeholder = connected ? `Message #${state.roomId}` : "Join a room to start messaging";
  dom.joinBtn.textContent = connected ? "Switch room" : "Create or join room";
  dom.roomLabel.textContent = connected ? `#${state.roomId}` : "Not connected";
  dom.roomBadge.textContent = connected ? `Room #${state.roomId}` : "No room joined";
  dom.connectionState.textContent = connected ? "Secure room active" : "Offline";

  document.body.classList.toggle("is-connected", connected);
  renderPresence();
}

function clearMessages() {
  for (const node of dom.messages.querySelectorAll(".message")) {
    node.remove();
  }
  state.messageCount = 0;
  updateMessageCount();
}

function appendMessage(message, isSelf) {
  const node = dom.messageTemplate.content.firstElementChild.cloneNode(true);
  node.classList.toggle("self", isSelf);
  node.dataset.initial = initials(message.name);
  node.querySelector(".message-name").textContent = message.name;
  node.querySelector(".message-time").textContent = new Date(message.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
  node.querySelector(".message-text").textContent = message.text;
  dom.messages.appendChild(node);

  state.messageCount += 1;
  updateMessageCount();
  dom.messages.scrollTop = dom.messages.scrollHeight;
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

function updateLocalCardState() {
  dom.localCard.classList.toggle("has-stream", Boolean(state.localStream || state.screenStream));
}

function updateLocalStreamLabel() {
  if (state.screenStream) {
    dom.selfStreamLabel.textContent = "Sharing screen";
  } else if (state.localStream) {
    dom.selfStreamLabel.textContent = state.mute ? "Muted" : "Camera live";
  } else {
    dom.selfStreamLabel.textContent = "No media";
  }

  dom.cameraBtn.textContent = state.localStream ? "Camera ready" : "Start camera";
  dom.screenBtn.textContent = state.screenStream ? "Screen live" : "Share screen";
  dom.muteBtn.textContent = state.mute ? "Unmute" : "Mute";
  updateLocalCardState();
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
  const peerState = card.querySelector(".peer-state");
  const remoteStream = new MediaStream();

  video.srcObject = remoteStream;
  attachTracks(peerConnection);

  peerConnection.ontrack = (event) => {
    for (const track of event.streams[0].getTracks()) {
      if (!remoteStream.getTracks().some((existing) => existing.id === track.id)) {
        remoteStream.addTrack(track);
      }
    }
    card.classList.add("has-stream");
    peerState.textContent = "Live";
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      sendEvent({
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

async function restorePrimaryVideoTrack() {
  state.screenStream = null;
  dom.localVideo.srcObject = state.localStream;

  for (const peerConnection of state.peers.values()) {
    const cameraTrack = state.localStream?.getVideoTracks()[0] || null;
    const sender = peerConnection.getSenders().find((item) => item.track?.kind === "video");
    if (sender) {
      await sender.replaceTrack(cameraTrack);
    }
  }

  updateLocalStreamLabel();
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
    void restorePrimaryVideoTrack();
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
  }

  if (event.action === "leave") {
    state.participants.delete(event.clientId);
    const peerConnection = state.peers.get(event.clientId);
    if (peerConnection) {
      peerConnection.close();
      state.peers.delete(event.clientId);
    }
    removeRemoteCard(event.clientId);
  }

  renderPresence();
}

async function connectStream() {
  state.eventSource = new EventSource(`/api/stream?roomId=${encodeURIComponent(state.roomId)}&clientId=${encodeURIComponent(state.clientId)}`);

  state.eventSource.onerror = () => {
    if (state.clientId) {
      dom.connectionState.textContent = "Signal reconnecting";
    }
  };

  state.eventSource.onmessage = async (message) => {
    const event = JSON.parse(message.data);

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

    if (event.type === "chat") {
      try {
        const payload = await decryptPayload(event.envelope);
        appendMessage(payload, event.clientId === state.clientId);
      } catch (error) {
        appendMessage({
          name: "System",
          text: "Could not decrypt a message. Check that everyone is using the same secret phrase.",
          timestamp: Date.now()
        }, false);
      }
    }
  };
}

function teardownRoomState() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }

  for (const peerConnection of state.peers.values()) {
    peerConnection.close();
  }
  state.peers.clear();

  for (const peerId of Array.from(state.remoteCards.keys())) {
    removeRemoteCard(peerId);
  }

  state.participants.clear();
  state.clientId = "";
  clearMessages();
  setTypingLabel("Nobody is typing");
  setConnectedUi(false);
  renderPresence();
}

async function joinRoom(event) {
  event.preventDefault();

  const nextName = dom.nameInput.value.trim();
  const nextRoomId = dom.roomInput.value.trim().toLowerCase();
  const secret = dom.secretInput.value;

  if (!nextName || !nextRoomId || !secret) {
    return;
  }

  teardownRoomState();

  state.name = nextName;
  state.roomId = nextRoomId;
  state.keyMaterial = await deriveChatKey(secret, state.roomId);
  dom.safetyCode.textContent = await buildSafetyCode(secret, state.roomId);
  dom.roomBadge.textContent = `Room #${state.roomId}`;
  dom.connectionState.textContent = "Locking room";

  const response = await fetch("/api/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      roomId: state.roomId,
      name: state.name
    })
  });
  const result = await response.json();

  if (!response.ok) {
    alert(result.error || "Could not join room.");
    setConnectedUi(false);
    dom.safetyCode.textContent = "---- ---- ---- ----";
    return;
  }

  state.clientId = result.clientId;
  state.participants.clear();
  for (const participant of result.participants) {
    state.participants.set(participant.id, { name: participant.name });
  }

  setConnectedUi(true);
  await connectStream();

  for (const item of result.history) {
    try {
      const payload = await decryptPayload(item.envelope);
      appendMessage(payload, item.clientId === state.clientId);
    } catch (error) {
      appendMessage({
        name: "System",
        text: "A past message could not be decrypted with this secret phrase.",
        timestamp: Date.now()
      }, false);
    }
  }

  for (const [peerId, participant] of state.participants.entries()) {
    await createPeerConnection(peerId, participant.name, true);
  }
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
      sendEvent({ type: "typing" });
    }
  }, 120);
}

setConnectedUi(false);
clearMessages();
renderPresence();
updateLocalStreamLabel();

dom.joinForm.addEventListener("submit", joinRoom);
dom.chatForm.addEventListener("submit", sendMessage);
dom.messageInput.addEventListener("input", announceTyping);
dom.cameraBtn.addEventListener("click", startCamera);
dom.screenBtn.addEventListener("click", startScreenShare);
dom.muteBtn.addEventListener("click", toggleMute);
