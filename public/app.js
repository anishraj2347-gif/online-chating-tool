const dom = {
  joinForm: document.querySelector("#join-form"),
  chatForm: document.querySelector("#chat-form"),
  nameInput: document.querySelector("#name"),
  roomInput: document.querySelector("#room-id"),
  secretInput: document.querySelector("#room-secret"),
  messageInput: document.querySelector("#message-input"),
  sendBtn: document.querySelector("#send-btn"),
  messages: document.querySelector("#messages"),
  roomLabel: document.querySelector("#room-label"),
  presenceCount: document.querySelector("#presence-count"),
  inviteLink: document.querySelector("#invite-link"),
  copyLinkBtn: document.querySelector("#copy-link-btn"),
  typingIndicator: document.querySelector("#typing-indicator"),
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
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" }
  ]
};

const state = {
  roomId: "",
  clientId: "",
  name: "",
  keyMaterial: null,
  peers: new Map(),
  remoteCards: new Map(),
  participants: new Map(),
  localStream: null,
  screenStream: null,
  typingTimeout: null,
  mute: false,
  pollActive: false,
  pollController: null
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
  dom.cameraBtn.disabled = !connected;
  dom.screenBtn.disabled = !connected;
  dom.muteBtn.disabled = !connected;
  dom.copyLinkBtn.disabled = !connected;
}

function renderPresence() {
  dom.presenceCount.textContent = state.clientId ? `${state.participants.size + 1} online` : "0 online";
}

function clearMessages() {
  dom.messages.innerHTML = "";
}

function appendMessage(message, isSelf) {
  const node = dom.messageTemplate.content.firstElementChild.cloneNode(true);
  node.classList.toggle("self", isSelf);
  node.querySelector(".message-name").textContent = message.name;
  node.querySelector(".message-time").textContent = new Date(message.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
  node.querySelector(".message-text").textContent = message.text;
  dom.messages.appendChild(node);
  dom.messages.scrollTop = dom.messages.scrollHeight;
}

function setTypingLabel(label) {
  dom.typingIndicator.textContent = label;
}

function buildInviteLink() {
  if (!state.roomId) {
    return "";
  }

  const inviteUrl = new URL(window.location.href);
  inviteUrl.searchParams.set("room", state.roomId);
  inviteUrl.hash = "";
  return inviteUrl.toString();
}

function updateInviteLink() {
  const inviteUrl = state.clientId ? buildInviteLink() : "";

  if (!inviteUrl) {
    dom.inviteLink.textContent = "Join a room to generate a share link.";
    dom.copyLinkBtn.disabled = true;
    return;
  }

  dom.inviteLink.textContent = inviteUrl;
  dom.copyLinkBtn.disabled = false;
  window.history.replaceState({}, "", inviteUrl);
}

async function copyInviteLink() {
  const inviteUrl = buildInviteLink();

  if (!inviteUrl) {
    return;
  }

  await navigator.clipboard.writeText(inviteUrl);
  const previousLabel = dom.copyLinkBtn.textContent;
  dom.copyLinkBtn.textContent = "Copied";
  setTimeout(() => {
    dom.copyLinkBtn.textContent = previousLabel;
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
    return state.remoteCards.get(peerId);
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
    dom.selfStreamLabel.textContent = "Sharing screen";
    return;
  }

  if (state.localStream) {
    dom.selfStreamLabel.textContent = state.mute ? "Muted" : "Camera live";
    return;
  }

  dom.selfStreamLabel.textContent = "No media";
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
        sender.replaceTrack(cameraTrack);
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
  dom.muteBtn.textContent = state.mute ? "Unmute" : "Mute";
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

  const payload = JSON.stringify({
    roomId: state.roomId,
    clientId: state.clientId
  });

  if (navigator.sendBeacon) {
    navigator.sendBeacon("/api/leave", new Blob([payload], { type: "application/json" }));
    return;
  }

  await fetch("/api/leave", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
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

  state.participants.clear();
  state.roomId = "";
  state.clientId = "";
  state.keyMaterial = null;
  clearMessages();
  setTypingLabel("Nobody is typing");
  renderPresence();
  setConnectedUi(false);
  dom.roomLabel.textContent = "Not connected";
  updateInviteLink();
}

async function joinRoom(event) {
  event.preventDefault();

  const nextName = dom.nameInput.value.trim();
  const nextRoom = dom.roomInput.value.trim().toLowerCase();
  const secret = dom.secretInput.value;

  if (!nextName || !nextRoom || !secret) {
    return;
  }

  if (state.clientId) {
    await notifyLeave().catch(() => {});
  }

  resetRoomState();

  state.name = nextName;
  state.roomId = nextRoom;
  state.keyMaterial = await deriveChatKey(secret, state.roomId);

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
    updateInviteLink();
    return;
  }

  state.clientId = result.clientId;
  state.participants.clear();
  for (const participant of result.participants) {
    state.participants.set(participant.id, { name: participant.name });
  }

  dom.roomLabel.textContent = `#${state.roomId}`;
  renderPresence();
  setConnectedUi(true);
  updateInviteLink();
  void pollLoop();

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

function applyUrlPrefill() {
  const params = new URLSearchParams(window.location.search);
  const room = params.get("room");
  if (room && !dom.roomInput.value) {
    dom.roomInput.value = room.toLowerCase();
  }
}

window.addEventListener("pagehide", () => {
  void notifyLeave().catch(() => {});
});

applyUrlPrefill();
setConnectedUi(false);
updateInviteLink();

dom.joinForm.addEventListener("submit", joinRoom);
dom.chatForm.addEventListener("submit", sendMessage);
dom.messageInput.addEventListener("input", announceTyping);
dom.cameraBtn.addEventListener("click", startCamera);
dom.screenBtn.addEventListener("click", startScreenShare);
dom.muteBtn.addEventListener("click", toggleMute);
dom.copyLinkBtn.addEventListener("click", () => {
  void copyInviteLink();
});
