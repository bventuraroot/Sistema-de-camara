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

// En MÓVIL: siempre forzar 'mobile' para decodificación suave y 0 lag
let currentStreamQuality;
if (isMobileDevice) {
    currentStreamQuality = 'mobile';
    localStorage.removeItem('camera_stream_quality');
    console.log('📱 Dispositivo móvil: forzando modo mobile ultra-ligero (640x360)');
} else {
    currentStreamQuality = localStorage.getItem('camera_stream_quality') || 'efficient';
}
const streamQualitySelect = document.getElementById('streamQualitySelect');

function getFeedUrl(cid) {
    return `/video_feed/${cid}?quality=${currentStreamQuality}&t=${Date.now()}`;
}

function refreshActiveFeeds(force = false) {
    if (isMobileDevice) {
        // En celulares: decodificar 2 streams MJPEG a la vez satura la GPU/CPU móvil.
        // Se conecta de forma óptima la cámara que el usuario está viendo y se pausa la oculta con BLANK_FRAME.
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
        } else { // mosaic en móvil
            if (videoFeedCam1 && (!videoFeedCam1.src || !videoFeedCam1.src.includes('/video_feed/cam1') || force)) {
                videoFeedCam1.src = getFeedUrl('cam1');
            }
            if (videoFeedCam2 && (!videoFeedCam2.src || !videoFeedCam2.src.includes('/video_feed/cam2') || force)) {
                videoFeedCam2.src = getFeedUrl('cam2');
            }
        }
    } else {
        // En PC: ambas cámaras se mantienen conectadas para cambio de pestaña instantáneo en 0 ms
        if (videoFeedCam1 && (!videoFeedCam1.src || !videoFeedCam1.src.includes('/video_feed/cam1') || force)) {
            videoFeedCam1.src = getFeedUrl('cam1');
        }
        if (videoFeedCam2 && (!videoFeedCam2.src || !videoFeedCam2.src.includes('/video_feed/cam2') || force)) {
            videoFeedCam2.src = getFeedUrl('cam2');
        }
    }
    // Ocultar botones de reconexión residuales
    if (reloadCam1Btn) reloadCam1Btn.style.display = 'none';
    if (reloadCam2Btn) reloadCam2Btn.style.display = 'none';
}

if (streamQualitySelect) {
    streamQualitySelect.value = currentStreamQuality;
    streamQualitySelect.addEventListener('change', () => {
        currentStreamQuality = streamQualitySelect.value;
        localStorage.setItem('camera_stream_quality', currentStreamQuality);
        console.log(`📶 Calidad de transmisión cambiada a: ${currentStreamQuality}`);
        refreshActiveFeeds(true);
    });
}

// Reanudar suavemente transmisiones cuando el usuario vuelve a la app o desbloquea el teléfono
let lastVisibilityResumeTime = 0;
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        const now = Date.now();
        if (now - lastVisibilityResumeTime > 4000) {
            lastVisibilityResumeTime = now;
            console.log('📱 Dispositivo reanudado: verificando flujos de video...');
            refreshActiveFeeds(false);
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

// Watchdogs de reconexión para ambas cámaras
let isRecoveringCam1 = false;
let isRecoveringCam2 = false;
let cam1FailCount = 0;
let cam2FailCount = 0;

function reloadCam1() {
    if (!videoFeedCam1 || isRecoveringCam1) return;
    if (isMobileDevice && currentViewMode === 'cam2') return;
    isRecoveringCam1 = true;
    if (reloadCam1Btn) reloadCam1Btn.style.display = 'none';
    console.log('🔄 Reconectando Cámara 1...');
    videoFeedCam1.src = getFeedUrl('cam1');
    setTimeout(() => { isRecoveringCam1 = false; }, 2000);
}

function reloadCam2() {
    if (!videoFeedCam2 || isRecoveringCam2) return;
    if (isMobileDevice && currentViewMode === 'cam1') return;
    isRecoveringCam2 = true;
    if (reloadCam2Btn) reloadCam2Btn.style.display = 'none';
    console.log('🔄 Reconectando Cámara 2...');
    videoFeedCam2.src = getFeedUrl('cam2');
    setTimeout(() => { isRecoveringCam2 = false; }, 2000);
}

if (videoFeedCam1) {
    videoFeedCam1.addEventListener('error', () => {
        if (!videoFeedCam1.src || videoFeedCam1.src.startsWith('data:')) return;
        cam1FailCount++;
        if (cam1FailCount >= 3 && reloadCam1Btn && (!isMobileDevice || currentViewMode !== 'cam2')) {
            reloadCam1Btn.style.display = 'inline-flex';
        }
        setTimeout(reloadCam1, 1500);
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
        if (!videoFeedCam2.src || videoFeedCam2.src.startsWith('data:')) return;
        cam2FailCount++;
        if (cam2FailCount >= 3 && reloadCam2Btn && (!isMobileDevice || currentViewMode !== 'cam1')) {
            reloadCam2Btn.style.display = 'inline-flex';
        }
        setTimeout(reloadCam2, 1500);
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

        try {
            const res = await fetch('/api/schedule', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled, start_time, end_time, days, target_cameras })
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

    refreshActiveFeeds();
    initSSE();
    initPtzControls();
    initScheduleControls();
    initPerCameraControls();
    initSystemCapabilities();
    pollStatus();
    setInterval(pollStatus, 2500);
});
