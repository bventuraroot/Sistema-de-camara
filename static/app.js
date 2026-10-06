// ==========================================================================
// SISTEMA DE CÁMARAS INTELIGENTE - LÓGICA DE CONTROL Y EVENTOS EN VIVO
// ==========================================================================

// Estado global de la aplicación
let soundEnabled = false;

// Contadores en sesión
let counts = {
    person: 0,
    vehicle: 0,
    motion: 0,
    alerts: 0
};

// Elementos DOM
const cameraStatusEl = document.getElementById('cameraStatus');
const statusTextEl = document.getElementById('statusText');
const resTextEl = document.getElementById('resText');
const fpsTextEl = document.getElementById('fpsText');
const aiFpsTextEl = document.getElementById('aiFpsText');
const localUrlDisplayEl = document.getElementById('localUrlDisplay');
const copyUrlBtn = document.getElementById('copyUrlBtn');

// Elementos de Vista y Cámaras
const tabMosaic = document.getElementById('tabMosaic');
const tabCam1 = document.getElementById('tabCam1');
const tabCam2 = document.getElementById('tabCam2');
const mosaicContainer = document.getElementById('mosaicContainer');
const activeViewTag = document.getElementById('activeViewTag');

// En móvil, arrancar en cam1 (una sola cámara) para evitar saturar Safari con 2 streams a la vez
let currentViewMode = 'mosaic'; // 'mosaic' | 'cam1' | 'cam2'

const videoFeedCam1 = document.getElementById('videoFeedCam1');
const videoFeedCam2 = document.getElementById('videoFeedCam2');
const canvasFeedCam1 = document.getElementById('canvasFeedCam1');
const canvasFeedCam2 = document.getElementById('canvasFeedCam2');
const ctxCam1 = canvasFeedCam1 ? canvasFeedCam1.getContext('2d', { alpha: false }) : null;
const ctxCam2 = canvasFeedCam2 ? canvasFeedCam2.getContext('2d', { alpha: false }) : null;

const btnToggleEngine = document.getElementById('btnToggleEngine');
const engineModeIcon = document.getElementById('engineModeIcon');
const engineModeText = document.getElementById('engineModeText');

const reloadCam1Btn = document.getElementById('reloadCam1Btn');
const reloadCam2Btn = document.getElementById('reloadCam2Btn');

const cam1StatusDot = document.getElementById('cam1StatusDot');
const cam1ResBadge = document.getElementById('cam1ResBadge');
const cam1FpsBadge = document.getElementById('cam1FpsBadge');

const cam2StatusDot = document.getElementById('cam2StatusDot');
const cam2ResBadge = document.getElementById('cam2ResBadge');
const cam2FpsBadge = document.getElementById('cam2FpsBadge');

const motionAlertCam1 = document.getElementById('motionAlertCam1');
const aiAlertCam1 = document.getElementById('aiAlertCam1');
const aiAlertMsgCam1 = document.getElementById('aiAlertMsgCam1');

const motionAlertCam2 = document.getElementById('motionAlertCam2');
const aiAlertCam2 = document.getElementById('aiAlertCam2');
const aiAlertMsgCam2 = document.getElementById('aiAlertMsgCam2');

// Control de Calidad y Eficiencia de Red para Video en Vivo
const isMobileDevice = /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(navigator.userAgent) || window.innerWidth <= 768;
const BLANK_FRAME = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9"%3E%3C/svg%3E';

// Motor de Reproducción: 'mjpeg' (Flujo Directo Nativo) o 'canvas' (Cero Lag GPU)
let playerEngine = localStorage.getItem('player_engine');
if (!playerEngine || (!isMobileDevice && playerEngine === 'canvas')) {
    playerEngine = 'mjpeg';
    localStorage.setItem('player_engine', 'mjpeg');
}

// Gestión de resolución en tiempo real (por cámara y global)
function normalizeQuality(q) {
    if (!q) return '480p';
    q = q.toLowerCase().trim();
    if (q === 'mobile' || q === '360' || q === '360p' || q === 'low') return '360p';
    if (q === 'efficient' || q === '480' || q === '480p' || q === '540' || q === '540p' || q === 'med') return '480p';
    if (q === 'balanced' || q === '720' || q === '720p' || q === 'hd') return '720p';
    if (q === 'original' || q === '1080' || q === '1080p' || q === 'fhd') return '1080p';
    return '480p';
}

function getCameraQuality(cid) {
    if (isMobileDevice) return '360p';
    const key = `camera_stream_quality_${cid}`;
    const saved = localStorage.getItem(key);
    if (saved) return normalizeQuality(saved);
    
    // Si hay una preferencia global previa, respetarla
    const globalQ = localStorage.getItem('camera_stream_quality');
    if (globalQ) return normalizeQuality(globalQ);

    // Por defecto seguro: 480p para fluidez total sin saturación de red WiFi
    return '480p';
}

function setCameraQuality(cid, quality) {
    const norm = normalizeQuality(quality);
    localStorage.setItem(`camera_stream_quality_${cid}`, norm);
    console.log(`📶 [${cid}] Calidad en vivo establecida a: ${norm}`);
    
    const sel = document.getElementById(`qualitySelect${cid.charAt(0).toUpperCase() + cid.slice(1)}`);
    if (sel && sel.value !== norm) {
        sel.value = norm;
    }
    
    updateGlobalQualityDropdown();
    refreshCameraFeed(cid, true);
}

function setGlobalQuality(quality) {
    const norm = normalizeQuality(quality);
    localStorage.setItem('camera_stream_quality', norm);
    localStorage.setItem('camera_stream_quality_cam1', norm);
    localStorage.setItem('camera_stream_quality_cam2', norm);
    
    const sel1 = document.getElementById('qualitySelectCam1');
    if (sel1) sel1.value = norm;
    const sel2 = document.getElementById('qualitySelectCam2');
    if (sel2) sel2.value = norm;
    
    console.log(`📶 Calidad global en vivo establecida a: ${norm}`);
    refreshActiveFeeds(true);
}

const streamQualitySelect = document.getElementById('streamQualitySelect');
const qualitySelectCam1 = document.getElementById('qualitySelectCam1');
const qualitySelectCam2 = document.getElementById('qualitySelectCam2');

function updateGlobalQualityDropdown() {
    if (!streamQualitySelect) return;
    const q1 = getCameraQuality('cam1');
    const q2 = getCameraQuality('cam2');
    if (q1 === q2) {
        streamQualitySelect.value = q1;
    } else {
        streamQualitySelect.value = '';
    }
}

let canvasLoopRunning = false;
let canvasFid = { cam1: 0, cam2: 0 };
let canvasFetching = { cam1: false, cam2: false };
let canvasFps = { cam1: 0, cam2: 0 };
let canvasFrameCount = { cam1: 0, cam2: 0 };
let canvasLastFpsTime = { cam1: performance.now(), cam2: performance.now() };

async function fetchCanvasFrame(cid) {
    if (!canvasLoopRunning || playerEngine !== 'canvas') return;
    if (canvasFetching[cid]) return;

    if (isMobileDevice) {
        if (currentViewMode === 'cam1' && cid !== 'cam1') return;
        if (currentViewMode === 'cam2' && cid !== 'cam2') return;
    }

    const canvasEl = cid === 'cam1' ? canvasFeedCam1 : canvasFeedCam2;
    const ctx = cid === 'cam1' ? ctxCam1 : ctxCam2;
    if (!canvasEl || !ctx) return;

    canvasFetching[cid] = true;
    const abortCtrl = new AbortController();
    const timeoutId = setTimeout(() => abortCtrl.abort(), 1200);

    try {
        const lastFid = canvasFid[cid] || 0;
        const q = getCameraQuality(cid);
        const url = lastFid > 0
            ? `/api/camera/${cid}/live_frame?quality=${q}&since_fid=${lastFid}&t=${Date.now()}`
            : `/api/camera/${cid}/live_frame?quality=${q}&t=${Date.now()}`;

        const res = await fetch(url, { cache: 'no-store', signal: abortCtrl.signal });
        clearTimeout(timeoutId);

        if (res.status === 304 || res.status === 204) {
            canvasFetching[cid] = false;
            setTimeout(() => {
                if (canvasLoopRunning && playerEngine === 'canvas') {
                    requestAnimationFrame(() => fetchCanvasFrame(cid));
                }
            }, 30);
            return;
        }

        if (res.ok && res.status === 200) {
            const fid = res.headers.get('X-Frame-ID');
            if (fid) canvasFid[cid] = parseInt(fid, 10);

            const blob = await res.blob();
            if (blob.size > 200) {
                if ('createImageBitmap' in window) {
                    try {
                        const bitmap = await createImageBitmap(blob);
                        if (canvasEl.width !== bitmap.width || canvasEl.height !== bitmap.height) {
                            canvasEl.width = bitmap.width;
                            canvasEl.height = bitmap.height;
                        }
                        ctx.drawImage(bitmap, 0, 0);
                        bitmap.close();
                    } catch (e) {}
                } else {
                    await new Promise((resolve) => {
                        const img = new Image();
                        const bUrl = URL.createObjectURL(blob);
                        img.onload = () => {
                            if (canvasEl.width !== img.naturalWidth || canvasEl.height !== img.naturalHeight) {
                                canvasEl.width = img.naturalWidth;
                                canvasEl.height = img.naturalHeight;
                            }
                            ctx.drawImage(img, 0, 0);
                            URL.revokeObjectURL(bUrl);
                            resolve();
                        };
                        img.onerror = () => { URL.revokeObjectURL(bUrl); resolve(); };
                        img.src = bUrl;
                    });
                }

                // Cálculo de FPS reales en el cliente
                const now = performance.now();
                canvasFrameCount[cid]++;
                if (now - canvasLastFpsTime[cid] >= 1000) {
                    canvasFps[cid] = ((canvasFrameCount[cid] * 1000) / (now - canvasLastFpsTime[cid])).toFixed(1);
                    canvasFrameCount[cid] = 0;
                    canvasLastFpsTime[cid] = now;
                    const badge = cid === 'cam1' ? cam1FpsBadge : cam2FpsBadge;
                    if (badge) badge.textContent = `${canvasFps[cid]} fps`;
                }

                canvasFetching[cid] = false;
                if (canvasLoopRunning && playerEngine === 'canvas') {
                    requestAnimationFrame(() => fetchCanvasFrame(cid));
                }
                return;
            }
        }
    } catch (e) {
    } finally {
        clearTimeout(timeoutId);
    }

    canvasFetching[cid] = false;
    setTimeout(() => {
        if (canvasLoopRunning && playerEngine === 'canvas') {
            requestAnimationFrame(() => fetchCanvasFrame(cid));
        }
    }, 40);
}

function startCanvasLoops() {
    canvasLoopRunning = true;
    requestAnimationFrame(() => fetchCanvasFrame('cam1'));
    requestAnimationFrame(() => fetchCanvasFrame('cam2'));
}

function stopCanvasLoops() {
    canvasLoopRunning = false;
    canvasFetching.cam1 = false;
    canvasFetching.cam2 = false;
}

function updateEngineUI() {
    const isCanvas = (playerEngine === 'canvas');
    if (btnToggleEngine) {
        btnToggleEngine.classList.toggle('active', isCanvas);
        if (engineModeIcon) engineModeIcon.textContent = isCanvas ? '⚡' : '🌊';
        if (engineModeText) engineModeText.textContent = isCanvas ? 'Cero Lag (GPU)' : 'Flujo Directo';
    }

    if (canvasFeedCam1) canvasFeedCam1.style.display = isCanvas ? 'block' : 'none';
    if (canvasFeedCam2) canvasFeedCam2.style.display = isCanvas ? 'block' : 'none';
    if (videoFeedCam1) videoFeedCam1.style.display = isCanvas ? 'none' : 'block';
    if (videoFeedCam2) videoFeedCam2.style.display = isCanvas ? 'none' : 'block';

    if (isCanvas) {
        if (videoFeedCam1) videoFeedCam1.src = BLANK_FRAME;
        if (videoFeedCam2) videoFeedCam2.src = BLANK_FRAME;
        startCanvasLoops();
    } else {
        stopCanvasLoops();
        refreshActiveFeeds(true);
    }
}

if (btnToggleEngine) {
    btnToggleEngine.addEventListener('click', () => {
        playerEngine = (playerEngine === 'canvas') ? 'mjpeg' : 'canvas';
        localStorage.setItem('player_engine', playerEngine);
        updateEngineUI();
    });
}

function getFeedUrl(cid) {
    const q = getCameraQuality(cid);
    return `/video_feed/${cid}?quality=${q}&t=${Date.now()}`;
}

function refreshCameraFeed(cid, force = false) {
    if (playerEngine === 'canvas') {
        if (canvasLoopRunning) {
            canvasFetching[cid] = false;
            requestAnimationFrame(() => fetchCanvasFrame(cid));
        }
        return;
    }
    const imgEl = cid === 'cam1' ? videoFeedCam1 : videoFeedCam2;
    if (imgEl && (force || !imgEl.src || imgEl.src === BLANK_FRAME || !imgEl.src.includes(`/video_feed/${cid}`))) {
        imgEl.src = getFeedUrl(cid);
    }
    const reloadBtn = cid === 'cam1' ? reloadCam1Btn : reloadCam2Btn;
    if (reloadBtn) reloadBtn.style.display = 'none';
}

function refreshActiveFeeds(force = false) {
    if (playerEngine === 'canvas') {
        if (canvasLoopRunning) {
            canvasFetching.cam1 = false;
            canvasFetching.cam2 = false;
            requestAnimationFrame(() => fetchCanvasFrame('cam1'));
            requestAnimationFrame(() => fetchCanvasFrame('cam2'));
        }
        return;
    }

    if (isMobileDevice) {
        if (currentViewMode === 'cam2') {
            if (videoFeedCam2 && (!videoFeedCam2.src || !videoFeedCam2.src.includes('/video_feed/cam2') || force)) {
                videoFeedCam2.src = getFeedUrl('cam2');
            }
            if (videoFeedCam1 && videoFeedCam1.src !== BLANK_FRAME) {
                videoFeedCam1.src = BLANK_FRAME;
            }
        } else if (currentViewMode === 'cam1') {
            if (videoFeedCam1 && (!videoFeedCam1.src || !videoFeedCam1.src.includes('/video_feed/cam1') || force)) {
                videoFeedCam1.src = getFeedUrl('cam1');
            }
            if (videoFeedCam2 && videoFeedCam2.src !== BLANK_FRAME) {
                videoFeedCam2.src = BLANK_FRAME;
            }
        } else {
            if (videoFeedCam1 && (!videoFeedCam1.src || !videoFeedCam1.src.includes('/video_feed/cam1') || force)) {
                videoFeedCam1.src = getFeedUrl('cam1');
            }
            if (videoFeedCam2 && (!videoFeedCam2.src || !videoFeedCam2.src.includes('/video_feed/cam2') || force)) {
                videoFeedCam2.src = getFeedUrl('cam2');
            }
        }
    } else {
        if (videoFeedCam1 && (!videoFeedCam1.src || !videoFeedCam1.src.includes('/video_feed/cam1') || force)) {
            videoFeedCam1.src = getFeedUrl('cam1');
        }
        if (videoFeedCam2 && (!videoFeedCam2.src || !videoFeedCam2.src.includes('/video_feed/cam2') || force)) {
            videoFeedCam2.src = getFeedUrl('cam2');
        }
    }
    if (reloadCam1Btn) reloadCam1Btn.style.display = 'none';
    if (reloadCam2Btn) reloadCam2Btn.style.display = 'none';
}

function initQualityControls() {
    const q1 = getCameraQuality('cam1');
    const q2 = getCameraQuality('cam2');
    
    if (qualitySelectCam1) {
        qualitySelectCam1.value = q1;
        qualitySelectCam1.addEventListener('change', () => {
            setCameraQuality('cam1', qualitySelectCam1.value);
        });
    }
    
    if (qualitySelectCam2) {
        qualitySelectCam2.value = q2;
        qualitySelectCam2.addEventListener('change', () => {
            setCameraQuality('cam2', qualitySelectCam2.value);
        });
    }
    
    updateGlobalQualityDropdown();
    
    if (streamQualitySelect) {
        streamQualitySelect.addEventListener('change', () => {
            if (streamQualitySelect.value) {
                setGlobalQuality(streamQualitySelect.value);
            }
        });
    }
}

// Reanudar o pausar transmisiones con la visibilidad de la pestaña (ahorro total de CPU y red en segundo plano)
let lastVisibilityResumeTime = 0;
let isAppPageHidden = false;

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        isAppPageHidden = true;
        console.log('👁️ Pestaña en segundo plano: pausando transmisiones para liberar CPU y red...');
        if (playerEngine === 'canvas') {
            canvasLoopRunning = false;
        } else {
            if (videoFeedCam1 && videoFeedCam1.src && !videoFeedCam1.src.startsWith('data:')) {
                videoFeedCam1.src = BLANK_FRAME;
            }
            if (videoFeedCam2 && videoFeedCam2.src && !videoFeedCam2.src.startsWith('data:')) {
                videoFeedCam2.src = BLANK_FRAME;
            }
        }
    } else if (document.visibilityState === 'visible') {
        isAppPageHidden = false;
        const now = Date.now();
        if (now - lastVisibilityResumeTime > 1500) {
            lastVisibilityResumeTime = now;
            lastCam1FrameTime = now;
            lastCam2FrameTime = now;
            console.log('👁️ Pestaña activa: reanudando flujos de video en tiempo real...');
            if (playerEngine === 'canvas') {
                canvasLoopRunning = true;
                canvasFetching.cam1 = false;
                canvasFetching.cam2 = false;
                requestAnimationFrame(() => fetchCanvasFrame('cam1'));
                requestAnimationFrame(() => fetchCanvasFrame('cam2'));
            } else {
                refreshActiveFeeds(true);
            }
        }
    }
});

// Función para cambiar de vista (Mosaico Dual vs Individual)
function setViewMode(mode) {
    currentViewMode = mode;
    if (tabMosaic) tabMosaic.classList.toggle('active', mode === 'mosaic');
    if (tabCam1) tabCam1.classList.toggle('active', mode === 'cam1');
    if (tabCam2) tabCam2.classList.toggle('active', mode === 'cam2');

    if (mosaicContainer) {
        mosaicContainer.className = `mosaic-container mode-${mode}`;
    }

    if (activeViewTag) {
        if (mode === 'mosaic') activeViewTag.textContent = 'Vista Mosaico Dual';
        else if (mode === 'cam1') activeViewTag.textContent = 'Cámara 1: Tuya PTZ (Full)';
        else if (mode === 'cam2') activeViewTag.textContent = 'Cámara 2: iCam365 (Full)';
    }

    // En móvil, sincronizar feed activo para máxima fluidez y cero lag
    if (isMobileDevice) {
        refreshActiveFeeds();
    }
    if (playerEngine === 'canvas') {
        canvasFetching.cam1 = false;
        canvasFetching.cam2 = false;
        requestAnimationFrame(() => fetchCanvasFrame('cam1'));
        requestAnimationFrame(() => fetchCanvasFrame('cam2'));
    }

    // Ocultar botones de reconectar para que no queden visibles
    if (reloadCam1Btn) reloadCam1Btn.style.display = 'none';
    if (reloadCam2Btn) reloadCam2Btn.style.display = 'none';

    // Sincronizar objetivo PTZ con la vista activa
    const ptzControlBar = document.getElementById('ptzControlBar');
    if (ptzControlBar) {
        ptzControlBar.style.opacity = '1';
        ptzControlBar.style.pointerEvents = 'auto';
    }
    if (typeof setPtzTargetCamera === 'function') {
        if (mode === 'cam2') setPtzTargetCamera('cam2');
        else if (mode === 'cam1') setPtzTargetCamera('cam1');
    }
    if (typeof window.setPerCamConfigTab === 'function') {
        if (mode === 'cam2') window.setPerCamConfigTab('cam2');
        else if (mode === 'cam1') window.setPerCamConfigTab('cam1');
    }
    if (typeof syncToolbarWithActiveCamera === 'function') {
        syncToolbarWithActiveCamera();
    }
}

if (tabMosaic) tabMosaic.addEventListener('click', () => setViewMode('mosaic'));
if (tabCam1) tabCam1.addEventListener('click', () => setViewMode('cam1'));
if (tabCam2) tabCam2.addEventListener('click', () => setViewMode('cam2'));

document.querySelectorAll('.btn-expand-cam').forEach(btn => {
    btn.addEventListener('click', () => {
        const cam = btn.dataset.cam;
        if (cam) setViewMode(cam);
    });
});

// Alternar ocultar/mostrar panel lateral para agrandar cámaras
const toggleSidebarBtn = document.getElementById('toggleSidebarBtn');
const toggleSidebarIcon = document.getElementById('toggleSidebarIcon');
const toggleSidebarText = document.getElementById('toggleSidebarText');
const dashboardGrid = document.getElementById('dashboardGrid');

function updateSidebarState(isCollapsed) {
    if (!dashboardGrid) return;
    dashboardGrid.classList.toggle('sidebar-collapsed', isCollapsed);
    if (toggleSidebarBtn) toggleSidebarBtn.classList.toggle('is-collapsed', isCollapsed);
    if (toggleSidebarIcon) toggleSidebarIcon.textContent = isCollapsed ? '▶' : '◀';
    if (toggleSidebarText) toggleSidebarText.textContent = isCollapsed ? 'Mostrar Panel' : 'Ocultar Panel';
    localStorage.setItem('sidebar_collapsed', isCollapsed ? '1' : '0');
}

if (toggleSidebarBtn) {
    toggleSidebarBtn.addEventListener('click', () => {
        const isCollapsed = !dashboardGrid.classList.contains('sidebar-collapsed');
        updateSidebarState(isCollapsed);
    });

    if (localStorage.getItem('sidebar_collapsed') === '1') {
        updateSidebarState(true);
    }
}

// Watchdogs de reconexión y monitoreo de fluidez en tiempo real para ambas cámaras
let isRecoveringCam1 = false;
let isRecoveringCam2 = false;
let cam1FailCount = 0;
let cam2FailCount = 0;
let lastCam1FrameTime = Date.now();
let lastCam2FrameTime = Date.now();
let cam1ErrorTimer = null;
let cam2ErrorTimer = null;

function reloadCam1() {
    if (!videoFeedCam1 || isRecoveringCam1) return;
    if (isAppPageHidden) return; // No reconectar si la pestaña está oculta
    if (isMobileDevice && currentViewMode === 'cam2') return;
    isRecoveringCam1 = true;
    lastCam1FrameTime = Date.now();
    if (reloadCam1Btn) reloadCam1Btn.style.display = 'none';
    console.log('🔄 Reconectando Cámara 1...');
    videoFeedCam1.src = getFeedUrl('cam1');
    setTimeout(() => { isRecoveringCam1 = false; }, 2500);
}

function reloadCam2() {
    if (!videoFeedCam2 || isRecoveringCam2) return;
    if (isAppPageHidden) return; // No reconectar si la pestaña está oculta
    if (isMobileDevice && currentViewMode === 'cam1') return;
    isRecoveringCam2 = true;
    lastCam2FrameTime = Date.now();
    if (reloadCam2Btn) reloadCam2Btn.style.display = 'none';
    console.log('🔄 Reconectando Cámara 2...');
    videoFeedCam2.src = getFeedUrl('cam2');
    setTimeout(() => { isRecoveringCam2 = false; }, 2500);
}

if (videoFeedCam1) {
    videoFeedCam1.addEventListener('error', () => {
        if (!videoFeedCam1.src || videoFeedCam1.src.startsWith('data:') || isAppPageHidden) return;
        cam1FailCount++;
        if (cam1FailCount >= 3 && reloadCam1Btn && (!isMobileDevice || currentViewMode !== 'cam2')) {
            reloadCam1Btn.style.display = 'inline-flex';
        }
        clearTimeout(cam1ErrorTimer);
        cam1ErrorTimer = setTimeout(reloadCam1, Math.min(6000, 2000 * Math.max(1, cam1FailCount - 2)));
    });
    videoFeedCam1.addEventListener('load', () => {
        cam1FailCount = 0;
        if (reloadCam1Btn) reloadCam1Btn.style.display = 'none';
    });
    videoFeedCam1.addEventListener('click', reloadCam1);
}
if (reloadCam1Btn) reloadCam1Btn.addEventListener('click', reloadCam1);

if (videoFeedCam2) {
    videoFeedCam2.addEventListener('error', () => {
        if (!videoFeedCam2.src || videoFeedCam2.src.startsWith('data:') || isAppPageHidden) return;
        cam2FailCount++;
        if (cam2FailCount >= 3 && reloadCam2Btn && (!isMobileDevice || currentViewMode !== 'cam1')) {
            reloadCam2Btn.style.display = 'inline-flex';
        }
        clearTimeout(cam2ErrorTimer);
        cam2ErrorTimer = setTimeout(reloadCam2, Math.min(6000, 2000 * Math.max(1, cam2FailCount - 2)));
    });
    videoFeedCam2.addEventListener('load', () => {
        cam2FailCount = 0;
        if (reloadCam2Btn) reloadCam2Btn.style.display = 'none';
    });
    videoFeedCam2.addEventListener('click', reloadCam2);
}
if (reloadCam2Btn) reloadCam2Btn.addEventListener('click', reloadCam2);

const toggleContinuousBtn = document.getElementById('toggleContinuousBtn');
const toggleMotionBtn = document.getElementById('toggleMotionBtn');
const toggleObjectsBtn = document.getElementById('toggleObjectsBtn');
const toggleAiFilterBtn = document.getElementById('toggleAiFilterBtn');
const toggleTrackingBtn = document.getElementById('toggleTrackingBtn');
const trackingBanner = document.getElementById('trackingBanner');
const trackingBannerMsg = document.getElementById('trackingBannerMsg');
const ptzStatusChip = document.getElementById('ptzStatusChip');
const ptzStatusLabel = document.getElementById('ptzStatusLabel');
const snapshotBtn = document.getElementById('snapshotBtn');
const toggleSoundBtn = document.getElementById('toggleSoundBtn');

const contRecStatusBadge = document.getElementById('contRecStatusBadge');
const storagePathDisplay = document.getElementById('storagePathDisplay');
const storageFreeDisplay = document.getElementById('storageFreeDisplay');
const storagePercentDisplay = document.getElementById('storagePercentDisplay');
const storageProgressFill = document.getElementById('storageProgressFill');
const storageQuotaUsedDisplay = document.getElementById('storageQuotaUsedDisplay');
const storageQuotaLimitDisplay = document.getElementById('storageQuotaLimitDisplay');
const storageQuotaFill = document.getElementById('storageQuotaFill');
const storageRamDisplay = document.getElementById('storageRamDisplay');

const sensitivitySlider = document.getElementById('sensitivitySlider');
const sensValDisplay = document.getElementById('sensValDisplay');
const confidenceSlider = document.getElementById('confidenceSlider');
const confValDisplay = document.getElementById('confValDisplay');

const personCountEl = document.getElementById('personCount');
const vehicleCountEl = document.getElementById('vehicleCount');
const motionCountEl = document.getElementById('motionCount');
const alertCountEl = document.getElementById('alertCount');

const eventsListEl = document.getElementById('eventsList');
const clipsListEl = document.getElementById('clipsList');
const recordingsListEl = document.getElementById('recordingsList');
const clearEventsBtn = document.getElementById('clearEventsBtn');
const refreshRecordingsBtn = document.getElementById('refreshRecordingsBtn');
const tabEventsBtn = document.getElementById('tabEventsBtn');
const tabClipsBtn = document.getElementById('tabClipsBtn');
const tabRecordingsBtn = document.getElementById('tabRecordingsBtn');
const continuousIconEl = document.getElementById('continuousIcon');
const continuousTextEl = document.getElementById('continuousText');

const snapshotModal = document.getElementById('snapshotModal');
const modalBackdrop = document.getElementById('modalBackdrop');
const modalCloseBtn = document.getElementById('modalCloseBtn');
const modalTitle = document.getElementById('modalTitle');
const modalImage = document.getElementById('modalImage');
const modalVideo = document.getElementById('modalVideo');
const modalTabPhoto = document.getElementById('modalTabPhoto');
const modalTabVideo = document.getElementById('modalTabVideo');
const modalDownloadBtn = document.getElementById('modalDownloadBtn');
const modalDownloadVideoBtn = document.getElementById('modalDownloadVideoBtn');
const alertAudio = document.getElementById('alertAudio');
const shutdownBtn = document.getElementById('shutdownBtn');

if (shutdownBtn) {
    shutdownBtn.addEventListener('click', async () => {
        if (!confirm('¿Deseas apagar el sistema por completo? Se detendrá la grabación y el contenedor hasta que lo vuelvas a iniciar con ./start.sh.')) {
            return;
        }
        shutdownBtn.disabled = true;
        shutdownBtn.innerHTML = '<span class="icon">⏳</span> Apagando...';
        try {
            await fetch('/api/shutdown', { method: 'POST' });
            setTimeout(() => {
                cameraStatusEl.classList.remove('connected');
                statusTextEl.textContent = 'Apagado';
                alert('El sistema se ha apagado por completo. Para volver a encenderlo ejecuta ./start.sh');
            }, 1000);
        } catch (e) {
            console.error('Error shutting down:', e);
        }
    });
}

// ----------------- COPIAR ENLACE LOCAL -----------------
copyUrlBtn.addEventListener('click', async () => {
    const url = localUrlDisplayEl.textContent.trim();
    try {
        await navigator.clipboard.writeText(url);
        const originalText = copyUrlBtn.innerHTML;
        copyUrlBtn.innerHTML = '<span class="icon">✅</span> ¡Copiado!';
        setTimeout(() => {
            copyUrlBtn.innerHTML = originalText;
        }, 1500);
    } catch (e) {
        prompt('Copia esta URL en tu teléfono:', url);
    }
});

// ----------------- EVENTOS SSE EN TIEMPO REAL -----------------
function initSSE() {
    const eventSource = new EventSource('/events/stream');

    eventSource.onopen = () => {
        console.log('Canal de eventos SSE activo.');
    };

    eventSource.onerror = (e) => {
        console.warn('Reconectando canal SSE...');
    };

    eventSource.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleIncomingEvent(data);
        } catch (e) {
            // keepalive o parse ignorado
        }
    };
}

function handleIncomingEvent(data) {
    counts.alerts++;
    alertCountEl.textContent = counts.alerts;

    // Sonido de alerta si está habilitado
    if (soundEnabled && alertAudio) {
        try {
            alertAudio.currentTime = 0;
            alertAudio.play().catch(() => {});
        } catch (e) {}
    }

    const type = data.type || 'motion';
    const isAi = data.is_ai || false;
    const msg = data.message || 'Actividad detectada';
    const camId = data.camera_id || 'cam1';

    // Actualizar contadores por categoría
    if (type === 'person') {
        counts.person++;
        personCountEl.textContent = counts.person;
        triggerAiBanner(`🚶 ${msg}`, camId);
    } else if (['car', 'truck', 'motorcycle', 'bus', 'vehicle'].includes(type)) {
        counts.vehicle++;
        vehicleCountEl.textContent = counts.vehicle;
        triggerAiBanner(`🚗 ${msg}`, camId);
    } else {
        counts.motion++;
        motionCountEl.textContent = counts.motion;
        triggerMotionBanner(`⚠️ ${msg}`, camId);
    }

    // Agregar evento a la lista
    addEventToList(data);
}

function triggerMotionBanner(text, camId = 'cam1') {
    const banner = camId === 'cam2' ? motionAlertCam2 : motionAlertCam1;
    const msgEl = camId === 'cam2' ? motionAlertMsgCam2 : motionAlertMsgCam1;
    if (msgEl) msgEl.textContent = text;
    if (banner) {
        banner.style.display = 'flex';
        clearTimeout(banner._timeout);
        banner._timeout = setTimeout(() => { banner.style.display = 'none'; }, 3200);
    }
}

function triggerAiBanner(text, camId = 'cam1') {
    const banner = camId === 'cam2' ? aiAlertCam2 : aiAlertCam1;
    const msgEl = camId === 'cam2' ? aiAlertMsgCam2 : aiAlertMsgCam1;
    if (msgEl) msgEl.textContent = text;
    if (banner) {
        banner.style.display = 'flex';
        clearTimeout(banner._timeout);
        banner._timeout = setTimeout(() => { banner.style.display = 'none'; }, 4000);
    }
}

function addEventToList(data) {
    const emptyState = eventsListEl.querySelector('.no-events-state');
    if (emptyState) {
        emptyState.remove();
    }

    const type = data.type || 'motion';
    const isAi = data.is_ai;
    const dateObj = new Date(data.timestamp || Date.now());
    const timeStr = dateObj.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    let icon = '⚠️';
    if (type === 'person') icon = '🚶';
    else if (['car', 'truck', 'motorcycle', 'bus'].includes(type)) icon = '🚗';
    else if (['dog', 'cat'].includes(type)) icon = '🐾';

    const entry = document.createElement('div');
    entry.className = `event-entry ${isAi ? 'is-ai' : 'is-motion'}`;

    let thumbHtml = '';
    if (data.snapshot) {
        const clipParam = data.clip ? `'${data.clip}'` : "''";
        thumbHtml = `
            <div style="display: flex; align-items: center; gap: 0.4rem;">
                <img src="/snapshots/${data.snapshot}" class="event-thumb" title="Clic para ver en grande" alt="Snapshot" onclick="openSnapshotModal('/snapshots/${data.snapshot}', '${escapeHtml(data.message)}', ${clipParam})">
                ${data.clip ? `<button class="btn btn-xs btn-outline" title="Reproducir video" onclick="openSnapshotModal('/snapshots/${data.snapshot}', '${escapeHtml(data.message)}', ${clipParam}, true)">▶️ Video</button>` : ''}
            </div>
        `;
    }

    entry.innerHTML = `
        <span class="event-icon">${icon}</span>
        <div class="event-details">
            <div class="event-msg">${escapeHtml(data.message)}</div>
            <div class="event-meta">${timeStr} &bull; ${isAi ? 'IA Verificada' : 'Sensor'}</div>
        </div>
        ${thumbHtml}
    `;

    eventsListEl.insertBefore(entry, eventsListEl.firstChild);

    // Limitar a los 30 más recientes
    const all = eventsListEl.querySelectorAll('.event-entry');
    if (all.length > 30) {
        all[all.length - 1].remove();
    }
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

// ----------------- MODAL DE SNAPSHOTS Y VIDEOS DE EVENTOS -----------------
window.openSnapshotModal = function(photoUrl, title, clipUrl, startWithVideo = false) {
    modalTitle.textContent = title || 'Registro de Actividad';

    // Configurar foto
    if (photoUrl) {
        modalImage.src = photoUrl;
        modalDownloadBtn.href = photoUrl;
        modalDownloadBtn.style.display = 'inline-flex';
    } else {
        modalImage.src = '';
        modalDownloadBtn.style.display = 'none';
    }

    // Configurar video del clip
    if (clipUrl) {
        modalVideo.src = clipUrl;
        modalTabVideo.style.display = 'inline-block';
        modalDownloadVideoBtn.href = clipUrl;
        modalDownloadVideoBtn.style.display = 'inline-flex';
    } else {
        modalVideo.src = '';
        modalTabVideo.style.display = 'none';
        modalDownloadVideoBtn.style.display = 'none';
    }

    if (startWithVideo && clipUrl) {
        showVideoTab();
    } else {
        showPhotoTab();
    }

    snapshotModal.style.display = 'flex';
};

let liveFeedsSuspendedForPlayback = false;

function pauseLiveFeedsForPlayback() {
    if (liveFeedsSuspendedForPlayback) return;
    if (videoFeedCam1 && videoFeedCam1.src && !videoFeedCam1.src.startsWith('data:')) {
        videoFeedCam1.dataset.savedPlaybackSrc = videoFeedCam1.src;
        videoFeedCam1.src = BLANK_FRAME;
    }
    if (videoFeedCam2 && videoFeedCam2.src && !videoFeedCam2.src.startsWith('data:')) {
        videoFeedCam2.dataset.savedPlaybackSrc = videoFeedCam2.src;
        videoFeedCam2.src = BLANK_FRAME;
    }
    liveFeedsSuspendedForPlayback = true;
}

function resumeLiveFeedsAfterPlayback() {
    if (!liveFeedsSuspendedForPlayback) return;
    if (videoFeedCam1 && videoFeedCam1.dataset.savedPlaybackSrc) {
        videoFeedCam1.src = videoFeedCam1.dataset.savedPlaybackSrc;
        delete videoFeedCam1.dataset.savedPlaybackSrc;
    }
    if (videoFeedCam2 && videoFeedCam2.dataset.savedPlaybackSrc) {
        videoFeedCam2.src = videoFeedCam2.dataset.savedPlaybackSrc;
        delete videoFeedCam2.dataset.savedPlaybackSrc;
    }
    liveFeedsSuspendedForPlayback = false;
}

function showPhotoTab() {
    resumeLiveFeedsAfterPlayback();
    modalImage.style.display = 'block';
    modalVideo.style.display = 'none';
    modalVideo.pause();
    modalTabPhoto.classList.add('active');
    modalTabVideo.classList.remove('active');
}

function showVideoTab() {
    pauseLiveFeedsForPlayback();
    modalImage.style.display = 'none';
    modalVideo.style.display = 'block';
    modalTabVideo.classList.add('active');
    modalTabPhoto.classList.remove('active');
    modalVideo.play().catch(() => {});
}

modalTabPhoto.addEventListener('click', showPhotoTab);
modalTabVideo.addEventListener('click', showVideoTab);

function closeModal() {
    snapshotModal.style.display = 'none';
    modalImage.src = '';
    modalVideo.pause();
    modalVideo.removeAttribute('src');
    modalVideo.load();
    resumeLiveFeedsAfterPlayback();
}

modalCloseBtn.addEventListener('click', closeModal);
modalBackdrop.addEventListener('click', closeModal);
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && snapshotModal.style.display === 'flex') {
        closeModal();
    }
});

// Navegación de lista de reproducción dentro del modal de previsualización
let modalPlaylist = [];
let modalPlaylistIndex = -1;
let rawClipsCache = [];
let rawContinuousCache = [];

const sidebarFilterBar = document.getElementById('sidebarFilterBar');
const sidebarDateSelect = document.getElementById('sidebarDateSelect');
const sidebarHourSelect = document.getElementById('sidebarHourSelect');
const modalPrevBtn = document.getElementById('modalPrevBtn');
const modalNextBtn = document.getElementById('modalNextBtn');
const modalCounter = document.getElementById('modalCounter');

function updateModalNavUI() {
    if (!modalCounter) return;
    if (modalPlaylist.length > 0 && modalPlaylistIndex >= 0) {
        modalCounter.textContent = `${modalPlaylistIndex + 1} / ${modalPlaylist.length}`;
        if (modalPrevBtn) modalPrevBtn.disabled = modalPlaylistIndex <= 0;
        if (modalNextBtn) modalNextBtn.disabled = modalPlaylistIndex >= modalPlaylist.length - 1;
    } else {
        modalCounter.textContent = '1 / 1';
        if (modalPrevBtn) modalPrevBtn.disabled = true;
        if (modalNextBtn) modalNextBtn.disabled = true;
    }
}

function playModalPlaylistIndex(idx) {
    if (idx < 0 || idx >= modalPlaylist.length) return;
    modalPlaylistIndex = idx;
    const item = modalPlaylist[idx];
    updateModalNavUI();
    window.openSnapshotModal(item.photoUrl || '', item.title || item.filename, item.clipUrl || item.url, true);
}

if (modalPrevBtn) {
    modalPrevBtn.addEventListener('click', () => {
        if (modalPlaylistIndex > 0) playModalPlaylistIndex(modalPlaylistIndex - 1);
    });
}
if (modalNextBtn) {
    modalNextBtn.addEventListener('click', () => {
        if (modalPlaylistIndex < modalPlaylist.length - 1) playModalPlaylistIndex(modalPlaylistIndex + 1);
    });
}
if (modalVideo) {
    modalVideo.addEventListener('ended', () => {
        if (modalPlaylistIndex >= 0 && modalPlaylistIndex < modalPlaylist.length - 1) {
            playModalPlaylistIndex(modalPlaylistIndex + 1);
        }
    });
}

function populateSidebarHours(items) {
    if (!sidebarHourSelect) return;
    const currentVal = sidebarHourSelect.value;
    const hoursFound = new Set();
    items.forEach(item => {
        const m = (item.filename || '').match(/_(\d{2})\d{4}\./);
        if (m) hoursFound.add(parseInt(m[1], 10));
    });

    sidebarHourSelect.innerHTML = '<option value="all">🕒 24 Horas</option>';
    Array.from(hoursFound).sort((a, b) => a - b).forEach(h => {
        const opt = document.createElement('option');
        opt.value = h;
        opt.textContent = `⏰ ${String(h).padStart(2, '0')}:00 hrs`;
        sidebarHourSelect.appendChild(opt);
    });
    if (hoursFound.has(parseInt(currentVal, 10))) {
        sidebarHourSelect.value = currentVal;
    }
}

function filterSidebarList(items) {
    const dMode = sidebarDateSelect ? sidebarDateSelect.value : 'today';
    const hMode = sidebarHourSelect ? sidebarHourSelect.value : 'all';
    
    const todayStr = new Date().toISOString().slice(0, 10);
    const yestDate = new Date();
    yestDate.setDate(yestDate.getDate() - 1);
    const yestStr = yestDate.toISOString().slice(0, 10);

    return items.filter(item => {
        if (dMode === 'today' && item.day !== todayStr) return false;
        if (dMode === 'yesterday' && item.day !== yestStr) return false;
        if (hMode !== 'all') {
            const m = (item.filename || '').match(/_(\d{2})\d{4}\./);
            if (m && parseInt(m[1], 10) !== parseInt(hMode, 10)) return false;
        }
        return true;
    });
}

if (sidebarDateSelect) {
    sidebarDateSelect.addEventListener('change', () => {
        if (tabClipsBtn && tabClipsBtn.classList.contains('active')) renderFilteredClips();
        else if (tabRecordingsBtn && tabRecordingsBtn.classList.contains('active')) renderFilteredContinuous();
    });
}
if (sidebarHourSelect) {
    sidebarHourSelect.addEventListener('change', () => {
        if (tabClipsBtn && tabClipsBtn.classList.contains('active')) renderFilteredClips();
        else if (tabRecordingsBtn && tabRecordingsBtn.classList.contains('active')) renderFilteredContinuous();
    });
}

// ----------------- PESTAÑAS DEL PANEL LATERAL (ALERTAS, CLIPS Y 24/7) -----------------
async function loadClips() {
    if (!clipsListEl) return;
    clipsListEl.innerHTML = `
        <div class="no-events-state">
            <span class="empty-icon">⏳</span>
            <p>Cargando videos de eventos...</p>
        </div>
    `;
    try {
        const res = await fetch('/api/clips');
        rawClipsCache = await res.json();
        populateSidebarHours(rawClipsCache);
        renderFilteredClips();
    } catch (e) {
        clipsListEl.innerHTML = `
            <div class="no-events-state">
                <span class="empty-icon">⚠️</span>
                <p>Error cargando videos de eventos.</p>
            </div>
        `;
    }
}

let clipsDisplayLimit = 25;
let continuousDisplayLimit = 25;

function renderFilteredClips() {
    if (!clipsListEl) return;
    const list = filterSidebarList(rawClipsCache);

    if (!list || list.length === 0) {
        clipsListEl.innerHTML = `
            <div class="no-events-state">
                <span class="empty-icon">🎬</span>
                <p>No hay videos en este horario.<br><small style="color:var(--text-muted)">Prueba seleccionando "Todo" o cambiando la hora.</small></p>
            </div>
        `;
        return;
    }

    clipsListEl.innerHTML = '';
    const visibleList = list.slice(0, clipsDisplayLimit);
    visibleList.forEach((item, idx) => {
        const entry = document.createElement('div');
        entry.className = 'event-entry is-ai';
        
        let timeLabel = '';
        const m = (item.filename || '').match(/_(\d{2})(\d{2})(\d{2})\./);
        if (m) timeLabel = `⏰ ${m[1]}:${m[2]}:${m[3]} • `;

        entry.innerHTML = `
            <span class="event-icon">🎬</span>
            <div class="event-details">
                <div class="event-msg" style="font-weight: 600;">${escapeHtml(item.filename)}</div>
                <div class="event-meta">${timeLabel}${item.day} &bull; ${item.size_mb} MB</div>
            </div>
            <div style="display: flex; gap: 0.3rem; align-items: center;">
                <button class="btn btn-xs btn-primary btn-view-clip" title="Reproducir video">▶️ Ver</button>
                <a href="${item.url}" download class="btn btn-xs btn-outline" title="Descargar clip MP4">⬇️</a>
            </div>
        `;
        
        entry.querySelector('.btn-view-clip').addEventListener('click', () => {
            modalPlaylist = list.map(x => ({
                filename: x.filename,
                title: x.filename,
                url: x.url,
                clipUrl: x.url,
                photoUrl: ''
            }));
            modalPlaylistIndex = idx;
            updateModalNavUI();
            openSnapshotModal('', item.filename, item.url, true);
        });

        clipsListEl.appendChild(entry);
    });

    if (list.length > clipsDisplayLimit) {
        const loadMore = document.createElement('button');
        loadMore.className = 'btn btn-xs btn-outline';
        loadMore.style.cssText = 'width: 100%; margin: 0.5rem 0; padding: 0.45rem; text-align: center;';
        loadMore.innerHTML = `➕ Cargar más videos (${list.length - clipsDisplayLimit} restantes)`;
        loadMore.addEventListener('click', () => {
            clipsDisplayLimit += 25;
            renderFilteredClips();
        });
        clipsListEl.appendChild(loadMore);
    }
}

async function loadContinuousRecordings() {
    if (!recordingsListEl) return;
    continuousDisplayLimit = 25;
    recordingsListEl.innerHTML = `
        <div class="no-events-state">
            <span class="empty-icon">⏳</span>
            <p>Cargando grabaciones 24/7 en disco...</p>
        </div>
    `;
    try {
        const res = await fetch('/api/recordings/continuous');
        rawContinuousCache = await res.json();
        populateSidebarHours(rawContinuousCache);
        renderFilteredContinuous();
    } catch (e) {
        recordingsListEl.innerHTML = `
            <div class="no-events-state">
                <span class="empty-icon">⚠️</span>
                <p>Error cargando grabaciones.</p>
            </div>
        `;
    }
}

function renderFilteredContinuous() {
    if (!recordingsListEl) return;
    const list = filterSidebarList(rawContinuousCache);

    if (!list || list.length === 0) {
        recordingsListEl.innerHTML = `
            <div class="no-events-state">
                <span class="empty-icon">📼</span>
                <p>No hay grabaciones continuas en este horario.<br><small style="color:var(--text-muted)">Prueba cambiando la hora o fecha.</small></p>
            </div>
        `;
        return;
    }

    recordingsListEl.innerHTML = '';
    const visibleList = list.slice(0, continuousDisplayLimit);
    visibleList.forEach((item, idx) => {
        const entry = document.createElement('div');
        entry.className = 'event-entry is-motion';

        let timeLabel = '';
        const m = (item.filename || '').match(/_(\d{2})(\d{2})(\d{2})\./);
        if (m) timeLabel = `⏰ ${m[1]}:${m[2]}:${m[3]} • `;

        entry.innerHTML = `
            <span class="event-icon">📼</span>
            <div class="event-details">
                <div class="event-msg" style="font-weight: 600;">${escapeHtml(item.filename)}</div>
                <div class="event-meta">${timeLabel}${item.day} &bull; ${item.size_mb} MB</div>
            </div>
            <div style="display: flex; gap: 0.3rem; align-items: center;">
                <button class="btn btn-xs btn-primary btn-view-cont" title="Reproducir video">▶️ Ver</button>
                <a href="${item.url}" download class="btn btn-xs btn-outline" title="Descargar archivo MP4">⬇️</a>
            </div>
        `;

        entry.querySelector('.btn-view-cont').addEventListener('click', () => {
            modalPlaylist = list.map(x => ({
                filename: x.filename,
                title: x.filename,
                url: x.url,
                clipUrl: x.url,
                photoUrl: ''
            }));
            modalPlaylistIndex = idx;
            updateModalNavUI();
            openSnapshotModal('', item.filename, item.url, true);
        });

        recordingsListEl.appendChild(entry);
    });

    if (list.length > continuousDisplayLimit) {
        const loadMore = document.createElement('button');
        loadMore.className = 'btn btn-xs btn-outline';
        loadMore.style.cssText = 'width: 100%; margin: 0.5rem 0; padding: 0.45rem; text-align: center;';
        loadMore.innerHTML = `➕ Cargar más grabaciones (${list.length - continuousDisplayLimit} restantes)`;
        loadMore.addEventListener('click', () => {
            continuousDisplayLimit += 25;
            renderFilteredContinuous();
        });
        recordingsListEl.appendChild(loadMore);
    }
}

function switchSidebarTab(tabName) {
    tabEventsBtn.classList.toggle('active', tabName === 'events');
    if (tabClipsBtn) tabClipsBtn.classList.toggle('active', tabName === 'clips');
    tabRecordingsBtn.classList.toggle('active', tabName === 'recordings');

    eventsListEl.style.display = tabName === 'events' ? 'flex' : 'none';
    if (clipsListEl) clipsListEl.style.display = tabName === 'clips' ? 'flex' : 'none';
    recordingsListEl.style.display = tabName === 'recordings' ? 'flex' : 'none';

    clearEventsBtn.style.display = tabName === 'events' ? 'inline-flex' : 'none';
    if (refreshRecordingsBtn) refreshRecordingsBtn.style.display = tabName !== 'events' ? 'inline-flex' : 'none';
    if (sidebarFilterBar) sidebarFilterBar.style.display = (tabName === 'clips' || tabName === 'recordings') ? 'flex' : 'none';

    if (tabName === 'clips') loadClips();
    if (tabName === 'recordings') loadContinuousRecordings();
}

if (tabEventsBtn) tabEventsBtn.addEventListener('click', () => switchSidebarTab('events'));
if (tabClipsBtn) tabClipsBtn.addEventListener('click', () => switchSidebarTab('clips'));
if (tabRecordingsBtn) tabRecordingsBtn.addEventListener('click', () => switchSidebarTab('recordings'));

if (refreshRecordingsBtn) {
    refreshRecordingsBtn.addEventListener('click', () => {
        if (tabClipsBtn && tabClipsBtn.classList.contains('active')) {
            loadClips();
        } else {
            loadContinuousRecordings();
        }
    });
}

// ----------------- CONTROLES DE LA BARRA DE HERRAMIENTAS VINCULADOS A LA CÁMARA ACTIVA -----------------
const trackingTextEl = document.getElementById('trackingText');
window.isYoloActive = true;

function getActiveCameraId() {
    if (currentViewMode === 'cam2') return 'cam2';
    if (currentViewMode === 'cam1') return 'cam1';
    return selectedConfigCam || 'cam1';
}

function syncToolbarWithActiveCamera() {
    const cid = getActiveCameraId();
    const cam = (camerasCache && camerasCache[cid]) || {};
    const camName = cid === 'cam2' ? 'Cámara 2 (iCam365)' : 'Cámara 1 (Tuya PTZ)';

    // 1. Grabación Continua 24/7 vs Solo Eventos
    const isCont = !!cam.continuous_recording;
    if (toggleContinuousBtn) {
        toggleContinuousBtn.classList.toggle('active', isCont);
        if (continuousIconEl) continuousIconEl.textContent = isCont ? '📼' : '🎯';
        if (continuousTextEl) continuousTextEl.textContent = isCont ? 'Grabar 24/7' : 'Solo Eventos';
        toggleContinuousBtn.title = isCont 
            ? `Grabación Continua 24/7 ACTIVA en ${camName}. Clic para cambiar a Solo Eventos` 
            : `Modo Solo Eventos ACTIVO en ${camName}. Clic para Grabar 24/7`;
    }

    // 2. Detección de Movimiento
    const isMotion = cam.motion_detection !== false;
    if (toggleMotionBtn) {
        toggleMotionBtn.classList.toggle('active', isMotion);
        const lbl = toggleMotionBtn.querySelector('span:last-child');
        if (lbl) lbl.textContent = isMotion ? 'Movimiento' : 'Movimiento OFF';
        toggleMotionBtn.title = isMotion 
            ? `Detección de Movimiento ACTIVA en ${camName}` 
            : `Detección de Movimiento DESACTIVADA en ${camName}`;
    }

    // 3. IA YOLOv8
    if (toggleObjectsBtn) {
        toggleObjectsBtn.classList.toggle('active', window.isYoloActive !== false);
    }

    // 4. Filtro IA Inteligente
    const isAiFilter = cam.ai_filter !== false;
    if (toggleAiFilterBtn) {
        toggleAiFilterBtn.classList.toggle('active', isAiFilter);
        const lbl = toggleAiFilterBtn.querySelector('span:last-child');
        if (lbl) lbl.textContent = isAiFilter ? 'Filtro IA' : 'Filtro IA OFF';
        toggleAiFilterBtn.title = isAiFilter 
            ? `Filtro IA ACTIVO en ${camName} (Solo personas/vehículos)` 
            : `Filtro IA DESACTIVADO en ${camName} (Cualquier movimiento)`;
    }

    // 5. Auto-Tracking
    const isTracking = cam.auto_tracking !== false;
    if (toggleTrackingBtn) {
        toggleTrackingBtn.classList.toggle('active', isTracking);
        if (trackingTextEl) trackingTextEl.textContent = isTracking ? 'Auto-Tracking' : 'Tracking OFF';
        toggleTrackingBtn.title = isTracking 
            ? `Auto-Tracking ACTIVO en ${camName}` 
            : `Auto-Tracking DESACTIVADO en ${camName}`;
        if (ptzStatusLabel && selectedPtzCamera === cid) {
            ptzStatusLabel.textContent = isTracking ? `${camName} (Tracking ON)` : `${camName} (Tracking OFF)`;
        }
    }

    // 6. Sincronizar switches en tarjeta lateral si coincide
    if (selectedConfigCam === cid) {
        const cfgMotionSwitch = document.getElementById('cfgMotionSwitch');
        const cfgEventRecSwitch = document.getElementById('cfgEventRecSwitch');
        const cfgTrackingSwitch = document.getElementById('cfgTrackingSwitch');
        const cfgAiFilterSwitch = document.getElementById('cfgAiFilterSwitch');
        const cfgContRecSwitch = document.getElementById('cfgContRecSwitch');
        const cfgSensSlider = document.getElementById('cfgSensSlider');
        const cfgSensValText = document.getElementById('cfgSensValText');

        if (cfgMotionSwitch) cfgMotionSwitch.checked = isMotion;
        if (cfgEventRecSwitch) cfgEventRecSwitch.checked = cam.event_recording !== false;
        if (cfgTrackingSwitch) cfgTrackingSwitch.checked = isTracking;
        if (cfgAiFilterSwitch) cfgAiFilterSwitch.checked = isAiFilter;
        if (cfgContRecSwitch) cfgContRecSwitch.checked = isCont;
        if (cfgSensSlider && cam.motion_threshold) {
            cfgSensSlider.value = cam.motion_threshold;
            if (cfgSensValText) cfgSensValText.textContent = cam.motion_threshold;
        }
    }

    // 7. Badge de grabación continua en la barra de almacenamiento
    const contRecStatusBadge = document.getElementById('contRecStatusBadge');
    if (contRecStatusBadge) {
        contRecStatusBadge.textContent = isCont ? 'ACTIVA' : 'SOLO EVENTOS';
        contRecStatusBadge.className = isCont ? 'badge-status-on' : 'badge-status-off';
    }
}

window.syncToolbarWithActiveCamera = syncToolbarWithActiveCamera;

// Clic en Grabar 24/7 vs Solo Eventos
toggleContinuousBtn.addEventListener('click', async () => {
    const cid = getActiveCameraId();
    const curr = !!(camerasCache[cid]?.continuous_recording);
    const next = !curr;
    if (!camerasCache[cid]) camerasCache[cid] = {};
    camerasCache[cid].continuous_recording = next;
    syncToolbarWithActiveCamera();

    try {
        const res = await fetch(`/api/camera/${cid}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ continuous_recording: next })
        });
        const data = await res.json();
        if (data.success) {
            Object.assign(camerasCache[cid], data.settings);
            syncToolbarWithActiveCamera();
        }
    } catch (e) {
        console.error('Error actualizando grabación continua:', e);
    }
});

// Clic en Movimiento
toggleMotionBtn.addEventListener('click', async () => {
    const cid = getActiveCameraId();
    const curr = camerasCache[cid] ? (camerasCache[cid].motion_detection !== false) : true;
    const next = !curr;
    if (!camerasCache[cid]) camerasCache[cid] = {};
    camerasCache[cid].motion_detection = next;
    syncToolbarWithActiveCamera();

    try {
        const res = await fetch(`/api/camera/${cid}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ motion_detection: next })
        });
        const data = await res.json();
        if (data.success) {
            Object.assign(camerasCache[cid], data.settings);
            syncToolbarWithActiveCamera();
        }
    } catch (e) {
        console.error('Error actualizando detección de movimiento:', e);
    }
});

// Clic en IA YOLOv8
toggleObjectsBtn.addEventListener('click', async () => {
    try {
        const res = await fetch('/api/toggle-objects', { method: 'POST' });
        const data = await res.json();
        window.isYoloActive = data.active;
        toggleObjectsBtn.classList.toggle('active', data.active);
    } catch (e) {
        console.error('Error toggling objects:', e);
    }
});

// Clic en Filtro IA
toggleAiFilterBtn.addEventListener('click', async () => {
    const cid = getActiveCameraId();
    const curr = camerasCache[cid] ? (camerasCache[cid].ai_filter !== false) : true;
    const next = !curr;
    if (!camerasCache[cid]) camerasCache[cid] = {};
    camerasCache[cid].ai_filter = next;
    syncToolbarWithActiveCamera();

    try {
        const res = await fetch(`/api/camera/${cid}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ai_filter: next })
        });
        const data = await res.json();
        if (data.success) {
            Object.assign(camerasCache[cid], data.settings);
            syncToolbarWithActiveCamera();
        }
    } catch (e) {
        console.error('Error toggling AI filter:', e);
    }
});

// Clic en Auto-Tracking
if (toggleTrackingBtn) {
    toggleTrackingBtn.addEventListener('click', async () => {
        const cid = getActiveCameraId();
        const curr = camerasCache[cid] ? (camerasCache[cid].auto_tracking !== false) : true;
        const next = !curr;
        if (!camerasCache[cid]) camerasCache[cid] = {};
        camerasCache[cid].auto_tracking = next;
        syncToolbarWithActiveCamera();

        try {
            const res = await fetch(`/api/camera/${cid}/settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ auto_tracking: next })
            });
            const data = await res.json();
            if (data.success) {
                Object.assign(camerasCache[cid], data.settings);
                syncToolbarWithActiveCamera();
            }
        } catch (e) {
            console.error('Error toggling auto-tracking:', e);
        }
    });
}

// ----------------- CONTROL MANUAL PTZ (CRUCETA D-PAD) -----------------
let activePtzDir = null;
let selectedPtzCamera = 'cam1';

async function sendPtzMove(direction) {
    try {
        await fetch('/api/ptz/move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ direction, camera_id: selectedPtzCamera })
        });
    } catch (e) {
        console.error('Error enviando comando PTZ:', e);
    }
}

function setPtzTargetCamera(cid) {
    selectedPtzCamera = cid;
    const ptzSelectCam1 = document.getElementById('ptzSelectCam1');
    const ptzSelectCam2 = document.getElementById('ptzSelectCam2');
    const cam2PtzAuthNotice = document.getElementById('cam2PtzAuthNotice');
    const ptzStatusLabel = document.getElementById('ptzStatusLabel');
    const setHomeBtn = document.getElementById('setHomeBtn');
    const goHomeBtn = document.getElementById('goHomeBtn');

    if (ptzSelectCam1) ptzSelectCam1.classList.toggle('active', cid === 'cam1');
    if (ptzSelectCam2) ptzSelectCam2.classList.toggle('active', cid === 'cam2');
    if (cam2PtzAuthNotice) cam2PtzAuthNotice.style.display = 'none';
    if (setHomeBtn) setHomeBtn.style.display = 'inline-block';
    if (goHomeBtn) goHomeBtn.style.display = 'inline-block';

    if (ptzStatusLabel) {
        ptzStatusLabel.textContent = cid === 'cam1' ? 'Cámara 1 (Tuya) Lista' : 'Cámara 2 (iCam365 ONVIF) Lista';
    }
    if (latestStatusCache) {
        updateHomeStatusUI(latestStatusCache);
    }
}

function initPtzControls() {
    const ptzSelectCam1 = document.getElementById('ptzSelectCam1');
    const ptzSelectCam2 = document.getElementById('ptzSelectCam2');
    const saveCam2PasswordBtn = document.getElementById('saveCam2PasswordBtn');
    const cam2PasswordInput = document.getElementById('cam2PasswordInput');
    const cam2AuthFeedback = document.getElementById('cam2AuthFeedback');

    if (ptzSelectCam1) ptzSelectCam1.addEventListener('click', () => setPtzTargetCamera('cam1'));
    if (ptzSelectCam2) ptzSelectCam2.addEventListener('click', () => setPtzTargetCamera('cam2'));

    // Sincronizar cámara PTZ seleccionada al hacer clic sobre el cuadro de video en mosaico
    const cameraBoxCam1 = document.getElementById('cameraBoxCam1');
    const cameraBoxCam2 = document.getElementById('cameraBoxCam2');
    if (cameraBoxCam1) {
        cameraBoxCam1.addEventListener('click', (e) => {
            if (e.target.closest('button, input, a, select')) return;
            setPtzTargetCamera('cam1');
        });
    }
    if (cameraBoxCam2) {
        cameraBoxCam2.addEventListener('click', (e) => {
            if (e.target.closest('button, input, a, select')) return;
            setPtzTargetCamera('cam2');
        });
    }

    if (saveCam2PasswordBtn) {
        saveCam2PasswordBtn.addEventListener('click', async () => {
            const pwd = cam2PasswordInput ? cam2PasswordInput.value.trim() : '';
            if (cam2AuthFeedback) {
                cam2AuthFeedback.textContent = 'Verificando con Cámara 2...';
                cam2AuthFeedback.style.color = '#38bdf8';
            }
            try {
                const res = await fetch('/api/ptz/cam2/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: pwd, username: 'admin' })
                });
                const data = await res.json();
                if (data.test && data.test.success) {
                    cam2AuthFeedback.textContent = '✅ ¡Contraseña válida! Motor de Cámara 2 listo para mover.';
                    cam2AuthFeedback.style.color = '#34d399';
                } else {
                    cam2AuthFeedback.textContent = `❌ ${data.test?.message || 'Contraseña incorrecta (HTTP 401)'}`;
                    cam2AuthFeedback.style.color = '#f87171';
                }
            } catch (e) {
                cam2AuthFeedback.textContent = '❌ Error de red al probar contraseña';
                cam2AuthFeedback.style.color = '#f87171';
            }
        });
    }

    const ptzBtns = document.querySelectorAll('.ptz-btn');
    ptzBtns.forEach(btn => {
        const dir = btn.dataset.dir;
        if (!dir) return;

        const startMove = (e) => {
            e.preventDefault();
            btn.classList.add('pressed');
            activePtzDir = dir;
            sendPtzMove(dir);
            if (ptzStatusLabel) ptzStatusLabel.textContent = dir === 'stop' ? 'Detenido' : `Moviendo ${selectedPtzCamera.toUpperCase()}: ${dir}`;
            if (ptzStatusChip && dir !== 'stop') ptzStatusChip.className = 'ptz-state-chip moving';
        };

        const stopMove = (e) => {
            e.preventDefault();
            btn.classList.remove('pressed');
            if (activePtzDir === dir && dir !== 'stop') {
                activePtzDir = null;
                sendPtzMove('stop');
                if (ptzStatusLabel) ptzStatusLabel.textContent = selectedPtzCamera === 'cam1' ? 'Cámara 1 Lista' : 'Cámara 2 Lista';
                if (ptzStatusChip) ptzStatusChip.className = 'ptz-state-chip';
            }
        };

        btn.addEventListener('pointerdown', startMove);
        btn.addEventListener('pointerup', stopMove);
        btn.addEventListener('pointercancel', stopMove);
        btn.addEventListener('pointerleave', stopMove);
    });

    // Controles de Punto Central (Home)
    const setHomeBtn = document.getElementById('setHomeBtn');
    const goHomeBtn = document.getElementById('goHomeBtn');
    const homeActionToast = document.getElementById('homeActionToast');

    function showHomeToast(msg, isError = false) {
        if (!homeActionToast) return;
        homeActionToast.textContent = msg;
        homeActionToast.style.color = isError ? '#f87171' : '#34d399';
        homeActionToast.style.display = 'inline-block';
        clearTimeout(homeActionToast._t);
        homeActionToast._t = setTimeout(() => { homeActionToast.style.display = 'none'; }, 3000);
    }

    if (setHomeBtn) {
        setHomeBtn.addEventListener('click', async () => {
            try {
                const camLabel = selectedPtzCamera === 'cam1' ? 'Cámara 1' : 'Cámara 2';
                showHomeToast(`💾 Guardando punto central (${camLabel})...`);
                const res = await fetch('/api/ptz/home/set', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ camera_id: selectedPtzCamera, camera: selectedPtzCamera })
                });
                const data = await res.json();
                if (data.success) {
                    showHomeToast(`✅ Punto Central fijado (${camLabel})`);
                } else {
                    showHomeToast('❌ Error guardando punto', true);
                }
            } catch (e) {
                showHomeToast('❌ Error de conexión', true);
            }
        });
    }

    if (goHomeBtn) {
        goHomeBtn.addEventListener('click', async () => {
            try {
                const camLabel = selectedPtzCamera === 'cam1' ? 'Cámara 1' : 'Cámara 2';
                showHomeToast(`🔄 Regresando al Punto Central (${camLabel})...`);
                const res = await fetch('/api/ptz/home/go', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ camera_id: selectedPtzCamera, camera: selectedPtzCamera })
                });
                const data = await res.json();
                if (data.success) {
                    showHomeToast(`🎯 En Punto Central (${camLabel})`);
                } else {
                    showHomeToast('❌ Error al regresar', true);
                }
            } catch (e) {
                showHomeToast('❌ Error de conexión', true);
            }
        });
    }

    // Configuración del tiempo de espera para regresar al Punto Central
    const delayBtns = document.querySelectorAll('.home-delay-btn');
    const homeDelayToast = document.getElementById('homeDelayToast');

    delayBtns.forEach(btn => {
        btn.addEventListener('click', async () => {
            const delay = parseFloat(btn.dataset.delay);
            delayBtns.forEach(b => b.classList.toggle('active', b === btn));
            if (homeDelayToast) {
                homeDelayToast.textContent = 'Guardando...';
                homeDelayToast.style.display = 'inline-block';
            }
            try {
                const res = await fetch('/api/ptz/home/delay', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ delay, camera_id: selectedPtzCamera, camera: selectedPtzCamera })
                });
                const data = await res.json();
                if (data.success && homeDelayToast) {
                    const camLabel = selectedPtzCamera === 'cam1' ? 'Cámara 1' : 'Cámara 2';
                    homeDelayToast.textContent = `✅ Retorno en ${delay}s guardado (${camLabel})`;
                    setTimeout(() => { homeDelayToast.style.display = 'none'; }, 2500);
                }
            } catch (e) {
                if (homeDelayToast) homeDelayToast.textContent = '❌ Error';
            }
        });
    });
}

let latestStatusCache = null;

function updateHomeStatusUI(status) {
    if (!status) return;
    latestStatusCache = status;
    const activePtz = (selectedPtzCamera === 'cam2') ? status.icam_ptz_status : status.ptz_status;
    if (!activePtz) return;

    const delayBtns = document.querySelectorAll('.home-delay-btn');
    if (activePtz.home_return_delay) {
        delayBtns.forEach(b => {
            b.classList.toggle('active', parseFloat(b.dataset.delay) === activePtz.home_return_delay);
        });
    }

    const camLabel = (selectedPtzCamera === 'cam1') ? 'Cam 1' : 'Cam 2';
    const homeCountdownChip = document.getElementById('homeCountdownChip');
    if (homeCountdownChip) {
        if (activePtz.returning_home) {
            homeCountdownChip.textContent = `🔄 ${camLabel}: Regresando al centro...`;
            homeCountdownChip.style.background = 'rgba(245, 158, 11, 0.2)';
            homeCountdownChip.style.color = '#fbbf24';
        } else if (activePtz.has_offset && activePtz.time_until_return > 0) {
            homeCountdownChip.textContent = `⏳ ${camLabel}: Regresa en ${activePtz.time_until_return}s`;
            homeCountdownChip.style.background = 'rgba(56, 189, 248, 0.2)';
            homeCountdownChip.style.color = '#38bdf8';
        } else {
            homeCountdownChip.textContent = `✅ ${camLabel}: En Punto Central`;
            homeCountdownChip.style.background = 'rgba(52, 211, 153, 0.15)';
            homeCountdownChip.style.color = '#34d399';
        }
    }
}

snapshotBtn.addEventListener('click', async () => {
    try {
        snapshotBtn.classList.add('active');
        const targetCam = currentViewMode === 'cam2' ? 'cam2' : 'cam1';
        const res = await fetch(`/api/snapshot/${targetCam}`, { method: 'POST' });
        const data = await res.json();
        if (data.success && data.url) {
            openSnapshotModal(data.url, `Captura: ${data.camera_name || targetCam}`);
        }
        setTimeout(() => snapshotBtn.classList.remove('active'), 500);
    } catch (e) {
        console.error('Error taking snapshot:', e);
        snapshotBtn.classList.remove('active');
    }
});


toggleSoundBtn.addEventListener('click', () => {
    soundEnabled = !soundEnabled;
    toggleSoundBtn.classList.toggle('active', soundEnabled);
    toggleSoundBtn.querySelector('span:last-child').textContent = soundEnabled ? 'Sonido ON' : 'Sonido';
    toggleSoundBtn.querySelector('.ctrl-icon').textContent = soundEnabled ? '🔔' : '🔇';
});

clearEventsBtn.addEventListener('click', async () => {
    try {
        await fetch('/api/events/clear', { method: 'POST' });
        eventsListEl.innerHTML = `
            <div class="no-events-state">
                <span class="empty-icon">🛡️</span>
                <p>Esperando actividad en la cámara...</p>
            </div>
        `;
    } catch (e) {
        console.error('Error clearing events:', e);
    }
});

// ----------------- SLIDERS DE CONFIGURACIÓN -----------------
let isUserInteractingWithSens = false;
let isUserInteractingWithConf = false;

['mousedown', 'touchstart'].forEach(evt => {
    sensitivitySlider.addEventListener(evt, () => isUserInteractingWithSens = true);
    confidenceSlider.addEventListener(evt, () => isUserInteractingWithConf = true);
});

['mouseup', 'touchend'].forEach(evt => {
    sensitivitySlider.addEventListener(evt, () => isUserInteractingWithSens = false);
    confidenceSlider.addEventListener(evt, () => isUserInteractingWithConf = false);
});

sensitivitySlider.addEventListener('input', (e) => {
    sensValDisplay.textContent = e.target.value;
});

sensitivitySlider.addEventListener('change', async (e) => {
    isUserInteractingWithSens = false;
    localStorage.setItem('cam_sensitivity', e.target.value);
    try {
        await fetch('/api/sensitivity', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ threshold: parseInt(e.target.value) })
        });
    } catch (e) {
        console.error('Error updating sensitivity:', e);
    }
});

confidenceSlider.addEventListener('input', (e) => {
    confValDisplay.textContent = e.target.value + '%';
});

confidenceSlider.addEventListener('change', async (e) => {
    isUserInteractingWithConf = false;
    localStorage.setItem('cam_confidence', e.target.value);
    try {
        await fetch('/api/confidence', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confidence: parseInt(e.target.value) / 100 })
        });
    } catch (e) {
        console.error('Error updating confidence:', e);
    }
});

let prevOnlineCam1 = null;
let prevOnlineCam2 = null;

// ----------------- ESTADO DEL SISTEMA -----------------
async function pollStatus() {
    try {
        const res = await fetch('/api/status');
        if (!res.ok) throw new Error('Status fetch error');
        const status = await res.json();

        // Conexión general
        const anyOnline = status.camera || (status.cameras && (status.cameras.cam1?.online || status.cameras.cam2?.online));
        if (cameraStatusEl) {
            cameraStatusEl.classList.toggle('connected', !!anyOnline);
        }
        if (statusTextEl) {
            statusTextEl.textContent = anyOnline ? 'En Vivo' : 'Reconectando';
        }

        // Supervisión individual de cámaras
        if (status.cameras) {
            // Cámara 1 (Tuya)
            if (status.cameras.cam1) {
                const c1 = status.cameras.cam1;
                if (cam1StatusDot) cam1StatusDot.className = c1.online ? 'cam-dot connected' : 'cam-dot';
                if (cam1FpsBadge) cam1FpsBadge.textContent = `${c1.stream_fps || 0} fps`;
                if (cam1ResBadge && c1.resolution?.width) {
                    cam1ResBadge.textContent = `${c1.resolution.width}x${c1.resolution.height}`;
                }
                const recText1 = document.getElementById('recModeTextCam1');
                if (recText1) {
                    recText1.textContent = c1.continuous_recording ? 'REC 24/7' : 'EVENTOS';
                }
                // Si la cámara estaba caída y acaba de reconectarse en el backend, refrescar feed
                if (c1.online && prevOnlineCam1 === false) {
                    console.log('✅ Cámara 1 recuperada en el servidor, reconectando feed visual...');
                    reloadCam1();
                }
                prevOnlineCam1 = c1.online;
            }

            // Cámara 2 (iCam365)
            if (status.cameras.cam2) {
                const c2 = status.cameras.cam2;
                if (cam2StatusDot) cam2StatusDot.className = c2.online ? 'cam-dot connected' : 'cam-dot';
                if (cam2FpsBadge) cam2FpsBadge.textContent = `${c2.stream_fps || 0} fps`;
                if (cam2ResBadge && c2.resolution?.width) {
                    cam2ResBadge.textContent = `${c2.resolution.width}x${c2.resolution.height}`;
                }
                const recText2 = document.getElementById('recModeTextCam2');
                if (recText2) {
                    recText2.textContent = c2.continuous_recording ? 'REC 24/7' : 'EVENTOS';
                }
                // Si la cámara estaba caída y acaba de reconectarse en el backend, refrescar feed
                if (c2.online && prevOnlineCam2 === false) {
                    console.log('✅ Cámara 2 recuperada en el servidor, reconectando feed visual...');
                    reloadCam2();
                }
                prevOnlineCam2 = c2.online;
            }

            if (window.updatePerCameraCache) {
                window.updatePerCameraCache(status.cameras);
            }
        }

        // Resolución en header según vista activa
        if (status.cameras) {
            const activeCam = currentViewMode === 'cam2' ? status.cameras.cam2 : status.cameras.cam1;
            if (activeCam && activeCam.resolution?.width) {
                const w = activeCam.resolution.width;
                const h = activeCam.resolution.height;
                let tag = `${w}x${h}`;
                if (w >= 1920) tag = '1080p HD';
                else if (w >= 1280) tag = '720p HD';
                if (resTextEl) resTextEl.textContent = tag;
                if (fpsTextEl) fpsTextEl.textContent = `${activeCam.stream_fps || 0} fps`;
                if (aiFpsTextEl) aiFpsTextEl.textContent = `${activeCam.ai_fps || 0} fps`;
            }
        }

        // URL Local
        if (status.local_url && localUrlDisplayEl && localUrlDisplayEl.textContent !== status.local_url) {
            localUrlDisplayEl.textContent = status.local_url;
        }

        // Sincronizar botones de estado según la cámara activa
        window.isYoloActive = status.object_detection;
        if (typeof syncToolbarWithActiveCamera === 'function') {
            syncToolbarWithActiveCamera();
        }
        
        // Sincronizar estado de la cámara PTZ
        if (status.ptz_status && ptzStatusChip && ptzStatusLabel) {
            const ptz = status.ptz_status;
            if (ptz.returning_home) {
                ptzStatusChip.className = 'ptz-state-chip moving';
                ptzStatusLabel.textContent = 'Retornando al Punto Central';
            } else if (ptz.is_moving) {
                ptzStatusChip.className = 'ptz-state-chip moving';
                ptzStatusLabel.textContent = `Moviendo: ${ptz.last_direction || 'girando'}`;
                if (trackingBanner) {
                    trackingBanner.style.display = 'flex';
                    if (trackingBannerMsg) {
                        trackingBannerMsg.textContent = `Auto-Tracking: Siguiendo ${ptz.tracking_target || 'Objetivo'}`;
                    }
                    clearTimeout(trackingBanner._timeout);
                    trackingBanner._timeout = setTimeout(() => {
                        trackingBanner.style.display = 'none';
                    }, 2200);
                }
            } else if (ptz.active) {
                ptzStatusChip.className = 'ptz-state-chip';
                ptzStatusLabel.textContent = 'Auto-Tracking Activo';
            } else {
                ptzStatusChip.className = 'ptz-state-chip disabled';
                ptzStatusLabel.textContent = 'Auto-Tracking Desactivado';
            }
        }
        
        // Sincronizar sliders si no se están arrastrando
        if (!isUserInteractingWithSens && status.motion_threshold !== undefined) {
            if (sensitivitySlider) sensitivitySlider.value = status.motion_threshold;
            if (sensValDisplay) sensValDisplay.textContent = status.motion_threshold;
        }
        if (!isUserInteractingWithConf && status.confidence_threshold !== undefined) {
            const confPct = Math.round(status.confidence_threshold * 100);
            if (confidenceSlider) confidenceSlider.value = confPct;
            if (confValDisplay) confValDisplay.textContent = confPct + '%';
        }
        
        // Grabación Continua 24/7 y Almacenamiento
        const isContinuous = status.continuous_recording;
        if (contRecStatusBadge) {
            contRecStatusBadge.textContent = isContinuous ? 'ACTIVA' : 'PAUSADA';
            contRecStatusBadge.classList.toggle('is-paused', !isContinuous);
        }
        
        if (status.storage) {
            if (storagePathDisplay && status.storage.path) {
                storagePathDisplay.textContent = status.storage.path;
            }
            if (storageFreeDisplay && status.storage.free_gb !== undefined) {
                storageFreeDisplay.textContent = `${status.storage.free_gb} GB libres`;
            }
            if (storagePercentDisplay && status.storage.percent_used !== undefined) {
                storagePercentDisplay.textContent = `${status.storage.percent_used}%`;
            }
            if (storageProgressFill && status.storage.percent_used !== undefined) {
                storageProgressFill.style.width = `${Math.max(2, status.storage.percent_used)}%`;
            }
            // Sincronizar Cuota de Grabaciones (ej. 100 GB) y Auto-Reciclaje
            if (storageQuotaUsedDisplay && status.storage.recordings_used_gb !== undefined) {
                storageQuotaUsedDisplay.textContent = status.storage.recordings_used_gb;
            }
            if (storageQuotaLimitDisplay && status.storage.max_storage_gb !== undefined) {
                storageQuotaLimitDisplay.textContent = status.storage.max_storage_gb;
            }
            if (storageQuotaFill && status.storage.quota_percent !== undefined) {
                const qPct = Math.min(100, Math.max(0, status.storage.quota_percent));
                storageQuotaFill.style.width = `${Math.max(2, qPct)}%`;
                if (qPct >= 92) {
                    storageQuotaFill.style.background = '#ef4444';
                } else if (qPct >= 75) {
                    storageQuotaFill.style.background = '#f59e0b';
                } else {
                    storageQuotaFill.style.background = '#00ff66';
                }
            }
            if (storageRamDisplay && status.storage.ram_process_mb !== undefined) {
                storageRamDisplay.textContent = `${status.storage.ram_process_mb} MB`;
            }
        }

        // Sincronizar Perfil del Sistema y Estado de Capacidades
        if (status.system_profile) {
            const sp = status.system_profile;
            const sysProfText = document.getElementById('systemProfileText');
            if (sysProfText) sysProfText.textContent = sp.profile_badge;
            const sideProfDesc = document.getElementById('sidebarProfileDesc');
            if (sideProfDesc) sideProfDesc.textContent = sp.profile_name;
            const sideHw = document.getElementById('sidebarHwText');
            if (sideHw) sideHw.textContent = `${sp.specs.cpu_cores} núcleos | ${sp.specs.ram_total_gb} GB RAM`;
            const sideAcc = document.getElementById('sidebarAccelText');
            if (sideAcc) sideAcc.textContent = sp.ai_available ? sp.ai_acceleration.toUpperCase() : 'Ninguna (CPU)';

            // Control de degradación de switches si estamos en Modo Ligero o sin IA
            const isLightOrNoAi = (sp.active_profile === 'light' || !sp.ai_available);
            const cfgAiRow = document.getElementById('cfgAiFilterRow');
            const cfgAiSwitch = document.getElementById('cfgAiFilterSwitch');
            const cfgAiBadge = document.getElementById('cfgAiFilterBadge');
            const cfgAiDesc = document.getElementById('cfgAiFilterDesc');

            if (cfgAiSwitch && cfgAiRow) {
                if (isLightOrNoAi) {
                    cfgAiSwitch.disabled = true;
                    cfgAiSwitch.checked = false;
                    cfgAiRow.classList.add('disabled-by-profile');
                    if (cfgAiBadge) cfgAiBadge.textContent = '(Desactivado en Modo Ligero)';
                    if (cfgAiDesc) cfgAiDesc.textContent = 'Detección por movimiento directa activa para no sobrecargar el CPU.';
                } else {
                    cfgAiSwitch.disabled = false;
                    cfgAiRow.classList.remove('disabled-by-profile');
                    if (cfgAiBadge) cfgAiBadge.textContent = '';
                    if (cfgAiDesc) cfgAiDesc.textContent = 'Solo personas/vehículos (ignora mascotas)';
                }
            }
        }

        // Estado del Horario de Captura
        if (status.motion_schedule) {
            const schedBanner = document.getElementById('scheduleStatusBanner');
            const schedText = document.getElementById('scheduleStatusText');
            const sched = status.motion_schedule;
            if (schedBanner && schedText) {
                if (!sched.enabled) {
                    schedBanner.className = 'schedule-status-banner is-armed';
                    schedText.textContent = '24/7 Activo (Siempre captura)';
                } else if (sched.is_active_now) {
                    schedBanner.className = 'schedule-status-banner is-armed';
                    schedText.textContent = `🟢 Armado (${sched.status_message || 'Dentro de horario'})`;
                } else {
                    schedBanner.className = 'schedule-status-banner is-resting';
                    schedText.textContent = `🌙 En reposo (${sched.status_message || 'Fuera de horario'})`;
                }
            }
        }

        // Actualizar chip de estado y cuenta regresiva de retorno a Punto Central
        updateHomeStatusUI(status);

    } catch (e) {
        console.error('Error en pollStatus:', e);
        if (cameraStatusEl) cameraStatusEl.classList.remove('connected');
        if (statusTextEl) statusTextEl.textContent = 'Desconectado';
    }
}

// ----------------- NAVEGACIÓN POR PESTAÑAS DEL PANEL LATERAL -----------------
function initSidebarTabNavigation() {
    const tabNavActivity = document.getElementById('tabNavActivity');
    const tabNavControls = document.getElementById('tabNavControls');
    const tabNavSchedule = document.getElementById('tabNavSchedule');

    const paneActivity = document.getElementById('paneActivity');
    const paneControls = document.getElementById('paneControls');
    const paneSchedule = document.getElementById('paneSchedule');

    const tabs = [
        { btn: tabNavActivity, pane: paneActivity },
        { btn: tabNavControls, pane: paneControls },
        { btn: tabNavSchedule, pane: paneSchedule }
    ];

    tabs.forEach(({ btn, pane }) => {
        if (!btn) return;
        btn.addEventListener('click', () => {
            tabs.forEach(t => {
                if (t.btn) t.btn.classList.toggle('active', t.btn === btn);
                if (t.pane) t.pane.style.display = t.btn === btn ? 'flex' : 'none';
            });
        });
    });
}

// ----------------- PROGRAMACIÓN DE HORARIOS DE CAPTURA -----------------
function initScheduleControls() {
    const toggleScheduleSwitch = document.getElementById('toggleScheduleSwitch');
    const scheduleStatusBanner = document.getElementById('scheduleStatusBanner');
    const scheduleStatusText = document.getElementById('scheduleStatusText');
    const scheduleBody = document.getElementById('scheduleBody');
    const schedStartTime = document.getElementById('schedStartTime');
    const schedEndTime = document.getElementById('schedEndTime');
    const dayPills = document.querySelectorAll('.day-pill');
    const schedCam1 = document.getElementById('schedCam1');
    const schedCam2 = document.getElementById('schedCam2');
    const schedApplyClips = document.getElementById('schedApplyClips');
    const schedApplySnapshots = document.getElementById('schedApplySnapshots');
    const saveScheduleBtn = document.getElementById('saveScheduleBtn');
    const schedSaveToast = document.getElementById('schedSaveToast');
    const presetNightBtn = document.getElementById('presetNightBtn');
    const presetWorkBtn = document.getElementById('presetWorkBtn');
    const preset24Btn = document.getElementById('preset24Btn');

    function updateScheduleBanner(schedData) {
        if (!scheduleStatusBanner || !scheduleStatusText) return;
        const sched = schedData.schedule || schedData;
        if (!sched || !sched.enabled) {
            scheduleStatusBanner.className = 'schedule-status-banner is-armed';
            scheduleStatusText.textContent = '24/7 Activo (Siempre captura)';
            if (scheduleBody) scheduleBody.style.opacity = '0.65';
        } else {
            if (scheduleBody) scheduleBody.style.opacity = '1';
            if (schedData.is_active_now) {
                scheduleStatusBanner.className = 'schedule-status-banner is-armed';
                scheduleStatusText.textContent = `🟢 Armado (${schedData.status_message || 'Dentro de horario'})`;
            } else {
                scheduleStatusBanner.className = 'schedule-status-banner is-resting';
                scheduleStatusText.textContent = `🌙 En reposo (${schedData.status_message || 'Fuera de horario'})`;
            }
        }
    }

    async function loadSchedule() {
        try {
            const res = await fetch('/api/schedule');
            if (!res.ok) return;
            const data = await res.json();
            const sched = data.schedule || {};
            
            if (toggleScheduleSwitch) toggleScheduleSwitch.checked = !!sched.enabled;
            if (schedStartTime && sched.start_time) schedStartTime.value = sched.start_time;
            if (schedEndTime && sched.end_time) schedEndTime.value = sched.end_time;
            
            const activeDays = sched.days || [0, 1, 2, 3, 4, 5, 6];
            dayPills.forEach(pill => {
                const day = parseInt(pill.dataset.day, 10);
                pill.classList.toggle('active', activeDays.includes(day));
            });
            
            const cams = sched.target_cameras || ['cam1', 'cam2'];
            if (schedCam1) schedCam1.checked = cams.includes('cam1');
            if (schedCam2) schedCam2.checked = cams.includes('cam2');

            if (schedApplyClips) schedApplyClips.checked = sched.apply_to_clips !== undefined ? !!sched.apply_to_clips : true;
            if (schedApplySnapshots) schedApplySnapshots.checked = sched.apply_to_snapshots !== undefined ? !!sched.apply_to_snapshots : true;
            
            updateScheduleBanner(data);
        } catch (e) {
            console.error('Error cargando horario:', e);
        }
    }

    // Toggle de días
    dayPills.forEach(pill => {
        pill.addEventListener('click', () => {
            pill.classList.toggle('active');
        });
    });

    // Presets rápidos
    if (presetNightBtn) {
        presetNightBtn.addEventListener('click', () => {
            if (schedStartTime) schedStartTime.value = '22:00';
            if (schedEndTime) schedEndTime.value = '06:00';
            dayPills.forEach(p => p.classList.add('active'));
            if (toggleScheduleSwitch) toggleScheduleSwitch.checked = true;
            saveSchedule();
        });
    }

    if (presetWorkBtn) {
        presetWorkBtn.addEventListener('click', () => {
            if (schedStartTime) schedStartTime.value = '08:00';
            if (schedEndTime) schedEndTime.value = '18:00';
            dayPills.forEach(p => {
                const d = parseInt(p.dataset.day, 10);
                p.classList.toggle('active', d < 5); // Lun a Vie
            });
            if (toggleScheduleSwitch) toggleScheduleSwitch.checked = true;
            saveSchedule();
        });
    }

    if (preset24Btn) {
        preset24Btn.addEventListener('click', () => {
            if (toggleScheduleSwitch) toggleScheduleSwitch.checked = false;
            dayPills.forEach(p => p.classList.add('active'));
            saveSchedule();
        });
    }

    async function saveSchedule() {
        const enabled = toggleScheduleSwitch ? toggleScheduleSwitch.checked : false;
        const start_time = schedStartTime ? schedStartTime.value : '22:00';
        const end_time = schedEndTime ? schedEndTime.value : '06:00';
        
        const days = [];
        dayPills.forEach(pill => {
            if (pill.classList.contains('active')) {
                days.push(parseInt(pill.dataset.day, 10));
            }
        });
        
        const target_cameras = [];
        if (schedCam1 && schedCam1.checked) target_cameras.push('cam1');
        if (schedCam2 && schedCam2.checked) target_cameras.push('cam2');

        const apply_to_clips = schedApplyClips ? schedApplyClips.checked : true;
        const apply_to_snapshots = schedApplySnapshots ? schedApplySnapshots.checked : true;

        try {
            const res = await fetch('/api/schedule', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    enabled,
                    start_time,
                    end_time,
                    days,
                    target_cameras,
                    apply_to_clips,
                    apply_to_snapshots
                })
            });
            const data = await res.json();
            updateScheduleBanner(data);
            if (schedSaveToast) {
                schedSaveToast.textContent = '✅ Horario guardado';
                schedSaveToast.style.display = 'inline-block';
                setTimeout(() => { schedSaveToast.style.display = 'none'; }, 2500);
            }
        } catch (e) {
            console.error('Error guardando horario:', e);
            if (schedSaveToast) {
                schedSaveToast.textContent = '❌ Error al guardar';
                schedSaveToast.style.display = 'inline-block';
                setTimeout(() => { schedSaveToast.style.display = 'none'; }, 2500);
            }
        }
    }

    if (saveScheduleBtn) saveScheduleBtn.addEventListener('click', saveSchedule);
    if (toggleScheduleSwitch) toggleScheduleSwitch.addEventListener('change', saveSchedule);
    if (schedApplyClips) schedApplyClips.addEventListener('change', saveSchedule);
    if (schedApplySnapshots) schedApplySnapshots.addEventListener('change', saveSchedule);

    loadSchedule();
}

// ----------------- CONFIGURACIÓN INDIVIDUAL POR CÁMARA -----------------
let selectedConfigCam = 'cam1';
let camerasCache = {};

function initPerCameraControls() {
    const cfgCam1Tab = document.getElementById('cfgCam1Tab');
    const cfgCam2Tab = document.getElementById('cfgCam2Tab');
    const cfgCamNameText = document.getElementById('cfgCamNameText');
    const cfgCamStatusDot = document.getElementById('cfgCamStatusDot');
    
    const cfgMotionSwitch = document.getElementById('cfgMotionSwitch');
    const cfgEventRecSwitch = document.getElementById('cfgEventRecSwitch');
    const cfgTrackingSwitch = document.getElementById('cfgTrackingSwitch');
    const cfgAiFilterSwitch = document.getElementById('cfgAiFilterSwitch');
    const cfgContRecSwitch = document.getElementById('cfgContRecSwitch');
    const cfgSensSlider = document.getElementById('cfgSensSlider');
    const cfgSensValText = document.getElementById('cfgSensValText');
    const saveCfgCamBtn = document.getElementById('saveCfgCamBtn');
    const cfgSaveToast = document.getElementById('cfgSaveToast');

    function showCfgToast(msg, isError = false) {
        if (!cfgSaveToast) return;
        cfgSaveToast.textContent = msg;
        cfgSaveToast.style.color = isError ? '#f87171' : '#34d399';
        cfgSaveToast.style.display = 'inline-block';
        clearTimeout(cfgSaveToast._t);
        cfgSaveToast._t = setTimeout(() => { cfgSaveToast.style.display = 'none'; }, 2500);
    }

    function setConfigTab(cid) {
        selectedConfigCam = cid;
        if (cfgCam1Tab) cfgCam1Tab.classList.toggle('active', cid === 'cam1');
        if (cfgCam2Tab) cfgCam2Tab.classList.toggle('active', cid === 'cam2');
        if (cfgCamNameText) {
            cfgCamNameText.textContent = cid === 'cam1' ? 'Cámara 1 (Tuya PTZ)' : 'Cámara 2 (iCam365)';
        }
        renderCamSettingsFromCache();
        if (typeof syncToolbarWithActiveCamera === 'function') {
            syncToolbarWithActiveCamera();
        }
    }

    window.setPerCamConfigTab = setConfigTab;

    if (cfgCam1Tab) cfgCam1Tab.addEventListener('click', () => setConfigTab('cam1'));
    if (cfgCam2Tab) cfgCam2Tab.addEventListener('click', () => setConfigTab('cam2'));

    function renderCamSettingsFromCache() {
        const cam = camerasCache[selectedConfigCam];
        if (!cam) return;

        if (cfgCamStatusDot) {
            cfgCamStatusDot.style.background = cam.online ? '#34d399' : '#f87171';
        }
        if (cfgMotionSwitch) cfgMotionSwitch.checked = cam.motion_detection !== false;
        if (cfgEventRecSwitch) cfgEventRecSwitch.checked = cam.event_recording !== false;
        if (cfgTrackingSwitch) cfgTrackingSwitch.checked = cam.auto_tracking !== false;
        if (cfgAiFilterSwitch) cfgAiFilterSwitch.checked = cam.ai_filter !== false;
        if (cfgContRecSwitch) cfgContRecSwitch.checked = !!cam.continuous_recording;
        if (cfgSensSlider && cam.motion_threshold) {
            cfgSensSlider.value = cam.motion_threshold;
            if (cfgSensValText) cfgSensValText.textContent = cam.motion_threshold;
        }
    }

    if (cfgSensSlider) {
        cfgSensSlider.addEventListener('input', () => {
            if (cfgSensValText) cfgSensValText.textContent = cfgSensSlider.value;
        });
        cfgSensSlider.addEventListener('change', () => {
            sendQuickSetting({ motion_threshold: parseInt(cfgSensSlider.value, 10) });
        });
    }

    async function sendQuickSetting(partialObj) {
        try {
            showCfgToast('Guardando...');
            const res = await fetch(`/api/camera/${selectedConfigCam}/settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(partialObj)
            });
            const data = await res.json();
            if (data.success) {
                showCfgToast('✅ Ajuste guardado');
                if (!camerasCache[selectedConfigCam]) camerasCache[selectedConfigCam] = {};
                Object.assign(camerasCache[selectedConfigCam], data.settings || partialObj);
                if (typeof syncToolbarWithActiveCamera === 'function') {
                    syncToolbarWithActiveCamera();
                }
            } else {
                showCfgToast('❌ Error al guardar', true);
            }
        } catch (e) {
            showCfgToast('❌ Error de red', true);
        }
    }

    if (cfgMotionSwitch) {
        cfgMotionSwitch.addEventListener('change', () => {
            sendQuickSetting({ motion_detection: cfgMotionSwitch.checked });
        });
    }
    if (cfgEventRecSwitch) {
        cfgEventRecSwitch.addEventListener('change', () => {
            sendQuickSetting({ event_recording: cfgEventRecSwitch.checked });
        });
    }
    if (cfgTrackingSwitch) {
        cfgTrackingSwitch.addEventListener('change', () => {
            sendQuickSetting({ auto_tracking: cfgTrackingSwitch.checked });
        });
    }
    if (cfgAiFilterSwitch) {
        cfgAiFilterSwitch.addEventListener('change', () => {
            sendQuickSetting({ ai_filter: cfgAiFilterSwitch.checked });
        });
    }
    if (cfgContRecSwitch) {
        cfgContRecSwitch.addEventListener('change', () => {
            sendQuickSetting({ continuous_recording: cfgContRecSwitch.checked });
        });
    }

    if (saveCfgCamBtn) {
        saveCfgCamBtn.addEventListener('click', async () => {
            const payload = {
                motion_detection: cfgMotionSwitch ? cfgMotionSwitch.checked : true,
                event_recording: cfgEventRecSwitch ? cfgEventRecSwitch.checked : true,
                auto_tracking: cfgTrackingSwitch ? cfgTrackingSwitch.checked : true,
                ai_filter: cfgAiFilterSwitch ? cfgAiFilterSwitch.checked : true,
                continuous_recording: cfgContRecSwitch ? cfgContRecSwitch.checked : false,
                motion_threshold: cfgSensSlider ? parseInt(cfgSensSlider.value, 10) : 4000
            };
            sendQuickSetting(payload);
        });
    }

    window.updatePerCameraCache = function(cams) {
        if (!cams) return;
        camerasCache = cams;
        renderCamSettingsFromCache();
        if (typeof syncToolbarWithActiveCamera === 'function') {
            syncToolbarWithActiveCamera();
        }
    };
}

// ----------------- MODAL DE CAPACIDADES Y MODO DEL SISTEMA -----------------
function initSystemCapabilities() {
    const systemProfileBtn = document.getElementById('systemProfileBtn');
    const btnOpenCapabilities = document.getElementById('btnOpenCapabilities');
    const capabilitiesModal = document.getElementById('capabilitiesModal');
    const capabilitiesCloseBtn = document.getElementById('capabilitiesCloseBtn');
    const capabilitiesCancelBtn = document.getElementById('capabilitiesCancelBtn');
    const capabilitiesBackdrop = document.getElementById('capabilitiesBackdrop');
    const capabilitiesSaveBtn = document.getElementById('capabilitiesSaveBtn');

    const capCpuText = document.getElementById('capCpuText');
    const capRamText = document.getElementById('capRamText');
    const capAccelText = document.getElementById('capAccelText');
    const capAiModuleText = document.getElementById('capAiModuleText');
    const capabilitiesList = document.getElementById('capabilitiesList');
    const capRecommendationBox = document.getElementById('capRecommendationBox');
    const systemProfileText = document.getElementById('systemProfileText');
    const sidebarProfileDesc = document.getElementById('sidebarProfileDesc');
    const sidebarHwText = document.getElementById('sidebarHwText');
    const sidebarAccelText = document.getElementById('sidebarAccelText');

    async function loadCapabilities(openModal = false) {
        try {
            const res = await fetch('/api/system/capabilities');
            if (!res.ok) return;
            const data = await res.json();
            renderCapabilitiesUI(data);
            if (openModal && capabilitiesModal) {
                capabilitiesModal.style.display = 'flex';
            }
        } catch (e) {
            console.error('Error cargando capacidades del sistema:', e);
        }
    }

    function renderCapabilitiesUI(data) {
        if (!data) return;
        if (systemProfileText) systemProfileText.textContent = data.profile_badge;
        if (sidebarHwText) sidebarHwText.textContent = `${data.specs.cpu_cores} núcleos | ${data.specs.ram_total_gb} GB RAM`;
        if (sidebarAccelText) sidebarAccelText.textContent = data.ai_available ? data.ai_acceleration.toUpperCase() : 'Ninguna (CPU)';
        if (sidebarProfileDesc) sidebarProfileDesc.textContent = data.profile_name;

        if (capCpuText) capCpuText.textContent = `${data.specs.cpu_cores} núcleos (${data.specs.os})`;
        if (capRamText) capRamText.textContent = `${data.specs.ram_total_gb} GB (${data.specs.ram_free_gb} GB libres)`;
        if (capAccelText) capAccelText.textContent = data.ai_device_name;
        if (capAiModuleText) {
            capAiModuleText.textContent = data.ai_available ? '✅ Instalado (YOLOv8)' : '⚠️ No Instalado (Modo Ligero)';
            capAiModuleText.style.color = data.ai_available ? '#34d399' : '#f59e0b';
        }

        if (capRecommendationBox) {
            capRecommendationBox.textContent = `💡 Diagnóstico: ${data.recommendation_text}`;
        }

        // Radios de selección de modo
        const radios = document.querySelectorAll('input[name="sysProfileRadio"]');
        radios.forEach(r => {
            if (r.value === data.configured_profile) {
                r.checked = true;
                r.closest('.profile-option-card')?.classList.add('active-selected');
            } else {
                r.closest('.profile-option-card')?.classList.remove('active-selected');
            }
            r.onchange = () => {
                radios.forEach(other => other.closest('.profile-option-card')?.classList.remove('active-selected'));
                r.closest('.profile-option-card')?.classList.add('active-selected');
            };
        });

        // Lista detallada de capacidades
        if (capabilitiesList && data.capabilities) {
            capabilitiesList.innerHTML = '';
            for (const [key, item] of Object.entries(data.capabilities)) {
                const row = document.createElement('div');
                row.className = 'capability-item';
                const isOk = item.enabled;
                const isSupp = item.supported;
                const icon = isOk ? '✅' : (isSupp ? '⚠️' : '❌');
                const badgeColor = isOk ? '#34d399' : (isSupp ? '#f59e0b' : '#ef4444');
                const badgeBg = isOk ? 'rgba(52,211,153,0.12)' : (isSupp ? 'rgba(245,158,11,0.12)' : 'rgba(239,68,68,0.12)');

                row.innerHTML = `
                    <div style="display: flex; flex-direction: column; gap: 0.12rem;">
                        <span style="color: #f1f5f9; font-weight: 500;">${icon} ${item.label}</span>
                        <span style="color: #94a3b8; font-size: 0.72rem;">${item.reason || item.desc}</span>
                    </div>
                    <span style="font-size: 0.72rem; padding: 0.2rem 0.5rem; border-radius: 4px; background: ${badgeBg}; color: ${badgeColor}; border: 1px solid ${badgeColor}33; white-space: nowrap;">
                        ${item.status_badge}
                    </span>
                `;
                capabilitiesList.appendChild(row);
            }
        }
    }

    if (systemProfileBtn) {
        systemProfileBtn.addEventListener('click', () => loadCapabilities(true));
    }
    if (btnOpenCapabilities) {
        btnOpenCapabilities.addEventListener('click', () => loadCapabilities(true));
    }

    function closeModal() {
        if (capabilitiesModal) capabilitiesModal.style.display = 'none';
    }

    if (capabilitiesCloseBtn) capabilitiesCloseBtn.addEventListener('click', closeModal);
    if (capabilitiesCancelBtn) capabilitiesCancelBtn.addEventListener('click', closeModal);
    if (capabilitiesBackdrop) capabilitiesBackdrop.addEventListener('click', closeModal);

    if (capabilitiesSaveBtn) {
        capabilitiesSaveBtn.addEventListener('click', async () => {
            const selectedRadio = document.querySelector('input[name="sysProfileRadio"]:checked');
            if (!selectedRadio) return;
            const newProfile = selectedRadio.value;
            capabilitiesSaveBtn.disabled = true;
            capabilitiesSaveBtn.textContent = 'Guardando...';

            try {
                const res = await fetch('/api/system/profile', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ profile: newProfile })
                });
                const result = await res.json();
                if (result.success && result.summary) {
                    renderCapabilitiesUI(result.summary);
                    closeModal();
                    alert(`✅ Modo cambiado a: ${result.summary.profile_name}`);
                    pollStatus();
                } else {
                    alert(`Error: ${result.error || 'No se pudo aplicar el perfil'}`);
                }
            } catch (e) {
                alert(`Error de red: ${e}`);
            } finally {
                capabilitiesSaveBtn.disabled = false;
                capabilitiesSaveBtn.textContent = '💾 Guardar y Aplicar Modo';
            }
        });
    }

    // Cargar capacidades iniciales
    loadCapabilities(false);
}

// ----------------- MODAL OPTIMIZADOR DE ALMACENAMIENTO (ESTILO MICROSD) -----------------
function initStorageOptimizationModal() {
    const btnOpenStorageModal = document.getElementById('btnOpenStorageModal');
    const btnSidebarStorageOptimize = document.getElementById('btnSidebarStorageOptimize');
    const storageModal = document.getElementById('storageModal');
    const storageCloseBtn = document.getElementById('storageCloseBtn');
    const storageCloseFooterBtn = document.getElementById('storageCloseFooterBtn');
    const storageBackdrop = document.getElementById('storageBackdrop');
    const saveStorageProfileBtn = document.getElementById('saveStorageProfileBtn');
    const btnExecutePurge = document.getElementById('btnExecutePurge');
    const purgeDaysSelect = document.getElementById('purgeDaysSelect');
    const purgeFeedbackText = document.getElementById('purgeFeedbackText');

    const storageProfileActiveBadge = document.getElementById('storageProfileActiveBadge');
    const storageSavingEstimate = document.getElementById('storageSavingEstimate');
    const storageBadgeText = document.getElementById('storageBadgeText');

    // Elementos de la Cuota de Grabación (Ring Buffer FIFO)
    const storageQuotaInput = document.getElementById('storageQuotaInput');
    const autoRecycleCheckbox = document.getElementById('autoRecycleCheckbox');
    const quotaPresetBtns = document.querySelectorAll('.quota-preset-btn');
    const modalQuotaUsedDisplay = document.getElementById('modalQuotaUsedDisplay');
    const modalQuotaLimitDisplay = document.getElementById('modalQuotaLimitDisplay');
    const modalQuotaPctDisplay = document.getElementById('modalQuotaPctDisplay');
    const modalQuotaProgressBar = document.getElementById('modalQuotaProgressBar');
    const modalQuotaFreeDisplay = document.getElementById('modalQuotaFreeDisplay');
    const btnModalForceRecycle = document.getElementById('btnModalForceRecycle');
    const modalRecycleFeedback = document.getElementById('modalRecycleFeedback');

    let currentQuotaData = {
        recordings_used_gb: 0.0,
        max_storage_gb: 100.0,
        quota_percent: 0,
        quota_free_gb: 100.0
    };

    function openModal() {
        if (storageModal) storageModal.style.display = 'flex';
        syncCurrentStorageProfile();
    }

    function closeModal() {
        if (storageModal) storageModal.style.display = 'none';
    }

    if (btnOpenStorageModal) btnOpenStorageModal.addEventListener('click', openModal);
    if (btnSidebarStorageOptimize) btnSidebarStorageOptimize.addEventListener('click', openModal);
    if (storageCloseBtn) storageCloseBtn.addEventListener('click', closeModal);
    if (storageCloseFooterBtn) storageCloseFooterBtn.addEventListener('click', closeModal);
    if (storageBackdrop) storageBackdrop.addEventListener('click', closeModal);

    // Manejar presets rápidos de cuota
    quotaPresetBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            quotaPresetBtns.forEach(b => {
                b.classList.remove('active');
                b.style.background = 'rgba(255,255,255,0.06)';
                b.style.borderColor = 'rgba(255,255,255,0.15)';
                b.style.color = '#f8fafc';
                b.style.fontWeight = 'normal';
            });
            btn.classList.add('active');
            btn.style.background = 'rgba(0, 255, 102, 0.2)';
            btn.style.borderColor = '#00ff66';
            btn.style.color = '#00ff66';
            btn.style.fontWeight = '600';

            const val = parseFloat(btn.dataset.quota);
            if (storageQuotaInput) storageQuotaInput.value = val;
            updateModalQuotaUI(currentQuotaData.recordings_used_gb, val);
        });
    });

    if (storageQuotaInput) {
        storageQuotaInput.addEventListener('input', () => {
            const val = parseFloat(storageQuotaInput.value) || 100;
            quotaPresetBtns.forEach(b => {
                const isMatch = parseFloat(b.dataset.quota) === val;
                b.classList.toggle('active', isMatch);
                b.style.background = isMatch ? 'rgba(0, 255, 102, 0.2)' : 'rgba(255,255,255,0.06)';
                b.style.borderColor = isMatch ? '#00ff66' : 'rgba(255,255,255,0.15)';
                b.style.color = isMatch ? '#00ff66' : '#f8fafc';
                b.style.fontWeight = isMatch ? '600' : 'normal';
            });
            updateModalQuotaUI(currentQuotaData.recordings_used_gb, val);
        });
    }

    function updateModalQuotaUI(usedGb, limitGb) {
        const used = Math.max(0, parseFloat(usedGb) || 0);
        const limit = Math.max(1, parseFloat(limitGb) || 100);
        const pct = Math.min(100, Math.round((used / limit) * 100));
        const free = Math.max(0, Math.round((limit - used) * 10) / 10);

        if (modalQuotaUsedDisplay) modalQuotaUsedDisplay.textContent = used.toFixed(1);
        if (modalQuotaLimitDisplay) modalQuotaLimitDisplay.textContent = limit.toFixed(0);
        if (modalQuotaPctDisplay) modalQuotaPctDisplay.textContent = `${pct}%`;
        if (modalQuotaFreeDisplay) modalQuotaFreeDisplay.textContent = `${free.toFixed(1)} GB`;

        if (modalQuotaProgressBar) {
            modalQuotaProgressBar.style.width = `${Math.max(2, pct)}%`;
            if (pct >= 92) {
                modalQuotaProgressBar.style.background = '#ef4444';
            } else if (pct >= 75) {
                modalQuotaProgressBar.style.background = '#f59e0b';
            } else {
                modalQuotaProgressBar.style.background = '#00ff66';
            }
        }
    }

    async function syncCurrentStorageProfile() {
        try {
            const res = await fetch('/api/storage');
            if (res.ok) {
                const data = await res.json();
                const profile = data.storage_profile || 'microsd_events';
                const rad = document.querySelector(`input[name="storageProfileRadio"][value="${profile}"]`);
                if (rad) rad.checked = true;
                updateStorageBadgeDisplays(profile);

                // Sincronizar cuota y auto-reciclaje
                const limitGb = parseFloat(data.max_storage_gb) || 100;
                const usedGb = parseFloat(data.recordings_used_gb) || 0.0;
                currentQuotaData = {
                    recordings_used_gb: usedGb,
                    max_storage_gb: limitGb,
                    quota_percent: data.quota_percent || 0,
                    quota_free_gb: data.quota_free_gb || 0
                };

                if (storageQuotaInput) storageQuotaInput.value = limitGb;
                if (autoRecycleCheckbox) autoRecycleCheckbox.checked = (data.auto_recycle_enabled !== false);

                // Activar visualmente el preset correspondiente
                quotaPresetBtns.forEach(b => {
                    const isMatch = parseFloat(b.dataset.quota) === limitGb;
                    b.classList.toggle('active', isMatch);
                    b.style.background = isMatch ? 'rgba(0, 255, 102, 0.2)' : 'rgba(255,255,255,0.06)';
                    b.style.borderColor = isMatch ? '#00ff66' : 'rgba(255,255,255,0.15)';
                    b.style.color = isMatch ? '#00ff66' : '#f8fafc';
                    b.style.fontWeight = isMatch ? '600' : 'normal';
                });

                updateModalQuotaUI(usedGb, limitGb);
            }
        } catch (e) {
            console.error('Error sincronizando perfil de almacenamiento:', e);
        }
    }

    function updateStorageBadgeDisplays(profile) {
        if (profile === 'microsd_events') {
            if (storageProfileActiveBadge) {
                storageProfileActiveBadge.textContent = '🛡️ MicroSD (Solo Eventos)';
                storageProfileActiveBadge.style.color = '#00ff66';
                storageProfileActiveBadge.style.borderColor = 'rgba(0, 255, 102, 0.4)';
            }
            if (storageSavingEstimate) storageSavingEstimate.textContent = '~98% menos disco (500MB/día)';
            if (storageBadgeText) storageBadgeText.textContent = '💾 Modo MicroSD';
        } else if (profile === 'smart_vbr') {
            if (storageProfileActiveBadge) {
                storageProfileActiveBadge.textContent = '⚡ Smart VBR (Continua 24/7)';
                storageProfileActiveBadge.style.color = '#38bdf8';
                storageProfileActiveBadge.style.borderColor = 'rgba(56, 189, 248, 0.4)';
            }
            if (storageSavingEstimate) storageSavingEstimate.textContent = '~78% menos disco (6-8GB/día)';
            if (storageBadgeText) storageBadgeText.textContent = '⚡ Smart VBR';
        } else {
            if (storageProfileActiveBadge) {
                storageProfileActiveBadge.textContent = '⚠️ Alta Calidad (Nativo)';
                storageProfileActiveBadge.style.color = '#ef4444';
                storageProfileActiveBadge.style.borderColor = 'rgba(239, 68, 68, 0.4)';
            }
            if (storageSavingEstimate) storageSavingEstimate.textContent = 'Sin compresión (72GB/día)';
            if (storageBadgeText) storageBadgeText.textContent = '⚠️ Alta Calidad';
        }
    }

    // Botón para forzar reciclaje FIFO manualmente
    if (btnModalForceRecycle) {
        btnModalForceRecycle.addEventListener('click', async () => {
            btnModalForceRecycle.disabled = true;
            btnModalForceRecycle.textContent = '♻️ Reciclando...';
            if (modalRecycleFeedback) modalRecycleFeedback.style.display = 'none';

            try {
                const res = await fetch('/api/storage/recycle-now', { method: 'POST' });
                const result = await res.json();
                if (result.success) {
                    if (modalRecycleFeedback) {
                        modalRecycleFeedback.style.display = 'block';
                        modalRecycleFeedback.style.color = '#34d399';
                        modalRecycleFeedback.textContent = `✅ ${result.message}`;
                    }
                    syncCurrentStorageProfile();
                    pollStatus();
                } else {
                    if (modalRecycleFeedback) {
                        modalRecycleFeedback.style.display = 'block';
                        modalRecycleFeedback.style.color = '#f87171';
                        modalRecycleFeedback.textContent = `❌ ${result.error || 'Error al reciclar'}`;
                    }
                }
            } catch (e) {
                if (modalRecycleFeedback) {
                    modalRecycleFeedback.style.display = 'block';
                    modalRecycleFeedback.style.color = '#f87171';
                    modalRecycleFeedback.textContent = `❌ Error: ${e.message || e}`;
                }
            } finally {
                btnModalForceRecycle.disabled = false;
                btnModalForceRecycle.textContent = '♻️ Forzar Reciclaje Ahora';
            }
        });
    }

    // Guardar Perfil de Compresión y Cuota de Almacenamiento (100 GB)
    if (saveStorageProfileBtn) {
        saveStorageProfileBtn.addEventListener('click', async () => {
            const selectedRad = document.querySelector('input[name="storageProfileRadio"]:checked');
            const profile = selectedRad ? selectedRad.value : 'microsd_events';
            const quotaVal = parseFloat(storageQuotaInput ? storageQuotaInput.value : 100) || 100;
            const autoRecycleVal = autoRecycleCheckbox ? autoRecycleCheckbox.checked : true;

            saveStorageProfileBtn.disabled = true;
            saveStorageProfileBtn.textContent = 'Guardando configuración...';

            try {
                // 1. Guardar perfil de compresión H.264
                const resProf = await fetch('/api/settings/storage-profile', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ profile: profile })
                });
                const resProfData = await resProf.json();

                // 2. Guardar cuota de almacenamiento y auto-reciclaje FIFO
                const resQuota = await fetch('/api/settings/storage-quota', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        max_storage_gb: quotaVal,
                        auto_recycle_enabled: autoRecycleVal
                    })
                });
                const resQuotaData = await resQuota.json();

                if (resProfData.success && resQuotaData.success) {
                    updateStorageBadgeDisplays(profile);
                    alert(`✅ ¡Configuración de Almacenamiento guardada con éxito!\n\n• Perfil: ${profile}\n• Límite Cuota: ${quotaVal} GB\n• Auto-Reciclaje FIFO: ${autoRecycleVal ? 'ACTIVO (Ring Buffer 24/7)' : 'DESACTIVADO'}`);
                    closeModal();
                    pollStatus();
                } else {
                    const err = resProfData.error || resQuotaData.error || 'Error al guardar';
                    alert(`Error: ${err}`);
                }
            } catch (e) {
                alert(`❌ Error al guardar configuración de almacenamiento: ${e.message || e}`);
            } finally {
                saveStorageProfileBtn.disabled = false;
                saveStorageProfileBtn.textContent = '💾 Guardar Modo y Límite de Cuota';
            }
        });
    }

    if (btnExecutePurge) {
        btnExecutePurge.addEventListener('click', async () => {
            const days = parseInt(purgeDaysSelect ? purgeDaysSelect.value : '7', 10);
            const msg = days === 0
                ? '¿Estás seguro de BORRAR TODAS las grabaciones continuas pesadas? (Las fotos y clips de alertas prioritarias se mantendrán)'
                : `¿Deseas purgar grabaciones continuas de más de ${days} días para liberar espacio?`;
            
            if (!confirm(msg)) return;

            btnExecutePurge.disabled = true;
            btnExecutePurge.textContent = '⏳ Purgando...';
            if (purgeFeedbackText) purgeFeedbackText.style.display = 'none';

            try {
                const res = await fetch('/api/storage/purge', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ days_to_keep: days, delete_continuous: true })
                });
                const result = await res.json();
                if (result.success) {
                    if (purgeFeedbackText) {
                        purgeFeedbackText.style.display = 'inline-block';
                        purgeFeedbackText.textContent = `✅ ${result.message} (${result.freed_mb || 0} MB liberados)`;
                    }
                    syncCurrentStorageProfile();
                    pollStatus();
                } else {
                    alert(`Error en purga: ${result.error || 'No se pudo purgar'}`);
                }
            } catch (e) {
                alert(`Error en purga: ${e.message || e}`);
            } finally {
                btnExecutePurge.disabled = false;
                btnExecutePurge.textContent = '🗑️ Purgar Grabaciones Continuas Ahora';
            }
        });
    }

    syncCurrentStorageProfile();
}

// ----------------- SINCRONIZACIÓN DINÁMICA DE PESTAÑAS DE VISTA PARA N CÁMARAS -----------------
async function refreshDynamicCameraTabs() {
    const dynamicGroup = document.getElementById('dynamicCamTabsGroup');
    if (!dynamicGroup) return;

    try {
        const res = await fetch('/api/cameras');
        if (!res.ok) return;
        const data = await res.json();
        const cams = data.cameras || [];

        dynamicGroup.innerHTML = '';
        cams.forEach(cam => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `view-tab-btn ${currentViewMode === cam.id ? 'active' : ''}`;
            btn.id = `tab_${cam.id}`;
            btn.dataset.view = cam.id;
            btn.innerHTML = `<span class="icon">📹</span> ${cam.name}`;

            btn.addEventListener('click', () => {
                setViewMode(cam.id);
            });
            dynamicGroup.appendChild(btn);
        });

        if (mosaicContainer) {
            mosaicContainer.classList.remove('grid-1', 'grid-2', 'grid-3', 'grid-4', 'grid-5', 'grid-6');
            if (cams.length <= 1) mosaicContainer.classList.add('grid-1');
            else if (cams.length === 2) mosaicContainer.classList.add('grid-2');
            else if (cams.length <= 4) mosaicContainer.classList.add('grid-4');
            else mosaicContainer.classList.add('grid-6');
        }
    } catch (e) {
        console.error('Error refrescando pestañas dinámicas de cámaras:', e);
    }
}

// ----------------- ASISTENTE DE CÁMARAS Y GESTIÓN MULTI-CÁMARA DINÁMICA -----------------
function initNetworkScannerModal() {
    const btnOpenScanner = document.getElementById('btnOpenScanner');
    const tabAddCameraBtn = document.getElementById('tabAddCameraBtn');
    const scannerModal = document.getElementById('scannerModal');
    const scannerCloseBtn = document.getElementById('scannerCloseBtn');
    const scannerCloseFooterBtn = document.getElementById('scannerCloseFooterBtn');
    const scannerBackdrop = document.getElementById('scannerBackdrop');
    
    // Pestañas del Wizard
    const wizardTabs = document.querySelectorAll('.wizard-tab-btn');
    const wizardPanels = document.querySelectorAll('.wizard-panel');

    // Panel 1: Radar
    const scanSubnetInput = document.getElementById('scanSubnetInput');
    const startScanBtn = document.getElementById('startScanBtn');
    const startScanIcon = document.getElementById('startScanIcon');
    const startScanText = document.getElementById('startScanText');
    const scanStatusMsg = document.getElementById('scanStatusMsg');
    const scanCounterText = document.getElementById('scanCounterText');
    const scanFoundCount = document.getElementById('scanFoundCount');
    const scannedDevicesList = document.getElementById('scannedDevicesList');

    // Diagnóstico Directo por IP (Ubox / Batería)
    const diagIpInput = document.getElementById('diagIpInput');
    const btnDiagnoseIp = document.getElementById('btnDiagnoseIp');
    const btnDiagnoseIpIcon = document.getElementById('btnDiagnoseIpIcon');
    const btnDiagnoseIpText = document.getElementById('btnDiagnoseIpText');
    const diagnoseResultBox = document.getElementById('diagnoseResultBox');

    // Panel 2: Fabricantes
    const brandPills = document.querySelectorAll('.brand-pill');
    const brandGuideTitle = document.getElementById('brandGuideTitle');
    const brandGuideDesc = document.getElementById('brandGuideDesc');
    const brandGuideTips = document.getElementById('brandGuideTips');

    const wizCamName = document.getElementById('wizCamName');
    const wizCamIp = document.getElementById('wizCamIp');
    const wizCamPort = document.getElementById('wizCamPort');
    const wizCamUser = document.getElementById('wizCamUser');
    const wizCamPass = document.getElementById('wizCamPass');
    const wizCamPath = document.getElementById('wizCamPath');
    const wizGeneratedRtsp = document.getElementById('wizGeneratedRtsp');
    const btnTestWizStream = document.getElementById('btnTestWizStream');
    const wizTestFeedback = document.getElementById('wizTestFeedback');
    const btnSaveWizCamera = document.getElementById('btnSaveWizCamera');

    // Panel 3: Gestión
    const wizActiveCount = document.getElementById('wizActiveCount');
    const activeCamerasCardsList = document.getElementById('activeCamerasCardsList');
    const btnGoToAddNewCamera = document.getElementById('btnGoToAddNewCamera');

    // Panel 4: Manual
    const manualRtspInput = document.getElementById('manualRtspInput');
    const testManualRtspBtn = document.getElementById('testManualRtspBtn');
    const manualTestResult = document.getElementById('manualTestResult');
    const assignManualCam1Btn = document.getElementById('assignManualCam1Btn');
    const assignManualCam2Btn = document.getElementById('assignManualCam2Btn');
    const btnAddNewManualCam = document.getElementById('btnAddNewManualCam');

    let currentSelectedBrand = 'v380';
    let isScanning = false;

    // Perfiles y guías técnicas para fabricantes
    const brandProfiles = {
        v380: {
            title: '📹 Guía de Configuración: V380 / V380 Pro',
            desc: 'Las cámaras V380 y V380 Pro transmiten RTSP en puertos 554, 8899, 8800 o 5054. La contraseña es la clave local que configuraste en la aplicación móvil V380 Pro.',
            tips: '💡 <strong>Paso Clave V380:</strong> Asegúrate de que la cámara esté conectada a tu router Wi-Fi. La contraseña suele ser la que definiste al registrar la cámara en la app V380 Pro. Si la dejaste sin contraseña, prueba usuario <code>admin</code> y clave vacía.',
            defaultPort: 554,
            defaultUser: 'admin',
            defaultPass: '',
            defaultPath: '/live/ch0'
        },
        ubox: {
            title: '🔋 Guía de Configuración: Ubox (Cámaras Solares / Batería PIR)',
            desc: 'Cámaras que utilizan la app móvil Ubox (chipsets Ingenic T20/T31 / módulo Wi-Fi AI-Link).',
            tips: "⚠️ <strong>Por qué Ubox se duerme:</strong> Para ahorrar batería, la cámara apaga la antena Wi-Fi y solo despierta cuando su sensor PIR detecta calor o abres la app en el celular.<br><br>👉 <strong>Para conectarla al sistema:</strong><br>1. Conéctala permanentemente con un cable USB de 5V (corriente continua).<br>2. En la app Ubox móvil: Ve a <em>Ajustes del dispositivo &gt; Modo de Energía</em> y selecciona <strong>'Modo Continuo / Siempre Encendida'</strong>.<br>3. Activa en la app la opción <strong>'Monitoreo LAN / Cliente PC'</strong> (si tu modelo la incluye) y define una contraseña.<br>4. Si el modelo es estrictamente 'P2P Cloud Only', no expone puerto RTSP local.",
            defaultPort: 554,
            defaultUser: 'admin',
            defaultPass: 'admin',
            defaultPath: '/live/ch0'
        },
        sehmua: {
            title: '🛡️ Guía de Configuración: Sehmua / Ubox',
            desc: 'Cámaras de seguridad exterior Sehmua y basadas en Ubox/Tuya.',
            tips: '⚠️ <strong>Diferencia Crítica en Sehmua:</strong> Si tu modelo Sehmua es solar a batería, entra en suspensión profunda y apaga el RTSP para no descargar la batería. Para videovigilancia continua debe mantenerse alimentada por cable a corriente. Si es modelo PTZ cableado, soporta RTSP estándar en puerto 554 con ruta <code>/live/ch0</code>.',
            defaultPort: 554,
            defaultUser: 'admin',
            defaultPass: 'admin',
            defaultPath: '/live/ch0'
        },
        tapo: {
            title: '📶 Guía de Configuración: TP-Link Tapo (C200, C310, C500, etc.)',
            desc: 'Las cámaras TP-Link Tapo usan el puerto RTSP 2020 y requieren habilitar una Cuenta de Cámara local en la app.',
            tips: '💡 <strong>Paso Tapo Obligatorio:</strong> Abre la app Tapo en tu móvil > Ajustes de cámara > Ajustes Avanzados > <strong>"Cuenta de la Cámara"</strong>. Crea usuario y contraseña allí y escríbelos abajo.',
            defaultPort: 2020,
            defaultUser: 'admin',
            defaultPass: '',
            defaultPath: '/stream1'
        },
        icam365: {
            title: '👁️ Guía de Configuración: iCam365 / EyePlus / Cloud Cam',
            desc: 'Cámaras domo y PTZ que utilizan la plataforma iCam365.',
            tips: '💡 <strong>Estándar iCam365:</strong> Puerto 554, usuario <code>admin</code> y contraseña <code>admin</code>. Ruta de alta definición: <code>/live/ch0</code>.',
            defaultPort: 554,
            defaultUser: 'admin',
            defaultPass: 'admin',
            defaultPath: '/live/ch0'
        },
        tuya: {
            title: '☁️ Guía de Configuración: Tuya / Smart Life',
            desc: 'Cámaras Tuya Smart / Smart Life integradas a través del Bridge local o RTSP.',
            tips: '💡 <strong>Bridge Local Tuya:</strong> Si usas el RTSP Bridge integrado en esta máquina, la URL es <code>rtsp://localhost:8554/Cámara_de_nubes/hd</code>.',
            defaultPort: 8554,
            defaultUser: '',
            defaultPass: '',
            defaultPath: '/Cámara_de_nubes/hd'
        },
        xm_icsee: {
            title: '📱 Guía de Configuración: iCSee / Xiongmai / XM',
            desc: 'Cámaras que operan con app iCSee o chipset Xiongmai.',
            tips: '💡 <strong>iCSee Defaults:</strong> Puerto 554, usuario <code>admin</code> y contraseña en blanco. Ruta HD: <code>/stream0</code>.',
            defaultPort: 554,
            defaultUser: 'admin',
            defaultPass: '',
            defaultPath: '/stream0'
        },
        yoosee: {
            title: '🎯 Guía de Configuración: Yoosee / CooCam',
            desc: 'Cámaras autónomas que se configuran con la app Yoosee.',
            tips: '💡 <strong>Yoosee Defaults:</strong> Activa RTSP en la app Yoosee (Ajustes > Ajustes NVR / Conexiones). La contraseña de fábrica suele ser <code>123456</code>.',
            defaultPort: 554,
            defaultUser: 'admin',
            defaultPass: '123456',
            defaultPath: '/onvif1'
        },
        dahua: {
            title: '🏢 Guía de Configuración: Dahua / Imou',
            desc: 'Cámaras Dahua e Imou Consumer.',
            tips: '💡 <strong>Imou/Dahua:</strong> En Imou la contraseña RTSP es el <strong>Safety Code</strong> impreso en la etiqueta de la cámara. Ruta estándar: <code>/cam/realmonitor?channel=1&subtype=0</code>.',
            defaultPort: 554,
            defaultUser: 'admin',
            defaultPass: '',
            defaultPath: '/cam/realmonitor?channel=1&subtype=0'
        },
        hikvision: {
            title: '🏛️ Guía de Configuración: Hikvision / Hilook / Ezviz',
            desc: 'Cámaras Hikvision, Hilook y Ezviz.',
            tips: '💡 <strong>Ezviz/Hikvision:</strong> Para Ezviz la contraseña es el Código de Verificación en mayúsculas de la etiqueta. Ruta principal: <code>/Streaming/Channels/101</code>.',
            defaultPort: 554,
            defaultUser: 'admin',
            defaultPass: '',
            defaultPath: '/Streaming/Channels/101'
        }
    };

    function openModal(tabTarget = 'panelWizRadar') {
        if (scannerModal) {
            scannerModal.style.display = 'flex';
            if (scanSubnetInput && !scanSubnetInput.value.trim()) {
                const localUrl = document.getElementById('localUrlDisplay')?.textContent || '';
                const m = localUrl.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.)/);
                scanSubnetInput.value = m ? m[1] : '192.168.1.';
            }
            switchWizardTab(tabTarget);
            loadActiveCamerasList();
        }
    }

    function closeModal() {
        if (scannerModal) scannerModal.style.display = 'none';
    }

    function switchWizardTab(targetId) {
        wizardPanels.forEach(panel => {
            panel.style.display = (panel.id === targetId) ? 'block' : 'none';
        });
        wizardTabs.forEach(tab => {
            tab.classList.toggle('active', tab.dataset.target === targetId);
        });
    }

    wizardTabs.forEach(tab => {
        tab.addEventListener('click', () => switchWizardTab(tab.dataset.target));
    });

    if (btnOpenScanner) btnOpenScanner.addEventListener('click', () => openModal('panelWizRadar'));
    if (tabAddCameraBtn) tabAddCameraBtn.addEventListener('click', () => openModal('panelWizBrands'));
    if (btnGoToAddNewCamera) btnGoToAddNewCamera.addEventListener('click', () => switchWizardTab('panelWizBrands'));
    if (scannerCloseBtn) scannerCloseBtn.addEventListener('click', closeModal);
    if (scannerCloseFooterBtn) scannerCloseFooterBtn.addEventListener('click', closeModal);
    if (scannerBackdrop) scannerBackdrop.addEventListener('click', closeModal);

    // Selección de Marcas en Asistente
    function applyBrandProfile(brandKey) {
        currentSelectedBrand = brandKey;
        const prof = brandProfiles[brandKey] || brandProfiles.v380;

        brandPills.forEach(p => p.classList.toggle('active', p.dataset.brand === brandKey));

        if (brandGuideTitle) brandGuideTitle.textContent = prof.title;
        if (brandGuideDesc) brandGuideDesc.textContent = prof.desc;
        if (brandGuideTips) brandGuideTips.innerHTML = prof.tips;

        if (wizCamPort) wizCamPort.value = prof.defaultPort;
        if (wizCamUser && (!wizCamUser.value || wizCamUser.value === 'admin')) wizCamUser.value = prof.defaultUser;
        if (wizCamPass && prof.defaultPass) wizCamPass.value = prof.defaultPass;
        if (wizCamPath) wizCamPath.value = prof.defaultPath;
        if (wizCamName && !wizCamName.value) {
            wizCamName.value = `Cámara ${brandKey.toUpperCase()}`;
        }

        recalculateGeneratedRtsp();
    }

    brandPills.forEach(pill => {
        pill.addEventListener('click', () => {
            applyBrandProfile(pill.dataset.brand);
        });
    });

    function recalculateGeneratedRtsp() {
        if (!wizGeneratedRtsp) return;
        const ip = wizCamIp ? wizCamIp.value.trim() : '';
        if (!ip) {
            wizGeneratedRtsp.value = 'Ingresa la IP de la cámara para generar el enlace RTSP...';
            return;
        }
        const port = wizCamPort ? wizCamPort.value.trim() : '554';
        const user = wizCamUser ? wizCamUser.value.trim() : '';
        const pass = wizCamPass ? wizCamPass.value.trim() : '';
        let path = wizCamPath ? wizCamPath.value.trim() : '/live/ch0';
        if (path && !path.startsWith('/') && !path.startsWith('?')) path = '/' + path;

        let auth = '';
        if (user || pass) {
            auth = `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`;
        }
        wizGeneratedRtsp.value = `rtsp://${auth}${ip}:${port}${path}`;
    }

    [wizCamIp, wizCamPort, wizCamUser, wizCamPass, wizCamPath].forEach(el => {
        if (el) el.addEventListener('input', recalculateGeneratedRtsp);
    });

    // Probar Stream en Asistente
    if (btnTestWizStream && wizTestFeedback) {
        btnTestWizStream.addEventListener('click', async () => {
            recalculateGeneratedRtsp();
            const rtspUrl = wizGeneratedRtsp.value.trim();
            if (!rtspUrl || !rtspUrl.startsWith('rtsp://')) {
                alert('Ingresa una dirección IP válida primero');
                return;
            }

            btnTestWizStream.disabled = true;
            btnTestWizStream.textContent = '⏳ Probando...';
            wizTestFeedback.style.display = 'none';

            try {
                const res = await fetch('/api/scanner/test_stream', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ rtsp_url: rtspUrl })
                });
                const result = await res.json();
                wizTestFeedback.style.display = 'inline-block';
                if (result.success) {
                    wizTestFeedback.className = 'device-test-feedback test-success';
                    wizTestFeedback.textContent = `✅ Video OK: ${result.resolution} (${result.latency_ms || 0}ms)`;
                } else {
                    wizTestFeedback.className = 'device-test-feedback test-error';
                    wizTestFeedback.textContent = `❌ ${result.error || 'No responde'}`;
                }
            } catch (e) {
                wizTestFeedback.style.display = 'inline-block';
                wizTestFeedback.className = 'device-test-feedback test-error';
                wizTestFeedback.textContent = `❌ Error: ${e.message || e}`;
            } finally {
                btnTestWizStream.disabled = false;
                btnTestWizStream.textContent = '🧪 Probar Conexión en Vivo';
            }
        });
    }

    // Guardar Cámara desde Asistente
    if (btnSaveWizCamera) {
        btnSaveWizCamera.addEventListener('click', async () => {
            recalculateGeneratedRtsp();
            const rtspUrl = wizGeneratedRtsp.value.trim();
            const name = wizCamName ? wizCamName.value.trim() : 'Nueva Cámara';

            if (!rtspUrl || !rtspUrl.startsWith('rtsp://')) {
                alert('Ingresa la IP y parámetros correctos para generar la URL RTSP');
                return;
            }

            btnSaveWizCamera.disabled = true;
            btnSaveWizCamera.textContent = 'Agregando...';

            try {
                const res = await fetch('/api/cameras', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: name,
                        rtsp_url: rtspUrl,
                        continuous_recording: false, // Por defecto en Modo MicroSD / Eventos para evitar 72 GB
                        motion_detection: true,
                        ai_detection: true
                    })
                });
                const result = await res.json();
                if (result.success) {
                    alert(`✅ ¡Cámara "${name}" agregada con éxito!\n\nID Asignado: ${result.camera_id}`);
                    closeModal();
                    refreshDynamicCameraTabs();
                    refreshActiveFeeds(true);
                    pollStatus();
                } else {
                    alert(`Error: ${result.error || 'No se pudo agregar la cámara'}`);
                }
            } catch (e) {
                alert(`❌ Error al agregar cámara: ${e.message || e}`);
            } finally {
                btnSaveWizCamera.disabled = false;
                btnSaveWizCamera.textContent = '➕ Agregar Esta Cámara al Sistema';
            }
        });
    }

    // Escanear Red (Radar)
    async function runNetworkScan() {
        if (isScanning) return;
        isScanning = true;

        const subnet = scanSubnetInput ? scanSubnetInput.value.trim() : '';
        if (startScanBtn) startScanBtn.disabled = true;
        if (startScanIcon) {
            startScanIcon.textContent = '📡';
            startScanIcon.classList.add('radar-spinning');
        }
        if (startScanText) startScanText.textContent = 'Escaneando Red...';
        if (scanStatusMsg) scanStatusMsg.textContent = 'Enviando sondas ONVIF y analizando puertos V380, Sehmua, Tapo, RTSP...';
        if (scanFoundCount) scanFoundCount.textContent = '0';

        let timerSeconds = 0;
        const timerInterval = setInterval(() => {
            timerSeconds += 0.2;
            if (scanCounterText) scanCounterText.textContent = `${timerSeconds.toFixed(1)}s transcurridos`;
        }, 200);

        try {
            const res = await fetch('/api/scanner/discover', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ subnet: subnet })
            });

            clearInterval(timerInterval);
            const data = await res.json();

            if (data.subnet_scanned && scanSubnetInput) {
                scanSubnetInput.value = data.subnet_scanned;
            }

            renderDiscoveredDevices(data.devices || []);
            if (scanStatusMsg) {
                scanStatusMsg.textContent = `✅ Escaneo completado en ${data.elapsed_seconds || 0}s. ${data.count || 0} dispositivo(s) encontrado(s).`;
            }
            if (scanFoundCount) scanFoundCount.textContent = `${data.count || 0}`;
        } catch (e) {
            clearInterval(timerInterval);
            console.error('Error en escaneo de red:', e);
            if (scanStatusMsg) scanStatusMsg.textContent = `❌ Error en el escaneo: ${e}`;
        } finally {
            isScanning = false;
            if (startScanBtn) startScanBtn.disabled = false;
            if (startScanIcon) {
                startScanIcon.textContent = '⚡';
                startScanIcon.classList.remove('radar-spinning');
            }
            if (startScanText) startScanText.textContent = 'Escanear Red Ahora';
        }
    }

    if (startScanBtn) startScanBtn.addEventListener('click', runNetworkScan);

    // Diagnóstico Forense de IP Directa (Ubox / Batería)
    async function runIpDiagnosis() {
        const targetIp = diagIpInput ? diagIpInput.value.trim() : '';
        if (!targetIp || !/^(\d{1,3}\.){3}\d{1,3}$/.test(targetIp)) {
            alert('Por favor ingresa una dirección IPv4 válida (ej: 192.168.1.28)');
            return;
        }

        if (btnDiagnoseIp) btnDiagnoseIp.disabled = true;
        if (btnDiagnoseIpIcon) btnDiagnoseIpIcon.textContent = '⏳';
        if (btnDiagnoseIpText) btnDiagnoseIpText.textContent = 'Analizando IP...';
        if (diagnoseResultBox) {
            diagnoseResultBox.style.display = 'block';
            diagnoseResultBox.innerHTML = `
                <div style="display: flex; align-items: center; gap: 0.5rem; color: #38bdf8;">
                    <span class="radar-spinning" style="display: inline-block;">⚙️</span>
                    <span>Ejecutando pruebas de Ping, consulta de tabla ARP (MAC), escaneo de 10 puertos y verificación RTSP en <strong>${targetIp}</strong>...</span>
                </div>
            `;
        }

        try {
            const res = await fetch('/api/scanner/diagnose_ip', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ip: targetIp })
            });
            const data = await res.json();
            renderIpDiagnosticResult(data);
        } catch (e) {
            if (diagnoseResultBox) {
                diagnoseResultBox.innerHTML = `
                    <div style="color: #ef4444; font-weight: 500;">❌ Error al conectar con el motor de diagnóstico: ${e.message || e}</div>
                `;
            }
        } finally {
            if (btnDiagnoseIp) btnDiagnoseIp.disabled = false;
            if (btnDiagnoseIpIcon) btnDiagnoseIpIcon.textContent = '🩺';
            if (btnDiagnoseIpText) btnDiagnoseIpText.textContent = 'Diagnosticar Esta IP';
        }
    }

    function renderIpDiagnosticResult(data) {
        if (!diagnoseResultBox) return;

        let statusBadge = '';
        if (data.status === 'online') {
            statusBadge = '<span style="background: rgba(34, 197, 94, 0.2); color: #4ade80; padding: 0.2rem 0.5rem; border-radius: 4px; font-weight: 600;">🟢 EN LÍNEA Y TRANSMITIENDO</span>';
        } else if (data.status === 'sleep_or_closed') {
            statusBadge = '<span style="background: rgba(245, 158, 11, 0.2); color: #fbbf24; padding: 0.2rem 0.5rem; border-radius: 4px; font-weight: 600;">💤 EN SUSPENSIÓN PROFUNDA / SIN PUERTOS</span>';
        } else if (data.status === 'rtsp_open_unauthenticated') {
            statusBadge = '<span style="background: rgba(56, 189, 248, 0.2); color: #38bdf8; padding: 0.2rem 0.5rem; border-radius: 4px; font-weight: 600;">🔑 RTSP ABIERTO (REQUIERE CLAVE)</span>';
        } else {
            statusBadge = '<span style="background: rgba(239, 68, 68, 0.2); color: #f87171; padding: 0.2rem 0.5rem; border-radius: 4px; font-weight: 600;">🔴 INALCANZABLE / APAGADO</span>';
        }

        const openPortsList = (data.open_ports && data.open_ports.length > 0)
            ? data.open_ports.map(p => `<code style="background: rgba(255,255,255,0.1); padding: 0.1rem 0.35rem; border-radius: 3px; color: #38bdf8;">${p}</code>`).join(' ')
            : '<span style="color: #94a3b8; font-style: italic;">Ninguno abierto</span>';

        const recHtml = (data.recommendations && data.recommendations.length > 0)
            ? `<div style="margin-top: 0.5rem; padding: 0.5rem; background: rgba(0,0,0,0.3); border-radius: 4px; border-left: 3px solid ${data.is_ubox ? '#fbbf24' : '#38bdf8'};">
                 <strong style="color: #cbd5e1; display: block; margin-bottom: 0.25rem;">Pasos recomendados:</strong>
                 <ul style="margin: 0; padding-left: 1.2rem; color: #94a3b8; line-height: 1.45;">
                   ${data.recommendations.map(r => `<li>${r}</li>`).join('')}
                 </ul>
               </div>`
            : '';

        let actionBtn = '';
        if (data.working_url) {
            actionBtn = `
                <div style="margin-top: 0.6rem;">
                    <button type="button" class="btn btn-xs btn-primary btn-use-diag-url" data-url="${data.working_url}" style="font-size: 0.75rem; padding: 0.3rem 0.7rem;">
                        ⚡ Cargar en Asistente de Cámaras
                    </button>
                </div>
            `;
        } else if (data.is_ubox || data.status === 'sleep_or_closed') {
            actionBtn = `
                <div style="margin-top: 0.6rem; display: flex; gap: 0.4rem; align-items: center;">
                    <button type="button" class="btn btn-xs btn-outline btn-go-ubox-guide" style="font-size: 0.72rem; padding: 0.3rem 0.6rem; border-color: #fbbf24; color: #fbbf24;">
                        📖 Ver Guía de Activación Ubox
                    </button>
                </div>
            `;
        }

        diagnoseResultBox.innerHTML = `
            <div style="display: flex; flex-direction: column; gap: 0.45rem;">
                <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.4rem; border-bottom: 1px solid rgba(255,255,255,0.06); padding-bottom: 0.4rem;">
                    <div>
                        <strong style="font-size: 0.85rem; color: #fff;">IP Analizada: ${data.ip}</strong>
                        ${data.is_ubox ? '<span style="margin-left: 0.4rem; font-size: 0.7rem; background: rgba(245, 158, 11, 0.25); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4); padding: 0.1rem 0.35rem; border-radius: 4px;">🔋 Detectada como Ubox / Solar</span>' : ''}
                    </div>
                    <div>${statusBadge}</div>
                </div>

                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.4rem; margin-top: 0.2rem; font-size: 0.74rem;">
                    <div><span style="color: #94a3b8;">Ping (ICMP):</span> <strong style="color: ${data.ping_ok ? '#4ade80' : '#f87171'};">${data.ping_ok ? `Responde (${data.latency_ms}ms)` : 'Sin respuesta / Caído'}</strong></div>
                    <div><span style="color: #94a3b8;">Dirección MAC:</span> <code style="color: #cbd5e1; font-family: var(--font-mono);">${data.mac || 'N/A'}</code></div>
                    <div style="grid-column: 1 / -1;"><span style="color: #94a3b8;">Fabricante / Hardware:</span> <span style="color: #e2e8f0; font-weight: 500;">${data.vendor || 'Desconocido'}</span></div>
                    <div style="grid-column: 1 / -1;"><span style="color: #94a3b8;">Puertos Abiertos:</span> ${openPortsList}</div>
                </div>

                <div style="margin-top: 0.3rem; color: #e2e8f0; line-height: 1.4;">
                    <strong>Dictamen:</strong> ${data.diagnosis || 'Análisis completado.'}
                </div>

                ${recHtml}
                ${actionBtn}
            </div>
        `;

        const btnUseUrl = diagnoseResultBox.querySelector('.btn-use-diag-url');
        if (btnUseUrl) {
            btnUseUrl.addEventListener('click', () => {
                const url = btnUseUrl.dataset.url;
                if (url) {
                    switchWizardTab('panelWizManual');
                    if (manualRtspInput) manualRtspInput.value = url;
                }
            });
        }

        const btnGoUbox = diagnoseResultBox.querySelector('.btn-go-ubox-guide');
        if (btnGoUbox) {
            btnGoUbox.addEventListener('click', () => {
                switchWizardTab('panelWizBrands');
                applyBrandProfile('ubox');
                if (wizCamIp) wizCamIp.value = data.ip;
                recalculateGeneratedRtsp();
            });
        }
    }

    if (btnDiagnoseIp) btnDiagnoseIp.addEventListener('click', runIpDiagnosis);

    function renderDiscoveredDevices(devices) {
        if (!scannedDevicesList) return;
        scannedDevicesList.innerHTML = '';

        if (!devices || devices.length === 0) {
            scannedDevicesList.innerHTML = `
                <div class="empty-scan-state" style="text-align: center; padding: 1.8rem 1rem; background: rgba(255,255,255,0.02); border: 1px dashed rgba(255,255,255,0.1); border-radius: 8px;">
                    <span style="font-size: 2rem; display: block; margin-bottom: 0.4rem;">⚠️</span>
                    <p style="color: #cbd5e1; font-size: 0.85rem; margin: 0; font-weight: 500;">No se detectaron cámaras en esta subred.</p>
                    <p style="color: #94a3b8; font-size: 0.74rem; margin-top: 0.3rem;">
                        Verifica que la cámara esté encendida, conectada a tu Wi-Fi o router y prueba cambiar la subred (ej: <strong>192.168.0.</strong>).
                    </p>
                </div>
            `;
            return;
        }

        devices.forEach((dev, idx) => {
            const card = document.createElement('div');
            card.className = 'scanned-device-card';
            card.id = `scannedCard_${idx}`;

            const openPortsStr = (dev.open_ports || []).map(p => `:${p}`).join(', ') || '554';
            const initialRtsp = dev.suggested_rtsp || `rtsp://admin:admin@${dev.ip}:554/live/ch0`;

            card.innerHTML = `
                <div class="device-header">
                    <div class="device-title-wrap">
                        <div class="device-icon-box">📹</div>
                        <div>
                            <div style="display: flex; align-items: center; gap: 0.5rem;">
                                <span class="device-ip-badge">${dev.ip}</span>
                                <strong style="color: #f8fafc; font-size: 0.88rem;">${dev.name || 'Cámara IP'}</strong>
                            </div>
                            <div style="font-size: 0.72rem; color: #94a3b8; margin-top: 0.15rem;">
                                MAC: <span style="font-family: var(--font-mono); color: #cbd5e1;">${dev.mac || 'N/A'}</span>
                            </div>
                        </div>
                    </div>
                    <div class="device-meta-pills">
                        <span class="device-pill pill-hardware">🏷️ ${dev.hardware || 'Cámara'}</span>
                        <span class="device-pill">🔌 Puertos ${openPortsStr}</span>
                        <span class="device-pill pill-online">🟢 Online (${dev.latency_ms || 10}ms)</span>
                    </div>
                </div>

                <div class="device-url-box">
                    <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.74rem; color: #cbd5e1;">
                        <span><strong>URL RTSP sugerida:</strong></span>
                        <div style="display: flex; gap: 0.4rem; align-items: center;">
                            <span style="font-size: 0.7rem; color: #94a3b8;">Preset:</span>
                            <select class="device-preset-select" data-ip="${dev.ip}" style="background: rgba(0,0,0,0.6); border: 1px solid rgba(255,255,255,0.15); color: #f8fafc; font-size: 0.72rem; padding: 0.15rem 0.4rem; border-radius: 4px;">
                                <option value="custom">✏️ Personalizada</option>
                                <option value="v380" ${dev.name?.includes('V380') ? 'selected' : ''}>V380 / V380 Pro (:554/live/ch0)</option>
                                <option value="sehmua" ${dev.name?.includes('Sehmua') ? 'selected' : ''}>Sehmua / Ubox (:554/live/ch0)</option>
                                <option value="tapo" ${dev.name?.includes('Tapo') ? 'selected' : ''}>TP-Link Tapo (:2020/stream1)</option>
                                <option value="icam365" ${(!dev.name?.includes('V380') && !dev.name?.includes('Sehmua') && !dev.name?.includes('Tapo')) ? 'selected' : ''}>iCam365 / EyePlus (admin:admin)</option>
                                <option value="xm_icsee">iCSee / Xiongmai (admin:@)</option>
                                <option value="yoosee">Yoosee (admin:123456)</option>
                                <option value="dahua">Dahua / Imou</option>
                                <option value="hikvision">Hikvision / Hilook</option>
                            </select>
                        </div>
                    </div>

                    <input type="text" class="device-rtsp-input" value="${initialRtsp}" placeholder="rtsp://usuario:clave@${dev.ip}:554/live/ch0">

                    <div class="device-actions-row">
                        <div style="display: flex; align-items: center; gap: 0.5rem;">
                            <button type="button" class="btn btn-xs btn-outline btn-test-stream" data-idx="${idx}">
                                🧪 Probar Video
                            </button>
                            <span class="device-test-feedback" id="testFeedback_${idx}" style="display: none;"></span>
                        </div>

                        <div style="display: flex; gap: 0.4rem; flex-wrap: wrap;">
                            <button type="button" class="btn btn-xs btn-outline btn-assign-cam" data-cam="cam1" data-idx="${idx}">
                                📌 Aplicar a Cam 1
                            </button>
                            <button type="button" class="btn btn-xs btn-outline btn-assign-cam" data-cam="cam2" data-idx="${idx}">
                                📌 Aplicar a Cam 2
                            </button>
                            <button type="button" class="btn btn-xs btn-primary btn-add-as-new-cam" data-idx="${idx}" style="background: #00ff66; color: #000; font-weight: 600;">
                                ➕ Agregar como Nueva Cámara
                            </button>
                        </div>
                    </div>
                </div>
            `;

            scannedDevicesList.appendChild(card);

            const presetSelect = card.querySelector('.device-preset-select');
            const rtspInput = card.querySelector('.device-rtsp-input');

            presetSelect.addEventListener('change', () => {
                const pVal = presetSelect.value;
                if (pVal === 'v380') {
                    rtspInput.value = `rtsp://admin:@${dev.ip}:554/live/ch0`;
                } else if (pVal === 'sehmua') {
                    rtspInput.value = `rtsp://admin:admin@${dev.ip}:554/live/ch0`;
                } else if (pVal === 'tapo') {
                    rtspInput.value = `rtsp://admin:@${dev.ip}:2020/stream1`;
                } else if (pVal === 'icam365') {
                    rtspInput.value = `rtsp://admin:admin@${dev.ip}:554/live/ch0`;
                } else if (pVal === 'xm_icsee') {
                    rtspInput.value = `rtsp://admin:@${dev.ip}:554/stream0`;
                } else if (pVal === 'yoosee') {
                    rtspInput.value = `rtsp://admin:123456@${dev.ip}:554/onvif1`;
                } else if (pVal === 'dahua') {
                    rtspInput.value = `rtsp://admin:admin123@${dev.ip}:554/cam/realmonitor?channel=1&subtype=0`;
                } else if (pVal === 'hikvision') {
                    rtspInput.value = `rtsp://admin:12345@${dev.ip}:554/Streaming/Channels/101`;
                }
            });

            // Probar stream individual
            const testBtn = card.querySelector('.btn-test-stream');
            const feedbackSpan = card.querySelector(`#testFeedback_${idx}`);

            testBtn.addEventListener('click', async () => {
                const rtspUrl = rtspInput.value.trim();
                testBtn.disabled = true;
                testBtn.textContent = '⏳ Probando...';
                feedbackSpan.style.display = 'none';

                try {
                    const res = await fetch('/api/scanner/test_stream', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ rtsp_url: rtspUrl })
                    });
                    const result = await res.json();
                    feedbackSpan.style.display = 'inline-block';
                    if (result.success) {
                        feedbackSpan.className = 'device-test-feedback test-success';
                        feedbackSpan.textContent = `✅ Video OK: ${result.resolution} (${result.latency_ms || 0}ms)`;
                    } else {
                        feedbackSpan.className = 'device-test-feedback test-error';
                        feedbackSpan.textContent = `❌ ${result.error || 'Error'}`;
                    }
                } catch (e) {
                    feedbackSpan.style.display = 'inline-block';
                    feedbackSpan.className = 'device-test-feedback test-error';
                    feedbackSpan.textContent = `❌ Error: ${e}`;
                } finally {
                    testBtn.disabled = false;
                    testBtn.textContent = '🧪 Probar Video';
                }
            });

            // Aplicar a Cam 1 / Cam 2 existentes
            const assignBtns = card.querySelectorAll('.btn-assign-cam');
            assignBtns.forEach(abtn => {
                abtn.addEventListener('click', async () => {
                    const targetCam = abtn.dataset.cam;
                    const rtspUrl = rtspInput.value.trim();
                    const camName = dev.name || `Cámara (${dev.ip})`;

                    abtn.disabled = true;
                    abtn.textContent = 'Guardando...';

                    try {
                        const res = await fetch('/api/scanner/apply', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                camera_id: targetCam,
                                rtsp_url: rtspUrl,
                                name: camName
                            })
                        });
                        const result = await res.json();
                        if (result.success) {
                            alert(`✅ ¡${targetCam.toUpperCase()} actualizada a ${dev.ip} con éxito!`);
                            closeModal();
                            refreshActiveFeeds(true);
                            pollStatus();
                        } else {
                            alert(`Error: ${result.error || 'No se pudo aplicar'}`);
                        }
                    } catch (e) {
                        alert(`❌ ${e.message || e}`);
                    } finally {
                        abtn.disabled = false;
                        abtn.textContent = targetCam === 'cam1' ? '📌 Aplicar a Cam 1' : '📌 Aplicar a Cam 2';
                    }
                });
            });

            // Agregar como nueva cámara ilimitada
            const addAsNewBtn = card.querySelector('.btn-add-as-new-cam');
            if (addAsNewBtn) {
                addAsNewBtn.addEventListener('click', async () => {
                    const rtspUrl = rtspInput.value.trim();
                    const camName = dev.name || `Cámara IP (${dev.ip})`;

                    addAsNewBtn.disabled = true;
                    addAsNewBtn.textContent = 'Agregando...';

                    try {
                        const res = await fetch('/api/cameras', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                name: camName,
                                rtsp_url: rtspUrl,
                                continuous_recording: false,
                                motion_detection: true,
                                ai_detection: true
                            })
                        });
                        const result = await res.json();
                        if (result.success) {
                            alert(`✅ ¡Cámara agregada al sistema con éxito! (ID: ${result.camera_id})`);
                            closeModal();
                            refreshDynamicCameraTabs();
                            refreshActiveFeeds(true);
                            pollStatus();
                        } else {
                            alert(`Error: ${result.error || 'No se pudo agregar'}`);
                        }
                    } catch (e) {
                        alert(`❌ Error al agregar: ${e.message || e}`);
                    } finally {
                        addAsNewBtn.disabled = false;
                        addAsNewBtn.textContent = '➕ Agregar como Nueva Cámara';
                    }
                });
            }
        });
    }

    // Panel 3: Cargar y administrar cámaras activas
    async function loadActiveCamerasList() {
        if (!activeCamerasCardsList) return;
        activeCamerasCardsList.innerHTML = '<div style="text-align: center; color: #94a3b8; padding: 1rem;">Cargando cámaras...</div>';

        try {
            const res = await fetch('/api/cameras');
            if (!res.ok) throw new Error('Error al consultar cámaras');
            const data = await res.json();
            const list = data.cameras || [];

            if (wizActiveCount) wizActiveCount.textContent = `${list.length}`;
            activeCamerasCardsList.innerHTML = '';

            if (list.length === 0) {
                activeCamerasCardsList.innerHTML = '<div style="color: #94a3b8; text-align: center; padding: 1.5rem;">No hay cámaras configuradas.</div>';
                return;
            }

            list.forEach(cam => {
                const card = document.createElement('div');
                card.className = 'camera-manage-card';

                const onlineBadge = cam.online
                    ? '<span class="cam-meta-badge badge-online">🟢 Conectada</span>'
                    : '<span class="cam-meta-badge badge-offline">🔴 Desconectada</span>';

                const recBadge = cam.continuous_recording
                    ? '<span class="cam-meta-badge" style="color: #38bdf8; border-color: rgba(56, 189, 248, 0.3);">REC 24/7</span>'
                    : '<span class="cam-meta-badge" style="color: #00ff66; border-color: rgba(0, 255, 102, 0.3);">Modo MicroSD (Eventos)</span>';

                card.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 0.75rem; flex: 1; min-width: 240px;">
                        <span style="font-size: 1.5rem;">📹</span>
                        <div>
                            <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
                                <strong style="color: #f8fafc; font-size: 0.88rem;">${cam.name}</strong>
                                <span style="font-size: 0.7rem; font-family: var(--font-mono); color: #94a3b8;">[${cam.id}]</span>
                                ${onlineBadge}
                                ${recBadge}
                            </div>
                            <div style="font-size: 0.72rem; color: #64748b; font-family: var(--font-mono); margin-top: 0.15rem; word-break: break-all;">
                                ${cam.rtsp_url}
                            </div>
                        </div>
                    </div>

                    <div style="display: flex; gap: 0.4rem; align-items: center;">
                        <button type="button" class="btn btn-xs btn-outline btn-toggle-rec-cam" data-id="${cam.id}" data-rec="${cam.continuous_recording}">
                            ${cam.continuous_recording ? '🎯 Cambiar a MicroSD' : '📼 Cambiar a 24/7'}
                        </button>
                        <button type="button" class="btn btn-xs btn-outline btn-delete-cam" data-id="${cam.id}" data-name="${cam.name}" style="border-color: rgba(239, 68, 68, 0.4); color: #fca5a5;">
                            🗑️ Eliminar
                        </button>
                    </div>
                `;

                activeCamerasCardsList.appendChild(card);

                // Alternar modo de grabación individual
                const toggleRecBtn = card.querySelector('.btn-toggle-rec-cam');
                toggleRecBtn.addEventListener('click', async () => {
                    const newContinuous = !cam.continuous_recording;
                    toggleRecBtn.disabled = true;
                    try {
                        const r = await fetch('/api/cameras', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                id: cam.id,
                                continuous_recording: newContinuous
                            })
                        });
                        const resData = await r.json();
                        if (resData.success) {
                            loadActiveCamerasList();
                            pollStatus();
                        } else {
                            alert(`Error: ${resData.error || 'No se pudo actualizar'}`);
                        }
                    } catch (e) {
                        alert(`❌ ${e.message || e}`);
                    } finally {
                        toggleRecBtn.disabled = false;
                    }
                });

                // Eliminar cámara
                const delBtn = card.querySelector('.btn-delete-cam');
                delBtn.addEventListener('click', async () => {
                    if (!confirm(`¿Estás seguro de eliminar la cámara "${cam.name}" (${cam.id}) del sistema?`)) return;
                    delBtn.disabled = true;
                    try {
                        const r = await fetch(`/api/cameras/${cam.id}`, { method: 'DELETE' });
                        const resData = await r.json();
                        if (resData.success) {
                            loadActiveCamerasList();
                            refreshDynamicCameraTabs();
                            refreshActiveFeeds(true);
                            pollStatus();
                        } else {
                            alert(`Error: ${resData.error || 'No se pudo eliminar'}`);
                        }
                    } catch (e) {
                        alert(`❌ ${e.message || e}`);
                    } finally {
                        delBtn.disabled = false;
                    }
                });
            });
        } catch (e) {
            console.error('Error cargando cámaras activas:', e);
            if (activeCamerasCardsList) {
                activeCamerasCardsList.innerHTML = `<div style="color: #f87171; text-align: center; padding: 1rem;">❌ Error cargando lista: ${e.message || e}</div>`;
            }
        }
    }

    // Diagnóstico Manual
    if (testManualRtspBtn && manualRtspInput && manualTestResult) {
        testManualRtspBtn.addEventListener('click', async () => {
            const rtspUrl = manualRtspInput.value.trim();
            if (!rtspUrl) {
                alert('Ingresa una URL RTSP primero');
                return;
            }
            testManualRtspBtn.disabled = true;
            testManualRtspBtn.textContent = '⏳ Probando...';
            manualTestResult.style.display = 'none';

            try {
                const res = await fetch('/api/scanner/test_stream', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ rtsp_url: rtspUrl })
                });
                let result = {};
                try {
                    result = await res.json();
                } catch (pe) {
                    throw new Error(`Código ${res.status}`);
                }
                manualTestResult.style.display = 'block';
                if (result.success) {
                    manualTestResult.className = 'device-test-feedback test-success';
                    manualTestResult.textContent = `✅ Video OK: ${result.resolution} (${result.latency_ms || 0}ms)`;
                } else {
                    manualTestResult.className = 'device-test-feedback test-error';
                    manualTestResult.textContent = `❌ ${result.error || 'Fallo de conexión'}`;
                }
            } catch (e) {
                manualTestResult.style.display = 'block';
                manualTestResult.className = 'device-test-feedback test-error';
                manualTestResult.textContent = `❌ Error: ${e.message || e}`;
            } finally {
                testManualRtspBtn.disabled = false;
                testManualRtspBtn.textContent = '🧪 Probar Stream';
            }
        });
    }

    async function assignManualUrl(targetCam) {
        const rtspUrl = manualRtspInput ? manualRtspInput.value.trim() : '';
        if (!rtspUrl) {
            alert('Ingresa una URL RTSP primero');
            return;
        }

        try {
            const res = await fetch('/api/scanner/apply', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    camera_id: targetCam,
                    rtsp_url: rtspUrl
                })
            });
            const result = await res.json();
            if (result.success) {
                alert(`✅ ¡${targetCam.toUpperCase()} configurada y reconectada con éxito!`);
                closeModal();
                refreshActiveFeeds();
                pollStatus();
            } else {
                alert(`Error: ${result.error || 'No se pudo guardar la URL'}`);
            }
        } catch (e) {
            alert(`❌ ${e.message || e}`);
        }
    }

    if (assignManualCam1Btn) assignManualCam1Btn.addEventListener('click', () => assignManualUrl('cam1'));
    if (assignManualCam2Btn) assignManualCam2Btn.addEventListener('click', () => assignManualUrl('cam2'));

    if (btnAddNewManualCam) {
        btnAddNewManualCam.addEventListener('click', async () => {
            const rtspUrl = manualRtspInput ? manualRtspInput.value.trim() : '';
            if (!rtspUrl) {
                alert('Ingresa una URL RTSP o índice de cámara primero');
                return;
            }
            const name = prompt('Nombre para esta nueva cámara:', 'Cámara Extra');
            if (!name) return;

            btnAddNewManualCam.disabled = true;
            try {
                const res = await fetch('/api/cameras', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: name,
                        rtsp_url: rtspUrl,
                        continuous_recording: false,
                        motion_detection: true,
                        ai_detection: true
                    })
                });
                const result = await res.json();
                if (result.success) {
                    alert(`✅ ¡Cámara "${name}" agregada con éxito!`);
                    closeModal();
                    refreshDynamicCameraTabs();
                    refreshActiveFeeds(true);
                    pollStatus();
                } else {
                    alert(`Error: ${result.error || 'No se pudo agregar'}`);
                }
            } catch (e) {
                alert(`❌ Error al agregar: ${e.message || e}`);
            } finally {
                btnAddNewManualCam.disabled = false;
            }
        });
    }

    // Botones de Restauración de Fábrica
    const btnRestoreCam1Tuya = document.getElementById('btnRestoreCam1Tuya');
    const btnRestoreCam2Icam = document.getElementById('btnRestoreCam2Icam');

    if (btnRestoreCam1Tuya) {
        btnRestoreCam1Tuya.addEventListener('click', async () => {
            if (!confirm('¿Deseas restaurar Cámara 1 a Tuya Bridge (rtsp://localhost:8554/Cámara_de_nubes/hd)?')) return;
            try {
                const res = await fetch('/api/scanner/apply', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        camera_id: 'cam1',
                        rtsp_url: 'rtsp://localhost:8554/Cámara_de_nubes/hd',
                        name: 'Cámara 1 (Tuya PTZ)'
                    })
                });
                const result = await res.json();
                if (result.success) {
                    alert('✅ Cámara 1 restaurada al Bridge Tuya correctamente.');
                    closeModal();
                    refreshActiveFeeds();
                    pollStatus();
                }
            } catch (e) {
                alert(`❌ Error: ${e.message || e}`);
            }
        });
    }

    if (btnRestoreCam2Icam) {
        btnRestoreCam2Icam.addEventListener('click', async () => {
            if (!confirm('¿Deseas restaurar Cámara 2 a iCam365 estándar (rtsp://admin:admin@192.168.1.18:554/live/ch0)?')) return;
            try {
                const res = await fetch('/api/scanner/apply', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        camera_id: 'cam2',
                        rtsp_url: 'rtsp://admin:admin@192.168.1.18:554/live/ch0',
                        name: 'Cámara 2 (iCam365)'
                    })
                });
                const result = await res.json();
                if (result.success) {
                    alert('✅ Cámara 2 restaurada a iCam365 correctamente.');
                    closeModal();
                    refreshActiveFeeds();
                    pollStatus();
                } else {
                    alert(`Error: ${result.error || 'No se pudo restaurar'}`);
                }
            } catch (e) {
                alert(`❌ Error: ${e.message || e}`);
            }
        });
    }

    // Iniciar con la marca V380 seleccionada
    applyBrandProfile('v380');
}

// Inicialización al cargar la página
document.addEventListener('DOMContentLoaded', () => {
    // En celulares: evitar el Mosaico Dual (2 streams MJPEG simultáneos saturan Safari/Chrome móvil)
    // Arrancar en vista individual Cámara 1 para fluido total desde el primer frame
    if (isMobileDevice) {
        currentViewMode = 'cam1';
        if (tabMosaic) tabMosaic.classList.remove('active');
        if (tabCam1) tabCam1.classList.add('active');
        if (tabCam2) tabCam2.classList.remove('active');
        if (mosaicContainer) mosaicContainer.className = 'mosaic-container mode-cam1';
        if (activeViewTag) activeViewTag.textContent = 'Cámara 1: Tuya PTZ (Full)';
        console.log('📱 Móvil detectado: arrancando en vista individual para máxima fluidez');
    }

    updateEngineUI();
    initQualityControls();
    initSidebarTabNavigation();
    initSSE();
    initPtzControls();
    initScheduleControls();
    initPerCameraControls();
    initSystemCapabilities();
    initStorageOptimizationModal();
    initNetworkScannerModal();
    refreshDynamicCameraTabs();
    pollStatus();
    setInterval(pollStatus, 2500);
});