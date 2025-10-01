// Viewer client
const status = document.getElementById('status');
const remoteVideo = document.getElementById('remoteVideo');
const screenshotBtn = document.getElementById('screenshotBtn');
const shots = document.getElementById('shots');

const urlParams = new URLSearchParams(location.search);
// OCR helpers
async function runOcrOnCanvas(canvas) {
    if (ocrInProgress) return;
    ocrInProgress = true;
    setOcrLoading(true);
    setStatus('Running OCR (remote)...');

    // check for OCR.space API key in UI
    const apiKeyInput = document.getElementById('ocrSpaceKey');
    const apiKey = apiKeyInput && apiKeyInput.value ? apiKeyInput.value.trim() : '';

    // resize and prepare canvas
    const usedCanvas = resizeCanvasToMax(canvas, OCR_MAX_DIM);
    lastCanvas = usedCanvas;

    // helper: call OCR.space
    async function callOcrSpace(base64Image) {
        const params = new URLSearchParams();
        params.append('base64Image', base64Image);
        params.append('language', 'eng');
        params.append('isTable', 'false');
        params.append('OCREngine', '2');

        const res = await fetch('https://api.ocr.space/parse/image', {
            method: 'POST',
            headers: {
                'apikey': apiKey,
                'Accept': 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: params.toString()
        });
        if (!res.ok) throw new Error('OCR.space HTTP ' + res.status);
        const j = await res.json();
        if (!j || !j.ParsedResults || !j.ParsedResults.length) throw new Error('No parsed results');
        return j.ParsedResults.map(p => p.ParsedText || '').join('\n');
    }

    try {
        let text = '';
        if (apiKey) {
            try {
                setStatus('Calling OCR.space API (client key)...');
                const base64 = usedCanvas.toDataURL('image/png');
                text = await callOcrSpace(base64);
            } catch (e) {
                console.warn('Client OCR.space call failed, will try server proxy', e);
            }
        }

        // If no client key result, try server-side proxy if available
        if (!text) {
            try {
                setStatus('Calling server OCR proxy...');
                const base64 = usedCanvas.toDataURL('image/png');
                const resp = await fetch('/api/ocr', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base64Image: base64 }) });
                if (resp.ok) {
                    const j = await resp.json();
                    text = j && j.text ? j.text : '';
                } else {
                    console.warn('Server OCR proxy returned', resp.status);
                }
            } catch (e) {
                console.warn('Server OCR proxy failed', e);
            }
        }

        if (!text) {
            setStatus('Running local OCR (fallback)');
            await initTesseractWorker().catch(e => console.warn('init worker failed', e));
            if (tesseractWorker) {
                const blob = await new Promise(res => usedCanvas.toBlob(res, 'image/png'));
                const tres = await tesseractWorker.recognize(blob);
                text = (tres && tres.data && tres.data.text) ? tres.data.text : '';
            }
        }

        // show filtered/extracted results only
        extractResult.innerHTML = '';
        const mode = extractMode ? extractMode.value : 'fulltext';
        if (!text) {
            extractResult.textContent = 'No text recognized.';
            setStatus('OCR complete: no text');
        } else if (mode === 'fulltext') {
            const d = document.createElement('div'); d.className = 'extract-item'; d.textContent = text; extractResult.appendChild(d);
            setStatus('Extraction complete (full text)');
        } else if (mode === 'regex') {
            const found = regexExtract(text, regexInput.value || '');
            if (found.length === 0) extractResult.textContent = 'No matches found.';
            else found.forEach(f => { const d = document.createElement('div'); d.className = 'extract-item'; d.textContent = f; extractResult.appendChild(d); });
            setStatus('Extraction complete (regex)');
        } else if (mode === 'ai') {
            try {
                const out = await aiExtract(text, aiEndpoint.value, aiPrompt.value);
                const d = document.createElement('div'); d.className = 'extract-item'; d.textContent = out; extractResult.appendChild(d);
                setStatus('Extraction complete (AI)');
            } catch (e) {
                extractResult.textContent = 'AI extraction failed: ' + (e && e.message ? e.message : '');
                setStatus('AI extraction failed');
            }
        }

        // hide raw OCR textarea for privacy
        if (ocrTextArea) { ocrTextArea.style.display = 'none'; ocrTextArea.value = ''; }
    } catch (err) {
        console.error('OCR pipeline failed', err);
        extractResult.textContent = 'OCR failed: ' + (err && err.message ? err.message : 'Unknown');
        setStatus('OCR failed');
    } finally {
        cleanupCanvas(lastCanvas);
        lastCanvas = null;
        setOcrLoading(false);
        ocrInProgress = false;
    }
}
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
// OCR helpers
async function runOcrOnCanvas(canvas) {
    if (ocrInProgress) return;
    ocrInProgress = true;
    setOcrLoading(true);
    setStatus('Running OCR (remote)...');

    // check for OCR.space API key in UI
    const apiKeyInput = document.getElementById('ocrSpaceKey');
    const apiKey = apiKeyInput && apiKeyInput.value ? apiKeyInput.value.trim() : '';

    // resize and prepare canvas
    const usedCanvas = resizeCanvasToMax(canvas, OCR_MAX_DIM);
    lastCanvas = usedCanvas;

    // helper: call OCR.space
    async function callOcrSpace(base64Image) {
        const params = new URLSearchParams();
        params.append('base64Image', base64Image);
        params.append('language', 'eng');
        params.append('isTable', 'false');
        params.append('OCREngine', '2');

        const res = await fetch('https://api.ocr.space/parse/image', {
            method: 'POST',
            headers: {
                'apikey': apiKey,
                'Accept': 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: params.toString()
        });
        if (!res.ok) throw new Error('OCR.space HTTP ' + res.status);
        const j = await res.json();
        if (!j || !j.ParsedResults || !j.ParsedResults.length) throw new Error('No parsed results');
        return j.ParsedResults.map(p => p.ParsedText || '').join('\n');
    }

    try {
        let text = '';
        if (apiKey) {
            try {
                setStatus('Calling OCR.space API...');
                const base64 = usedCanvas.toDataURL('image/png');
                text = await callOcrSpace(base64);
            } catch (e) {
                console.warn('OCR.space failed, falling back to local Tesseract', e);
            }
        }

        if (!text) {
            setStatus('Running local OCR (fallback)');
            await initTesseractWorker().catch(e => console.warn('init worker failed', e));
            if (tesseractWorker) {
                const blob = await new Promise(res => usedCanvas.toBlob(res, 'image/png'));
                const tres = await tesseractWorker.recognize(blob);
                text = (tres && tres.data && tres.data.text) ? tres.data.text : '';
            }
        }

        // show filtered/extracted results only
        extractResult.innerHTML = '';
        const mode = extractMode ? extractMode.value : 'fulltext';
        if (!text) {
            extractResult.textContent = 'No text recognized.';
            setStatus('OCR complete: no text');
        } else if (mode === 'fulltext') {
            const d = document.createElement('div'); d.className = 'extract-item'; d.textContent = text; extractResult.appendChild(d);
            setStatus('Extraction complete (full text)');
        } else if (mode === 'regex') {
            const found = regexExtract(text, regexInput.value || '');
            if (found.length === 0) extractResult.textContent = 'No matches found.';
            else found.forEach(f => { const d = document.createElement('div'); d.className = 'extract-item'; d.textContent = f; extractResult.appendChild(d); });
            setStatus('Extraction complete (regex)');
        } else if (mode === 'ai') {
            try {
                const out = await aiExtract(text, aiEndpoint.value, aiPrompt.value);
                const d = document.createElement('div'); d.className = 'extract-item'; d.textContent = out; extractResult.appendChild(d);
                setStatus('Extraction complete (AI)');
            } catch (e) {
                extractResult.textContent = 'AI extraction failed: ' + (e && e.message ? e.message : '');
                setStatus('AI extraction failed');
            }
        }

        // hide raw OCR textarea for privacy
        if (ocrTextArea) { ocrTextArea.style.display = 'none'; ocrTextArea.value = ''; }
    } catch (err) {
        console.error('OCR pipeline failed', err);
        extractResult.textContent = 'OCR failed: ' + (err && err.message ? err.message : 'Unknown');
        setStatus('OCR failed');
    } finally {
        cleanupCanvas(lastCanvas);
        lastCanvas = null;
        setOcrLoading(false);
        ocrInProgress = false;
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
            ocrInProgress = false;
            setOcrLoading(false);
        }, SCREENSHOT_TIMEOUT);

        try {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'request-screenshot', sessionId }));
                console.log('Requested screenshot from sharer (manual)');
            } else {
                if (load) { load.style.display = 'none'; load.innerHTML = ''; }
                if (btn) btn.disabled = false;
                alert('Signaling not connected');
                ocrInProgress = false;
                setOcrLoading(false);
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
