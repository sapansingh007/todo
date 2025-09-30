# Render Screen Share Demo

This project is a minimal screen-sharing web app using WebRTC for peer-to-peer streaming and a WebSocket-based signaling server. It's designed to be deployed on Render (static + web service).

Features
- Sharer (laptop) captures screen using navigator.mediaDevices.getDisplayMedia()
- Generates a unique session link for viewers
- Simple Node.js WebSocket signaling server routes SDP and ICE candidates between sharer and viewers
- Viewer UI shows live stream and supports "Take Screenshot" which captures current frame and displays date/time + subscription metadata

Files
- `server.js` - Express static server + WebSocket signaling
- `public/` - frontend files: `sharer.html`, `viewer.html`, `sharer.js`, `viewer.js`, `styles.css`
- `package.json` - dependencies and start script

Running locally

1. Install dependencies

```powershell
npm install
```

2. Start the server

```powershell
npm start
```

3. Open `http://localhost:3000` in Chrome. Click "Start Sharing" to allow screen capture. Copy the generated link and open it in another device or tab to view.

Deployment to Render

1. Create a new Web Service on Render.
2. Connect your GitHub repo or push this code to a repo.
3. Set the build command to `npm install` and the start command to `npm start`.
4. Ensure the service uses HTTPS (Render will provide an HTTPS URL). The app requires HTTPS for screen capture and WebRTC.

Notes & Considerations
- This is a demo implementation: it uses a simple signaling server and does not persist sessions beyond server runtime.
- For production, consider authentication, room ownership, rate limiting, and TURN servers for NAT traversal.
- Render supports WebSockets; ensure the plan and service type allow persistent connections and the correct health checks.
