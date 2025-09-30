const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

// Serve static frontend from 'public'
app.use(express.static(path.join(__dirname, 'public')));

// Simple health check
app.get('/health', (req, res) => res.json({ ok: true }));

// Provide ICE servers (STUN + optional TURN) to clients
app.get('/iceServers', (req, res) => {
    const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    // Optional TURN configuration via environment variables
    const turnUrl = process.env.TURN_URL;
    const turnUser = process.env.TURN_USER;
    const turnPass = process.env.TURN_PASS;
    if (turnUrl && turnUser && turnPass) {
        iceServers.push({ urls: turnUrl, username: turnUser, credential: turnPass });
    }
    res.json({ iceServers });
});

// Create a WebSocket server for signaling
const wss = new WebSocket.Server({ server });

// rooms: { sessionId: { sharer: ws, viewers: Set<ws> } }
const rooms = new Map();

function send(ws, data) {
    try {
        ws.send(JSON.stringify(data));
    } catch (err) {
        console.error('send error', err);
    }
}

wss.on('connection', (ws) => {
    ws.id = uuidv4();
    ws.on('message', (msg) => {
        let data = null;
        try {
            data = JSON.parse(msg);
        } catch (err) {
            console.error('invalid json', err);
            return;
        }

        const { type, sessionId, payload } = data;

        if (type === 'create-session') {
            const id = uuidv4();
            rooms.set(id, { sharer: ws, viewers: new Set() });
            ws.isSharer = true;
            ws.sessionId = id;
            send(ws, { type: 'session-created', sessionId: id });
            console.log('session created', id);
            return;
        }

        if (!sessionId) return;
        const room = rooms.get(sessionId);
        if (!room) {
            send(ws, { type: 'error', message: 'Session not found' });
            return;
        }

        switch (type) {
            case 'join-session':
                room.viewers.add(ws);
                ws.sessionId = sessionId;
                ws.isSharer = false;
                send(ws, { type: 'joined', sessionId });
                // notify sharer a new viewer joined
                if (room.sharer && room.sharer.readyState === WebSocket.OPEN) {
                    send(room.sharer, { type: 'viewer-joined', viewerId: ws.id });
                }
                break;

            case 'offer':
                // payload: { target: 'viewerId', sdp, sdpType }
                if (ws.isSharer) {
                    // send to specified viewer or broadcast; forward sdpType when present
                    if (payload && payload.target) {
                        for (const v of room.viewers) {
                            if (v.id === payload.target && v.readyState === WebSocket.OPEN) {
                                send(v, { type: 'offer', sdp: payload.sdp, sdpType: payload.sdpType, from: ws.id });
                                console.log('forwarded offer to', v.id, 'from', ws.id);
                            }
                        }
                    } else {
                        for (const v of room.viewers) {
                            if (v.readyState === WebSocket.OPEN) {
                                send(v, { type: 'offer', sdp: payload.sdp, sdpType: payload.sdpType, from: ws.id });
                            }
                        }
                    }
                }
                break;

            case 'answer':
                // viewer -> sharer (forward sdpType if present)
                if (!ws.isSharer && room.sharer && room.sharer.readyState === WebSocket.OPEN) {
                    send(room.sharer, { type: 'answer', sdp: payload.sdp, sdpType: payload.sdpType, from: ws.id });
                    console.log('forwarded answer from', ws.id, 'to sharer');
                }
                break;

            case 'ice-candidate':
                // payload: { target: id, candidate }
                if (payload && payload.target) {
                    // route to target
                    if (room.sharer && room.sharer.id === payload.target && room.sharer.readyState === WebSocket.OPEN) {
                        send(room.sharer, { type: 'ice-candidate', candidate: payload.candidate, from: ws.id });
                        console.log('forwarded ICE candidate from', ws.id, 'to sharer');
                    } else {
                        for (const v of room.viewers) {
                            if (v.id === payload.target && v.readyState === WebSocket.OPEN) {
                                send(v, { type: 'ice-candidate', candidate: payload.candidate, from: ws.id });
                                console.log('forwarded ICE candidate from', ws.id, 'to viewer', v.id);
                                break;
                            }
                        }
                    }
                } else {
                    // broadcast
                    if (ws.isSharer) {
                        for (const v of room.viewers) if (v.readyState === WebSocket.OPEN) send(v, { type: 'ice-candidate', candidate: payload.candidate, from: ws.id });
                        console.log('broadcasted ICE candidate from sharer to all viewers');
                    } else if (room.sharer && room.sharer.readyState === WebSocket.OPEN) {
                        send(room.sharer, { type: 'ice-candidate', candidate: payload.candidate, from: ws.id });
                        console.log('forwarded ICE candidate from viewer to sharer');
                    }
                }
                break;

            case 'close-session':
                // sharer closing
                if (ws.isSharer) {
                    for (const v of room.viewers) {
                        if (v.readyState === WebSocket.OPEN) send(v, { type: 'session-closed' });
                        v.close();
                    }
                    rooms.delete(sessionId);
                    send(ws, { type: 'closed' });
                }
                break;

            default:
                console.log('unhandled message', type);
        }
    });

    ws.on('close', () => {
        const sid = ws.sessionId;
        if (!sid) return;
        const room = rooms.get(sid);
        if (!room) return;
        if (ws.isSharer) {
            // notify viewers
            for (const v of room.viewers) {
                if (v.readyState === WebSocket.OPEN) send(v, { type: 'session-closed' });
                v.close();
            }
            rooms.delete(sid);
            console.log('sharer disconnected, closed session', sid);
        } else {
            room.viewers.delete(ws);
            if (room.sharer && room.sharer.readyState === WebSocket.OPEN) send(room.sharer, { type: 'viewer-left', viewerId: ws.id });
            console.log('viewer left', ws.id);
        }
    });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
