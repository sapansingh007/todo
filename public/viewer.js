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

// Basic mobile detection
function isMobileDevice() {
    return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
}

let ws = null;
let pc = null;
let remoteStream = null; // dedicated MediaStream for remote tracks
let iceConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
let watchdog = null;
const PLAY_TIMEOUT = 5000; // ms to wait for frames before retry
const SCREENSHOT_TIMEOUT = 12000; // ms to wait for a screenshot response
let pendingScreenshotTimer = null;
let ocrInProgress = false;
let lastCanvas = null; // used temporarily for OCR

// Persistent Tesseract worker and settings
let tesseractWorker = null;
let tesseractInitialized = false;
const TESSERACT_LANG = 'eng';
const OCR_MAX_DIM = 1280; // max width/height for OCR to balance speed/accuracy on mobile

// Initialize a persistent Tesseract worker (lazy)
async function initTesseractWorker() {
    if (tesseractWorker || !window.Tesseract) return;
    const { Tesseract } = window;
    tesseractWorker = Tesseract.createWorker({
        logger: m => {
            if (m && m.status) {
                const pct = (m.progress != null) ? Math.round(m.progress * 100) : '';
                setStatus(`OCR: ${m.status}${pct !== '' ? ' ' + pct + '%' : ''}`);
                const load = document.getElementById('screenshotLoading');
                if (load) load.innerHTML = `<span class="spinner" aria-hidden="true"></span> OCR ${pct !== '' ? pct + '%' : ''}`;
            }
            console.log('tesseract', m);
        }
    });
    await tesseractWorker.load();
    await tesseractWorker.loadLanguage(TESSERACT_LANG);
    await tesseractWorker.initialize(TESSERACT_LANG);
    tesseractInitialized = true;
}

async function terminateTesseractWorker() {
    try {
        if (tesseractWorker) {
            await tesseractWorker.terminate();
            tesseractWorker = null;
            tesseractInitialized = false;
        }
    } catch (e) { console.warn('terminate worker failed', e); }
}

// Resize canvas if necessary to limit memory & speed up OCR
function resizeCanvasToMax(c, maxDim = OCR_MAX_DIM) {
    if (!c) return c;
    const w = c.width, h = c.height;
    const longer = Math.max(w, h);
    if (longer <= maxDim) return c;
    const scale = maxDim / longer;
    const nc = document.createElement('canvas');
    nc.width = Math.round(w * scale);
    nc.height = Math.round(h * scale);
    const ctx = nc.getContext('2d');
    ctx.drawImage(c, 0, 0, nc.width, nc.height);
    return nc;
}

function setStatus(s) { status.textContent = s }

// Helpers for OCR UI
const ocrTextArea = document.getElementById('ocrText');
const copyTextBtn = document.getElementById('copyTextBtn');
const shareTextBtn = document.getElementById('shareTextBtn');
const clearTextBtn = document.getElementById('clearTextBtn');

function setOcrLoading(on) {
    const load = document.getElementById('screenshotLoading');
    if (on) {
        if (load) { load.style.display = 'inline'; load.innerHTML = '<span class="spinner" aria-hidden="true"></span> OCR...'; }
    } else {
        if (load) { load.style.display = 'none'; load.innerHTML = ''; }
    }
}

copyTextBtn && copyTextBtn.addEventListener('click', () => {
    if (!ocrTextArea || !ocrTextArea.value) return;
    navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(ocrTextArea.value) : alert('Clipboard API not available');
});

shareTextBtn && shareTextBtn.addEventListener('click', async () => {
    if (!ocrTextArea || !ocrTextArea.value) return;
    if (navigator.share) {
        try { await navigator.share({ text: ocrTextArea.value }); } catch (e) { console.warn('share failed', e); }
    } else {
        alert('Web Share API not available on this browser');
    }
});

clearTextBtn && clearTextBtn.addEventListener('click', () => {
    if (ocrTextArea) ocrTextArea.value = '';
});

// Extraction UI wiring
const extractMode = document.getElementById('extractMode');
// keywords removed — full text extraction is default
const regexInput = document.getElementById('regexInput');
const aiEndpoint = document.getElementById('aiEndpoint');
const aiPrompt = document.getElementById('aiPrompt');
const extractBtn = document.getElementById('extractBtn');
const extractLoading = document.getElementById('extractLoading');
const extractResult = document.getElementById('extractResult');

if (extractMode) {
    extractMode.addEventListener('change', () => {
        document.querySelectorAll('.extract-mode').forEach(el => el.style.display = 'none');
        const mode = extractMode.value;
        const el = document.getElementById('mode' + (mode[0].toUpperCase() + mode.slice(1)));
        if (el) el.style.display = 'block';
    });
}

// full text extraction replaces keyword-based extraction

function regexExtract(text, pattern) {
    try {
        // support leading/trailing slashes and flags
        const m = pattern.match(/^\/(.*)\/(\w*)$/);
        let re;
        if (m) re = new RegExp(m[1], m[2]); else re = new RegExp(pattern, 'g');
        const matches = text.match(re);
        return matches || [];
    } catch (e) { return []; }
}

async function aiExtract(text, endpoint, prompt) {
    // POST to user-provided endpoint that accepts { text, prompt }
    if (!endpoint) throw new Error('AI endpoint not provided');
    const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, prompt }) });
    if (!res.ok) throw new Error('AI endpoint error ' + res.status);
    const j = await res.json();
    // expect { extracted: '...' } or fallback to raw text
    return j.extracted || j.result || j.text || JSON.stringify(j);
}

extractBtn && extractBtn.addEventListener('click', async () => {
    const text = ocrTextArea ? ocrTextArea.value : '';
    extractResult.innerHTML = '';
    if (!text) { extractResult.textContent = 'No OCR text to extract from.'; return; }
    const mode = extractMode ? extractMode.value : 'fulltext';
    extractLoading.style.display = 'inline';
    try {
        if (mode === 'fulltext') {
            // show the full OCR output as a single result item
            const d = document.createElement('div'); d.className = 'extract-item';
            d.textContent = text || '(no text detected)';
            extractResult.appendChild(d);
        } else if (mode === 'regex') {
            const found = regexExtract(text, regexInput.value || '');
            if (found.length === 0) extractResult.textContent = 'No matches found.';
            else found.forEach(f => { const d = document.createElement('div'); d.className = 'extract-item'; d.textContent = f; extractResult.appendChild(d); });
        } else if (mode === 'ai') {
            const out = await aiExtract(text, aiEndpoint.value, aiPrompt.value);
            const d = document.createElement('div'); d.className = 'extract-item'; d.textContent = out; extractResult.appendChild(d);
        }
    } catch (e) {
        extractResult.textContent = 'Extraction failed: ' + (e && e.message ? e.message : '');
    } finally { extractLoading.style.display = 'none'; }
});

function connectSignaling() {
    ws = new WebSocket((location.origin.replace(/^http/, 'ws')));
    ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'join-session', sessionId, payload: { isMobile: isMobileDevice() } }));
        setStatus('Joined session, waiting for stream...');
    };

    ws.onmessage = async (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'offer') {
            // On mobile we intentionally don't expect live offers; still handle if present
            if (!isMobileDevice()) await handleOffer(msg.sdp, msg.from, msg.sdpType);
        }
        if (msg.type === 'ice-candidate') {
            if (pc && msg.candidate) pc.addIceCandidate(msg.candidate).catch(e => console.warn(e));
        }
        // handle incoming screenshot from sharer (fallback)
        if (msg.type === 'screenshot') {
            console.log('Received screenshot from sharer', msg.meta);
            // hide loading indicator if visible
            const load = document.getElementById('screenshotLoading'); if (load) { load.style.display = 'none'; load.innerHTML = ''; }
            // clear pending timeout
            if (pendingScreenshotTimer) { clearTimeout(pendingScreenshotTimer); pendingScreenshotTimer = null; }
            // re-enable button
            const btn = document.getElementById('screenshotBtn'); if (btn) btn.disabled = false;
            setStatus('Screenshot received');
            // append to shots list
            appendScreenshotToList(msg.dataUrl, msg.meta);
            // If an OCR request is waiting (we initiated OCR), run OCR on received image
            if (ocrInProgress) {
                // create an offscreen canvas from dataUrl and run OCR
                try {
                    await runOcrOnDataUrl(msg.dataUrl);
                } catch (e) { console.error('OCR on received image failed', e); setStatus('OCR failed'); }
            }
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
            // request a screenshot from the sharer as a fallback
            try {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'request-screenshot', sessionId }));
                    console.log('Requested screenshot from sharer');
                }
            } catch (e) { console.warn('failed to request screenshot', e); }
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

    // If on mobile we will run OCR instead of storing the image
    if (isMobileDevice()) {
        // run OCR directly and then clean up the image
        runOcrOnCanvas(canvas).catch(e => console.warn('ocr failed', e));
        // ensure we clear the canvas/image references afterwards
        cleanupCanvas(canvas);
        return;
    }

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

// Display a fallback screenshot overlay with download
function showScreenshot(dataUrl, meta) {
    // create overlay
    let overlay = document.getElementById('screenshotOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'screenshotOverlay';
        overlay.style.position = 'fixed';
        overlay.style.left = '0';
        overlay.style.top = '0';
        overlay.style.width = '100%';
        overlay.style.height = '100%';
        overlay.style.background = 'rgba(0,0,0,0.85)';
        overlay.style.display = 'flex';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        overlay.style.zIndex = 9999;
        document.body.appendChild(overlay);
    }
    overlay.innerHTML = '';
    const container = document.createElement('div');
    container.style.maxWidth = '95%';
    container.style.maxHeight = '95%';
    container.style.textAlign = 'center';

    const img = document.createElement('img');
    img.src = dataUrl;
    img.style.maxWidth = '100%';
    img.style.maxHeight = '80vh';
    img.alt = 'Screenshot fallback';
    container.appendChild(img);

    const info = document.createElement('div');
    info.style.color = '#fff';
    info.style.marginTop = '8px';
    info.textContent = meta && meta.capturedAt ? `Captured: ${new Date(meta.capturedAt).toLocaleString()}` : '';
    container.appendChild(info);

    const btnRow = document.createElement('div');
    btnRow.style.marginTop = '12px';

    const downloadBtn = document.createElement('a');
    downloadBtn.textContent = 'Download';
    downloadBtn.href = dataUrl;
    downloadBtn.download = `screenshot-${Date.now()}.png`;
    downloadBtn.style.marginRight = '12px';
    downloadBtn.style.color = '#fff';
    downloadBtn.style.background = '#007acc';
    downloadBtn.style.padding = '8px 12px';
    downloadBtn.style.borderRadius = '4px';
    downloadBtn.style.textDecoration = 'none';
    btnRow.appendChild(downloadBtn);

    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    closeBtn.style.padding = '8px 12px';
    closeBtn.style.borderRadius = '4px';
    closeBtn.onclick = () => { overlay.style.display = 'none'; };
    btnRow.appendChild(closeBtn);

    container.appendChild(btnRow);
    overlay.appendChild(container);
    overlay.style.display = 'flex';
}

// Append screenshot to the #shots list (used by mobile flow)
function appendScreenshotToList(dataUrl, meta) {
    const wrapper = document.createElement('div');
    wrapper.className = 'shot';
    wrapper.style.display = 'block';
    wrapper.style.padding = '8px';
    wrapper.style.border = '1px solid #e5e7eb';
    wrapper.style.borderRadius = '8px';
    wrapper.style.background = '#fff';

    const img = document.createElement('img');
    img.src = dataUrl;
    img.style.width = '100%';
    img.style.borderRadius = '6px';
    wrapper.appendChild(img);

    const metaDiv = document.createElement('div');
    metaDiv.className = 'meta';
    const time = meta && meta.capturedAt ? new Date(meta.capturedAt).toLocaleString() : new Date().toLocaleString();
    metaDiv.innerHTML = `<div>Captured: ${time}</div><div>Source: remote</div>`;
    wrapper.appendChild(metaDiv);

    const actions = document.createElement('div');
    actions.style.marginTop = '8px';

    const dl = document.createElement('a');
    dl.href = dataUrl;
    dl.download = `screenshot-${Date.now()}.png`;
    dl.textContent = 'Download';
    dl.style.display = 'inline-block';
    dl.style.padding = '8px 12px';
    dl.style.background = '#2563eb';
    dl.style.color = '#fff';
    dl.style.borderRadius = '6px';
    dl.style.textDecoration = 'none';
    actions.appendChild(dl);

    wrapper.appendChild(actions);

    shots.prepend(wrapper);
}

// Mobile-specific: override takeScreenshot to request from sharer
async function takeScreenshotMobile() {
    const load = document.getElementById('screenshotLoading');
    const btn = document.getElementById('screenshotBtn');

    // OCR helpers
    async function runOcrOnCanvas(canvas) {
        if (!window.Tesseract) throw new Error('Tesseract not loaded');
        if (ocrInProgress) return;
        ocrInProgress = true;
        setOcrLoading(true);
        setStatus('Running OCR...');
        // Ensure worker is ready
        await initTesseractWorker().catch(e => { console.warn('init worker failed', e); });

        // store the canvas reference temporarily for cleanup
        lastCanvas = canvas;

        try {
            await initTesseractWorker();
            if (!tesseractWorker) throw new Error('Tesseract worker not available');
            // resize for mobile performance
            const usedCanvas = resizeCanvasToMax(canvas, OCR_MAX_DIM);
            const blob = await new Promise(res => usedCanvas.toBlob(res, 'image/png'));
            const res = await tesseractWorker.recognize(blob);
            const text = (res && res.data && res.data.text) ? res.data.text : '';
            if (ocrTextArea) {
                ocrTextArea.value = text || '';
                // focus/select for easy copy
                ocrTextArea.focus();
                ocrTextArea.select();
            }
            setStatus('OCR complete');
            // cleanup canvas and blob references
            cleanupCanvas(lastCanvas);
            lastCanvas = null;
        } catch (err) {
            console.error('OCR error', err);
            setStatus('OCR failed');
        } finally {
            setOcrLoading(false);
            ocrInProgress = false;
        }
    }

    async function runOcrOnDataUrl(dataUrl) {
        // create canvas from dataUrl
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = async () => {
                const c = document.createElement('canvas');
                c.width = img.naturalWidth;
                c.height = img.naturalHeight;
                const ctx = c.getContext('2d');
                ctx.drawImage(img, 0, 0);
                try {
                    await runOcrOnCanvas(c);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            };
            img.onerror = (e) => reject(new Error('Image load failed for OCR'));
            img.src = dataUrl;
        });
    }

    function cleanupCanvas(c) {
        try {
            if (!c) return;
            const ctx = c.getContext && c.getContext('2d');
            if (ctx) { ctx.clearRect(0, 0, c.width, c.height); }
            // zero sizes to free memory
            c.width = 0; c.height = 0;
            // remove DOM reference if attached
            if (c.parentNode) c.parentNode.removeChild(c);
        } catch (e) { console.warn('cleanupCanvas failed', e); }
    }
    // show inline spinner
    if (load) { load.style.display = 'inline'; load.innerHTML = '<span class="spinner" aria-hidden="true"></span> OCR...'; }
    if (btn) btn.disabled = true;
    // mark OCR in progress so incoming screenshot will be OCRed
    ocrInProgress = true;
    // show OCR loading UI
    setOcrLoading(true);
    // start initializing worker in background (non-blocking) so it's ready when image arrives
    initTesseractWorker().catch(e => console.warn('tesseract init failed', e));
    // set timeout to fail gracefully
    if (pendingScreenshotTimer) clearTimeout(pendingScreenshotTimer);
    pendingScreenshotTimer = setTimeout(() => {
        if (load) { load.style.display = 'none'; load.innerHTML = ''; }
        if (btn) btn.disabled = false;
        setStatus('Screenshot request timed out');
        pendingScreenshotTimer = null;
    }, SCREENSHOT_TIMEOUT);

    try {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'request-screenshot', sessionId }));
            console.log('Requested screenshot from sharer (manual)');
        } else {
            if (load) { load.style.display = 'none'; load.innerHTML = ''; }
            if (btn) btn.disabled = false;
            alert('Signaling not connected');
        }
    } catch (e) {
        console.warn(e);
        if (load) { load.style.display = 'none'; load.innerHTML = ''; }
        if (btn) btn.disabled = false;
        if (pendingScreenshotTimer) { clearTimeout(pendingScreenshotTimer); pendingScreenshotTimer = null; }
        ocrInProgress = false;
        setOcrLoading(false);
    }
}

// On load, if mobile, hide live video and wire screenshot button to mobile flow
document.addEventListener('DOMContentLoaded', () => {
    if (isMobileDevice()) {
        // hide video preview for mobile viewers
        const vw = document.querySelector('.videoWrap'); if (vw) vw.style.display = 'none';
        // wire screenshot button
        const btn = document.getElementById('screenshotBtn'); if (btn) { btn.removeEventListener('click', takeScreenshot); btn.addEventListener('click', takeScreenshotMobile); }
    }
});

// Clean up tesseract worker on page unload
window.addEventListener('beforeunload', () => {
    terminateTesseractWorker();
});
