// Sharer client
const startBtn = document.getElementById('startShare');
const stopBtn = document.getElementById('stopShare');
const preview = document.getElementById('preview');
const status = document.getElementById('status');
const linkArea = document.getElementById('linkArea');
const sessionLinkInput = document.getElementById('sessionLink');

let localStream = null;
let ws = null;
let sessionId = null;
// map viewerId -> RTCPeerConnection
const pcs = new Map();
let iceConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

function setStatus(s) { status.textContent = s }

async function startSharing() {
    try {
        localStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch (e) {
        setStatus('Permission denied or not supported');
        console.error(e);
        return;
    }
    preview.srcObject = localStream;
    setStatus('Connecting...');
    // try to play preview (muted + playsinline allow autoplay on mobile browsers)
    try { preview.play().then(() => console.log('preview playing')).catch(e => console.warn('preview play failed', e)); } catch (e) { }

    ws = new WebSocket((location.origin.replace(/^http/, 'ws')));
    ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'create-session' }));
    };

    ws.onmessage = async (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'session-created') {
            sessionId = msg.sessionId;
            const url = `${location.origin}/viewer.html?session=${sessionId}`;
            sessionLinkInput.value = url;
            linkArea.style.display = 'block';
            setStatus('Sharing — session ready');
            startBtn.disabled = true; stopBtn.disabled = false;
        }

        if (msg.type === 'joined') {
            // ignored for sharer
        }

        if (msg.type === 'offer') {
            // shouldn't get offers as sharer
        }

        if (msg.type === 'answer') {
            // viewer answered; set remote desc on matching pc
            const from = msg.from;
            const pc = pcs.get(from);
            if (pc) {
                const desc = { type: (msg && msg.sdpType) ? msg.sdpType : 'answer', sdp: msg.sdp };
                console.log('Setting remote description for', from, desc.type);
                await pc.setRemoteDescription(desc);
            }
        }

        if (msg.type === 'ice-candidate') {
            const from = msg.from;
            const pc = pcs.get(from);
            if (pc && msg.candidate) pc.addIceCandidate(msg.candidate).catch(e => console.warn(e));
        }

        if (msg.type === 'viewer-joined') {
            const viewerId = msg.viewerId;
            createOfferForViewer(viewerId);
        }

        if (msg.type === 'viewer-left') {
            const id = msg.viewerId;
            const pc = pcs.get(id);
            if (pc) { pc.close(); pcs.delete(id); }
        }

        if (msg.type === 'session-closed') {
            stopSharing();
        }
    };

    ws.onclose = () => setStatus('Signaling closed');
}

function stopSharing() {
    if (localStream) {
        for (const t of localStream.getTracks()) t.stop();
        localStream = null;
    }
    for (const pc of pcs.values()) pc.close(); pcs.clear();
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'close-session', sessionId }));
    if (ws) ws.close();
    sessionId = null;
    preview.srcObject = null;
    setStatus('Not sharing');
    startBtn.disabled = false; stopBtn.disabled = true; linkArea.style.display = 'none';
}

async function createOfferForViewer(viewerId) {
    const pc = new RTCPeerConnection(iceConfig);
    pcs.set(viewerId, pc);

    // send ICE candidates to specific viewer
    pc.onicecandidate = (e) => {
        if (e.candidate && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ice-candidate', sessionId, payload: { target: viewerId, candidate: e.candidate } }));
        }
    };

    pc.onconnectionstatechange = () => console.log('pc.connectionState', pc.connectionState, 'for', viewerId);
    pc.oniceconnectionstatechange = () => console.log('pc.iceConnectionState', pc.iceConnectionState, 'for', viewerId);
    pc.onsignalingstatechange = () => console.log('pc.signalingState', pc.signalingState, 'for', viewerId);

    // add tracks
    if (localStream) {
        for (const t of localStream.getTracks()) pc.addTrack(t, localStream);
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // send full SDP object (type + sdp) to be explicit
    ws.send(JSON.stringify({ type: 'offer', sessionId, payload: { target: viewerId, sdp: offer.sdp, sdpType: offer.type } }));
}

async function fetchIceServers() {
    try {
        const res = await fetch('/iceServers');
        const j = await res.json();
        if (j && j.iceServers) iceConfig = { iceServers: j.iceServers };
        console.log('sharer iceConfig', iceConfig);
    } catch (e) { console.warn('failed to fetch iceServers', e); }
}

startBtn.addEventListener('click', startSharing);
stopBtn.addEventListener('click', stopSharing);

window.addEventListener('beforeunload', () => { if (ws && ws.readyState === WebSocket.OPEN) ws.close(); });

// prefetch ICE servers
document.addEventListener('DOMContentLoaded', () => { fetchIceServers(); });
