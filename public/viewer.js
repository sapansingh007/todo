// Viewer client
const status = document.getElementById('status');
const remoteVideo = document.getElementById('remoteVideo');
const screenshotBtn = document.getElementById('screenshotBtn');
const shots = document.getElementById('shots');

const urlParams = new URLSearchParams(location.search);
const sessionId = urlParams.get('session');
if (!sessionId) {
    status.textContent = 'No session id provided';
}

let ws = null;
let pc = null;

function setStatus(s) { status.textContent = s }

function connectSignaling() {
    ws = new WebSocket((location.origin.replace(/^http/, 'ws')));
    ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'join-session', sessionId }));
        setStatus('Joined session, waiting for stream...');
    };

    ws.onmessage = async (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'offer') {
            await handleOffer(msg.sdp, msg.from);
        }
        if (msg.type === 'ice-candidate') {
            if (pc && msg.candidate) pc.addIceCandidate(msg.candidate).catch(e => console.warn(e));
        }
        if (msg.type === 'session-closed') {
            setStatus('Session closed');
            if (pc) pc.close(); pc = null;
        }
    };
    ws.onclose = () => setStatus('Signaling disconnected');
}

async function handleOffer(sdp, from) {
    pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    pc.ontrack = (e) => {
        remoteVideo.srcObject = e.streams[0];
        setStatus('Live');
    };
    pc.onicecandidate = (e) => {
        if (e.candidate && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ice-candidate', sessionId, payload: { target: from, candidate: e.candidate } }));
        }
    };

    await pc.setRemoteDescription({ type: 'offer', sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    ws.send(JSON.stringify({ type: 'answer', sessionId, payload: { sdp: answer.sdp } }));
}

function takeScreenshot() {
    const video = remoteVideo;
    if (!video || video.readyState < 2) { alert('Video not ready'); return; }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/png');

    const wrapper = document.createElement('div');
    wrapper.className = 'shot';
    const img = document.createElement('img');
    img.src = dataUrl;
    img.style.maxWidth = '100%';
    wrapper.appendChild(img);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const now = new Date();
    const time = now.toLocaleString();
    // subscription metadata - in a real app this would come from server/user session
    const subscription = 'Premium';
    meta.innerHTML = `<div>Captured: ${time}</div><div>Subscription: ${subscription}</div>`;
    wrapper.appendChild(meta);

    shots.prepend(wrapper);
}

screenshotBtn.addEventListener('click', takeScreenshot);

connectSignaling();
