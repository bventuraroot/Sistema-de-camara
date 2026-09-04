// Mobile Real-Time Engine with Zero-Lag Canvas Player and 25 FPS Native Stream Mode
let currentCam = 'cam1';
let isRunning = true;
let isFetching = false;
let frameCount = 0;
let lastFpsUpdate = performance.now();
let lastFrameTime = performance.now();
let trackingEnabled = true;
let playerMode = localStorage.getItem('mobile_player_mode') || 'canvas'; // 'canvas' o 'mjpeg'

const canvas = document.getElementById('liveCanvas');
const ctx = canvas.getContext('2d', { alpha: false });
const nativeStreamImg = document.getElementById('nativeStreamImg');

const mobileFpsBadge = document.getElementById('mobileFpsBadge');
const mobileLatencyBadge = document.getElementById('mobileLatencyBadge');
const tabMobileCam1 = document.getElementById('tabMobileCam1');
const tabMobileCam2 = document.getElementById('tabMobileCam2');
const currentCamName = document.getElementById('currentCamName');
const currentResolution = document.getElementById('currentResolution');
const btnToggleTracking = document.getElementById('btnToggleTracking');
const mobileToast = document.getElementById('mobileToast');

const btnModeCanvas = document.getElementById('btnModeCanvas');
const btnModeMjpeg = document.getElementById('btnModeMjpeg');

const mobileAlertMotion = document.getElementById('mobileAlertMotion');
const mobileAlertAi = document.getElementById('mobileAlertAi');
const mobileAlertAiMsg = document.getElementById('mobileAlertAiMsg');
const mobileAlertTracking = document.getElementById('mobileAlertTracking');

function showToast(msg, duration = 2200) {
    if (!mobileToast) return;
    mobileToast.textContent = msg;
    mobileToast.style.display = 'block';
    setTimeout(() => {
        mobileToast.style.display = 'none';
    }, duration);
}

// Bucle de fotogramas de Latencia Cero con createImageBitmap acelerado por GPU
async function fetchNextFrame() {
    if (!isRunning || playerMode !== 'canvas') return;
    if (isFetching) {
        requestAnimationFrame(fetchNextFrame);
        return;
    }

    isFetching = true;
    const reqStart = performance.now();
    const abortCtrl = new AbortController();
    const timeoutId = setTimeout(() => abortCtrl.abort(), 160);

    try {
        const response = await fetch(`/api/camera/${currentCam}/live_frame?quality=mobile&t=${Date.now()}`, {
            cache: 'no-store',
            signal: abortCtrl.signal
        });
        clearTimeout(timeoutId);

        if (response.ok && response.status === 200) {
            const blob = await response.blob();
            if (blob.size > 500) {
                if ('createImageBitmap' in window) {
                    try {
                        const bitmap = await createImageBitmap(blob);
                        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
                            canvas.width = bitmap.width;
                            canvas.height = bitmap.height;
                        }
                        ctx.drawImage(bitmap, 0, 0);
                        bitmap.close();
                    } catch (e) {}
                } else {
                    await new Promise((resolve) => {
                        const img = new Image();
                        const url = URL.createObjectURL(blob);
                        img.onload = () => {
                            if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
                                canvas.width = img.naturalWidth;
                                canvas.height = img.naturalHeight;
                            }
                            ctx.drawImage(img, 0, 0);
                            URL.revokeObjectURL(url);
                            resolve();
                        };
                        img.onerror = () => {
                            URL.revokeObjectURL(url);
                            resolve();
                        };
                        img.src = url;
                    });
                }

                const now = performance.now();
                frameCount++;

                // Cálculo de FPS
                if (now - lastFpsUpdate >= 1000) {
                    const fps = (frameCount * 1000) / (now - lastFpsUpdate);
                    if (mobileFpsBadge) mobileFpsBadge.textContent = `${fps.toFixed(1)} FPS`;
                    frameCount = 0;
                    lastFpsUpdate = now;
                }

                // Cálculo de latencia de red/procesamiento
                const latency = Math.round(now - reqStart);
                if (mobileLatencyBadge) mobileLatencyBadge.textContent = `${latency} ms`;

                isFetching = false;
                requestAnimationFrame(fetchNextFrame);
                return;
            }
        }
    } catch (e) {
        // Timeout de AbortController o desconexión
    } finally {
        clearTimeout(timeoutId);
    }

    isFetching = false;
    setTimeout(fetchNextFrame, 60);
}

// Selector de Modo de Reproducción
function setPlayerMode(mode) {
    playerMode = mode;
    localStorage.setItem('mobile_player_mode', mode);

    if (btnModeCanvas) btnModeCanvas.classList.toggle('active', mode === 'canvas');
    if (btnModeMjpeg) btnModeMjpeg.classList.toggle('active', mode === 'mjpeg');

    if (mode === 'canvas') {
        if (canvas) canvas.style.display = 'block';
        if (nativeStreamImg) {
            nativeStreamImg.style.display = 'none';
            nativeStreamImg.src = '';
        }
        if (currentResolution) currentResolution.textContent = '640x360 @ Cero Delay (Canvas GPU)';
        if (mobileFpsBadge) mobileFpsBadge.textContent = '-- FPS';
        if (mobileLatencyBadge) mobileLatencyBadge.textContent = '-- ms';
        isFetching = false;
        requestAnimationFrame(fetchNextFrame);
        showToast('Modo Cero Delay (Canvas GPU) activado');
    } else {
        // MJPEG Directo 25 FPS
        if (canvas) canvas.style.display = 'none';
        if (nativeStreamImg) {
            nativeStreamImg.style.display = 'block';
            nativeStreamImg.src = `/video_feed/${currentCam}?quality=mobile&t=${Date.now()}`;
        }
        if (currentResolution) currentResolution.textContent = '640x360 @ 25 FPS Flujo Continuo';
        if (mobileFpsBadge) mobileFpsBadge.textContent = '25 FPS';
        if (mobileLatencyBadge) mobileLatencyBadge.textContent = 'Directo';
        showToast('Modo 25 FPS (Flujo Directo) activado');
    }
}

if (btnModeCanvas) btnModeCanvas.addEventListener('click', () => setPlayerMode('canvas'));
if (btnModeMjpeg) btnModeMjpeg.addEventListener('click', () => setPlayerMode('mjpeg'));

// Iniciar según la preferencia guardada
setPlayerMode(playerMode);

// Cambio de cámara
function switchMobileCamera(cid) {
    if (currentCam === cid) return;
    currentCam = cid;
    
    if (tabMobileCam1) tabMobileCam1.classList.toggle('active', cid === 'cam1');
    if (tabMobileCam2) tabMobileCam2.classList.toggle('active', cid === 'cam2');

    if (currentCamName) {
        currentCamName.textContent = cid === 'cam1' ? 'Cámara 1: Tuya PTZ' : 'Cámara 2: iCam365 (ONVIF)';
    }

    showToast(`Cambiando a ${cid === 'cam1' ? 'Cámara 1' : 'Cámara 2'}...`);

    if (playerMode === 'mjpeg' && nativeStreamImg) {
        nativeStreamImg.src = `/video_feed/${currentCam}?quality=mobile&t=${Date.now()}`;
    } else {
        isFetching = false;
        requestAnimationFrame(fetchNextFrame);
    }
    syncTrackingState();
}

if (tabMobileCam1) tabMobileCam1.addEventListener('click', () => switchMobileCamera('cam1'));
if (tabMobileCam2) tabMobileCam2.addEventListener('click', () => switchMobileCamera('cam2'));

// Control PTZ Táctil
async function sendPtzMove(dir) {
    const pulseDur = (dir === 'center') ? 0.0 : 0.25;
    try {
        if (dir === 'center') {
            await fetch('/api/ptz/home', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ camera: currentCam })
            });
            showToast('Volviendo al punto central...');
        } else {
            await fetch('/api/ptz/move', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    direction: dir,
                    duration: pulseDur,
                    camera: currentCam
                })
            });
        }
    } catch (e) {
        console.error('Error enviando PTZ móvil:', e);
    }
}

document.querySelectorAll('.dpad-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        const dir = btn.dataset.dir;
        if (dir) sendPtzMove(dir);
    });
});

// Captura de Foto
const btnSnapPhoto = document.getElementById('btnSnapPhoto');
if (btnSnapPhoto) {
    btnSnapPhoto.addEventListener('click', async () => {
        try {
            const resp = await fetch(`/api/camera/${currentCam}/snapshot`, { method: 'POST' });
            const data = await resp.json();
            if (data.success) {
                showToast(`📸 Foto guardada: ${data.filename || ''}`);
            } else {
                showToast('Error al capturar foto');
            }
        } catch (e) {
            showToast('Error al capturar foto');
        }
    });
}

// Botón Centro Home
const btnCenterHome = document.getElementById('btnCenterHome');
if (btnCenterHome) {
    btnCenterHome.addEventListener('click', () => sendPtzMove('center'));
}

// Botón Refrescar
const btnRefreshFeed = document.getElementById('btnRefreshFeed');
if (btnRefreshFeed) {
    btnRefreshFeed.addEventListener('click', () => {
        isFetching = false;
        showToast('Refrescando transmisión...');
        if (playerMode === 'mjpeg' && nativeStreamImg) {
            nativeStreamImg.src = `/video_feed/${currentCam}?quality=mobile&t=${Date.now()}`;
        } else {
            requestAnimationFrame(fetchNextFrame);
        }
    });
}

// Sincronizar y alternar Auto-Tracking
async function syncTrackingState() {
    try {
        const resp = await fetch('/api/status');
        if (resp.ok) {
            const data = await resp.json();
            const camData = (data.cameras || {})[currentCam] || {};
            trackingEnabled = camData.auto_tracking !== false;
            updateTrackingButtonUI();
        }
    } catch (e) {}
}

function updateTrackingButtonUI() {
    if (!btnToggleTracking) return;
    btnToggleTracking.classList.toggle('active', trackingEnabled);
    const ind = btnToggleTracking.querySelector('.toggle-indicator');
    if (ind) ind.textContent = trackingEnabled ? 'ON' : 'OFF';
}

if (btnToggleTracking) {
    btnToggleTracking.addEventListener('click', async () => {
        trackingEnabled = !trackingEnabled;
        updateTrackingButtonUI();
        try {
            await fetch(`/api/cameras/${currentCam}/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ auto_tracking: trackingEnabled })
            });
            showToast(`Auto-Tracking: ${trackingEnabled ? 'ACTIVADO' : 'DESACTIVADO'}`);
        } catch (e) {
            showToast('Error actualizando tracking');
        }
    });
}

// Pantalla Completa
const btnFullscreen = document.getElementById('btnFullscreen');
const videoContainer = document.getElementById('videoContainer');
if (btnFullscreen && videoContainer) {
    btnFullscreen.addEventListener('click', () => {
        if (!document.fullscreenElement) {
            if (videoContainer.requestFullscreen) {
                videoContainer.requestFullscreen();
            } else if (videoContainer.webkitRequestFullscreen) {
                videoContainer.webkitRequestFullscreen();
            }
        } else {
            if (document.exitFullscreen) {
                document.exitFullscreen();
            }
        }
    });
}

// Canal SSE para Alertas en Vivo
function initMobileEvents() {
    const evtSource = new EventSource('/api/events');
    evtSource.onmessage = (e) => {
        try {
            const ev = JSON.parse(e.data);
            if (ev.type === 'motion' && ev.camera === currentCam) {
                if (mobileAlertMotion) {
                    mobileAlertMotion.style.display = 'block';
                    setTimeout(() => { mobileAlertMotion.style.display = 'none'; }, 2000);
                }
            } else if (ev.type === 'ai_detection' && ev.camera === currentCam) {
                if (mobileAlertAi) {
                    if (mobileAlertAiMsg) mobileAlertAiMsg.textContent = ev.label || 'Persona';
                    mobileAlertAi.style.display = 'block';
                    setTimeout(() => { mobileAlertAi.style.display = 'none'; }, 2500);
                }
            } else if (ev.type === 'tracking' && ev.camera === currentCam) {
                if (mobileAlertTracking) {
                    mobileAlertTracking.style.display = 'block';
                    setTimeout(() => { mobileAlertTracking.style.display = 'none'; }, 1500);
                }
            }
        } catch (err) {}
    };
}

initMobileEvents();
syncTrackingState();

// Pausar y reanudar con la visibilidad del móvil (ahorro de batería y datos)
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        isRunning = true;
        isFetching = false;
        if (playerMode === 'mjpeg' && nativeStreamImg) {
            nativeStreamImg.src = `/video_feed/${currentCam}?quality=mobile&t=${Date.now()}`;
        } else {
            requestAnimationFrame(fetchNextFrame);
        }
    } else {
        isRunning = false;
        if (nativeStreamImg) nativeStreamImg.src = '';
    }
});
