# PVT Area

PVT Area is a lightweight prototype for an encrypted messaging and calling app inspired by WhatsApp-style core features:

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

## Deploy on Render

This repo includes a ready-to-use [`render.yaml`](./render.yaml) for a Render web service.

1. Sign in at [Render](https://render.com/).
2. Create a new `Blueprint` or `Web Service` from the GitHub repo.
3. Select the `main` branch.
4. Render will use:
   - Build command: `npm install`
   - Start command: `npm start`
   - Health check: `/healthz`
5. After deploy, open the generated `.onrender.com` URL.

Notes:

- The included config targets Render's `free` web service plan.
- Free Render web services spin down after 15 minutes of inactivity and can take about a minute to wake up again.
- Video calls and screen share work best over HTTPS, which Render provides automatically on the public service URL.

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
