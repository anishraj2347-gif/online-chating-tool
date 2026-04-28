# CipherChat

CipherChat is a lightweight prototype for an encrypted messaging and calling app inspired by WhatsApp-style core features:

- End-to-end encrypted text chat using `AES-GCM` in the browser
- Peer-to-peer video and audio calling with WebRTC
- Screen sharing with `getDisplayMedia`
- Presence and typing indicators
- Room-based chat with in-memory encrypted history

## Run it

```bash
node server.js
```

Then open [http://localhost:3000](http://localhost:3000) in two browser tabs or devices on the same network.

## Security model

- Chat messages are encrypted in the browser before upload.
- The server relays only ciphertext for chat content.
- Calls and screen sharing use direct WebRTC peer connections with DTLS/SRTP transport security.
- The shared room secret is never sent to the server.

## Important production gaps

This is a strong prototype, not a production-secure messenger yet. Before real-world use, add:

- Persistent identity keys and device verification
- Forward secrecy and per-message ratcheting like Signal
- Secure authentication and account recovery
- TURN infrastructure for restrictive networks
- Database storage, abuse controls, and rate limiting
- Media E2EE enhancements for more complex multi-party architectures
