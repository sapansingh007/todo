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
let remoteStream = null; // dedicated MediaStream for remote tracks
let iceConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
let watchdog = null;
const PLAY_TIMEOUT = 5000; // ms to wait for frames before retry

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
            await handleOffer(msg.sdp, msg.from, msg.sdpType);
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
    pc = new RTCPeerConnection(iceConfig);

    // create or reset remote stream
    remoteStream = new MediaStream();
    remoteVideo.srcObject = remoteStream;

    pc.ontrack = (e) => {
        // Some browsers deliver tracks individually, others via streams
        if (e.streams && e.streams[0]) {
            console.log('ontrack: got stream', e.streams[0]);
            // add all tracks from the stream (defensive)
            e.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));
        } else if (e.track) {
            console.log('ontrack: got track', e.track.kind);
            remoteStream.addTrack(e.track);
        }
        setStatus('Live');

        // try to play the video (autoplay may be blocked on some mobile browsers)
        attemptPlay();
        // when we get a track, start/reset watchdog to ensure frames arrive
        resetWatchdog();
    };
    pc.onicecandidate = (e) => {
        if (e.candidate && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ice-candidate', sessionId, payload: { target: from, candidate: e.candidate } }));
        }
    };

    // Accept either explicit sdp type or assume 'offer'
    const remoteDesc = { type: (typeof sdpType !== 'undefined' && sdpType) ? sdpType : 'offer', sdp };
    console.log('Setting remote description', remoteDesc.type);
    await pc.setRemoteDescription(remoteDesc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    ws.send(JSON.stringify({ type: 'answer', sessionId, payload: { sdp: answer.sdp, sdpType: answer.type } }));

    // Listen for connection state changes for debugging
    pc.onconnectionstatechange = () => console.log('pc.connectionState', pc.connectionState);
    pc.onsignalingstatechange = () => console.log('pc.signalingState', pc.signalingState);
    pc.oniceconnectionstatechange = () => console.log('pc.iceConnectionState', pc.iceConnectionState);

    // video element events for debugging
    remoteVideo.addEventListener('loadeddata', () => console.log('remoteVideo loadeddata', remoteVideo.videoWidth, remoteVideo.videoHeight));
    remoteVideo.addEventListener('playing', () => console.log('remoteVideo playing', remoteVideo.videoWidth, remoteVideo.videoHeight));
    remoteVideo.addEventListener('error', (e) => console.warn('remoteVideo error', e));
}

function attemptPlay() {
    if (!remoteVideo) return;
    // ensure playsinline and muted are set in HTML
    remoteVideo.playsInline = true;
    remoteVideo.muted = true; // muted allows autoplay on many mobile browsers
    const p = remoteVideo.play();
    if (p !== undefined) {
        p.then(() => {
            console.log('remoteVideo.play() succeeded');
        }).catch(err => {
            console.warn('remoteVideo.play() failed', err);
            // Many mobile browsers block autoplay; show hint to user
            setStatus('Tap to start playback');
            // attach a one-time user interaction to try again
            const onTouch = () => { remoteVideo.play().catch(e => console.warn(e)); window.removeEventListener('touchstart', onTouch); };
            window.addEventListener('touchstart', onTouch, { once: true });
            window.addEventListener('click', onTouch, { once: true });
        });
    }
}

function resetWatchdog() {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
        // if no frame arrived (videoWidth === 0), show reconnect option
        if (!remoteVideo.videoWidth || remoteVideo.videoWidth === 0) {
            console.warn('No video frames received within timeout');
            setStatus('No frames received — tap Reconnect');
            document.getElementById('playOverlay').style.display = 'flex';
            document.getElementById('reconnectBtn').style.display = 'inline-block';
        }
    }, PLAY_TIMEOUT);
}

async function fetchIceServers() {
    try {
        const res = await fetch('/iceServers');
        const j = await res.json();
        if (j && j.iceServers) iceConfig = { iceServers: j.iceServers };
        console.log('iceConfig', iceConfig);
    } catch (e) { console.warn('failed to fetch iceServers', e); }
}

// reconnect logic
document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('reconnectBtn');
    const overlay = document.getElementById('playOverlay');
    btn && btn.addEventListener('click', () => {
        overlay.style.display = 'none';
        btn.style.display = 'none';
        if (pc) pc.close(); pc = null;
        connectSignaling();
    });
    // also allow tapping overlay to attempt play
    overlay && overlay.addEventListener('click', () => { attemptPlay(); overlay.style.display = 'none'; });
});

// fetch ICE servers first then connect
fetchIceServers().then(() => connectSignaling());

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
