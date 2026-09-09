// ==========================================================================
// MEDIATECA & GESTIÓN DE GRABACIONES - JAVASCRIPT CLIENTE
// Navegación cronológica interactiva por Día y Hora (24 Horas)
// ==========================================================================

let allMediaItems = [];
let selectedItemIds = new Set();
let currentFilterType = 'all';
let currentFilterCam = 'all';
let currentFilterDate = getDaysAgoStr(0); // Por defecto: Hoy
let currentFilterHour = 'all';           // 'all' | 0..23
let currentViewMode = 'grid';            // 'grid' | 'list'
let currentPlaylist = [];                // Lista de reproducción cronológica activa
let currentPlaylistIndex = -1;
let activeModalItem = null;

// Paginación Inteligente (evita sobrecargar el navegador con 100+ elementos simultáneos)
let currentPage = 1;
const itemsPerPage = 24;

// Elementos DOM Principales
const mediaGrid = document.getElementById('mediaGrid');
const timelineListView = document.getElementById('timelineListView');
const timelineListBody = document.getElementById('timelineListBody');
const reloadMediaBtn = document.getElementById('reloadMediaBtn');
const refreshStorageBtn = document.getElementById('refreshStorageBtn');
const selectAllCheckbox = document.getElementById('selectAllCheckbox');
const selectAllListCheckbox = document.getElementById('selectAllListCheckbox');
const selectedCountText = document.getElementById('selectedCountText');
const deleteSelectedBtn = document.getElementById('deleteSelectedBtn');
const openPurgeModalBtn = document.getElementById('openPurgeModalBtn');
const openRetentionBtn = document.getElementById('openRetentionBtn');
const purge1Btn = document.getElementById('purge1Btn');
const purge3Btn = document.getElementById('purge3Btn');
const purge7Btn = document.getElementById('purge7Btn');
const purge15Btn = document.getElementById('purge15Btn');
const purgeDateBtn = document.getElementById('purgeDateBtn');

// Elementos del Modal de Purga Inteligente
const purgeModal = document.getElementById('purgeModal');
const closePurgeModalBtn = document.getElementById('closePurgeModalBtn');
const cancelPurgeBtn = document.getElementById('cancelPurgeBtn');
const purgeModalBackdrop = document.getElementById('purgeModalBackdrop');
const tabManualPurge = document.getElementById('tabManualPurge');
const tabAutoRetention = document.getElementById('tabAutoRetention');
const panelManualPurge = document.getElementById('panelManualPurge');
const panelAutoRetention = document.getElementById('panelAutoRetention');
const purgeFooterControls = document.getElementById('purgeFooterControls');
const purgeCustomDaysInput = document.getElementById('purgeCustomDaysInput');
const cutoffDateHintText = document.getElementById('cutoffDateHintText');
const previewStatusBadge = document.getElementById('previewStatusBadge');
const previewCountVal = document.getElementById('previewCountVal');
const previewSizeVal = document.getElementById('previewSizeVal');
const previewBreakdownText = document.getElementById('previewBreakdownText');
const executePurgeBtn = document.getElementById('executePurgeBtn');
const retentionDaysInput = document.getElementById('retentionDaysInput');
const autoPurgeEnabledToggle = document.getElementById('autoPurgeEnabledToggle');
const saveRetentionBtn = document.getElementById('saveRetentionBtn');

// Elementos de Paginación
const paginationBar = document.getElementById('paginationBar');
const paginationInfo = document.getElementById('paginationInfo');
const pageIndicator = document.getElementById('pageIndicator');
const prevPageBtn = document.getElementById('prevPageBtn');
const nextPageBtn = document.getElementById('nextPageBtn');

// Controles de Día y Hora
const quickDaysGroup = document.getElementById('quickDaysGroup');
const dateFilterInput = document.getElementById('dateFilterInput');
const clearDateFilterBtn = document.getElementById('clearDateFilterBtn');
const timelineHoursStrip = document.getElementById('timelineHoursStrip');
const allHoursBtn = document.getElementById('allHoursBtn');
const timelineSelectedDayBadge = document.getElementById('timelineSelectedDayBadge');

// Elementos del Calendario Visual de Grabaciones
const calendarSectionCard = document.getElementById('calendarSectionCard');
const toggleCalendarBtn = document.getElementById('toggleCalendarBtn');
const calPrevMonthBtn = document.getElementById('calPrevMonthBtn');
const calNextMonthBtn = document.getElementById('calNextMonthBtn');
const calTodayBtn = document.getElementById('calTodayBtn');
const calendarMonthTitle = document.getElementById('calendarMonthTitle');
const calendarDaysGrid = document.getElementById('calendarDaysGrid');
const calSelectedDateText = document.getElementById('calSelectedDateText');
const calSelectedDayStatsBadge = document.getElementById('calSelectedDayStatsBadge');
const calFilterDayBtn = document.getElementById('calFilterDayBtn');
const calPurgeDayBtn = document.getElementById('calPurgeDayBtn');

let calendarSummaryData = {};
let currentCalYear = new Date().getFullYear();
let currentCalMonth = new Date().getMonth(); // 0..11

// Conmutador de Vistas
const viewModeGridBtn = document.getElementById('viewModeGridBtn');
const viewModeListBtn = document.getElementById('viewModeListBtn');

// Modal de Reproductor Multimedia
const mediaPlayerModal = document.getElementById('mediaPlayerModal');
const playerVideo = document.getElementById('playerVideo');
const playerImage = document.getElementById('playerImage');
const playerTitle = document.getElementById('playerTitle');
const playerSubtitle = document.getElementById('playerSubtitle');
const playerTimeBadge = document.getElementById('playerTimeBadge');
const autoPlayNextToggle = document.getElementById('autoPlayNextToggle');
const playerPrevBtn = document.getElementById('playerPrevBtn');
const playerNextBtn = document.getElementById('playerNextBtn');
const playlistCounter = document.getElementById('playlistCounter');
const closePlayerBtn = document.getElementById('closePlayerBtn');
const modalBackdrop = document.getElementById('modalBackdrop');
const playerDownloadBtn = document.getElementById('playerDownloadBtn');
const playerDeleteBtn = document.getElementById('playerDeleteBtn');
const videoSpeedControls = document.getElementById('videoSpeedControls');
const jumpBackBtn = document.getElementById('jumpBackBtn');
const jumpForwardBtn = document.getElementById('jumpForwardBtn');

// ----------------- UTILIDADES DE FECHA Y HORA -----------------
function getDaysAgoStr(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function parseMediaTime(filename, timestampIso) {
    try {
        const m = filename.match(/(\d{8})_(\d{2})(\d{2})(\d{2})/);
        if (m) {
            return {
                hour: parseInt(m[2], 10),
                timeStr: `${m[2]}:${m[3]}:${m[4]}`
            };
        }
    } catch (e) {}

    try {
        if (timestampIso) {
            const dt = new Date(timestampIso);
            if (!isNaN(dt.getTime())) {
                const hh = String(dt.getHours()).padStart(2, '0');
                const mm = String(dt.getMinutes()).padStart(2, '0');
                const ss = String(dt.getSeconds()).padStart(2, '0');
                return {
                    hour: dt.getHours(),
                    timeStr: `${hh}:${mm}:${ss}`
                };
            }
        }
    } catch (e) {}

    return { hour: 0, timeStr: '00:00:00' };
}

// ----------------- CARGA DE DATOS DE ALMACENAMIENTO -----------------
async function loadStorageEstimate() {
    try {
        const res = await fetch('/api/storage/estimate');
        if (!res.ok) return;
        const data = await res.json();

        // Actualizar valores de disco
        document.getElementById('freeGbValue').textContent = data.free_gb;
        document.getElementById('totalGbValue').textContent = data.total_gb;
        document.getElementById('storagePercentBadge').textContent = `${data.percent_used}% Usado`;
        document.getElementById('storageProgressBar').style.width = `${Math.max(2, data.percent_used)}%`;
        if (data.base_path) {
            document.getElementById('storagePathText').textContent = `Ruta: ${data.base_path}`;
        }

        // Modo y Días estimados
        document.getElementById('activeRecModeBadge').textContent = data.mode || 'Calculado';
        document.getElementById('daysCountText').textContent = data.days_remaining || '--';

        // Tamaños de carpetas
        document.getElementById('clipsSizeText').textContent = `${data.total_clips_mb || 0} MB`;
        document.getElementById('continuousSizeText').textContent = `${data.total_continuous_mb || 0} MB`;
        document.getElementById('snapshotsSizeText').textContent = `${data.total_snapshots_mb || 0} MB`;
    } catch (e) {
        console.error('Error cargando estimación de almacenamiento:', e);
    }
}

// ----------------- CARGA DE ARCHIVOS MULTIMEDIA -----------------
async function loadMediaItems() {
    mediaGrid.innerHTML = `
        <div class="no-events-state" style="grid-column: 1 / -1; padding: 4rem 1rem;">
            <span class="empty-icon">⏳</span>
            <p>Cargando archivos multimedia del disco externo...</p>
        </div>
    `;
    if (timelineListBody) {
        timelineListBody.innerHTML = `
            <tr>
                <td colspan="7" style="text-align: center; padding: 2rem; color: var(--text-muted);">
                    ⏳ Cargando archivos multimedia...
                </td>
            </tr>
        `;
    }

    try {
        const res = await fetch('/api/media');
        if (!res.ok) throw new Error('Error al consultar archivos');
        const rawItems = await res.json();

        // Normalizar hora y tiempo exacto en cada elemento
        allMediaItems = rawItems.map(item => {
            const parsed = parseMediaTime(item.filename, item.timestamp);
            return {
                ...item,
                hour: typeof item.hour === 'number' ? item.hour : parsed.hour,
                time_str: item.time_str || parsed.timeStr
            };
        });

        // Actualizar contadores generales
        updateCounts();

        // Construir la barra de 24 horas para el día seleccionado
        buildTimelineHours();

        // Cargar y renderizar el resumen del calendario visual
        loadCalendarSummary();

        // Renderizar la lista filtrada
        renderFilteredMedia();
    } catch (e) {
        mediaGrid.innerHTML = `
            <div class="no-events-state" style="grid-column: 1 / -1; padding: 4rem 1rem;">
                <span class="empty-icon">⚠️</span>
                <p>Error cargando grabaciones: ${e.message}</p>
            </div>
        `;
    }
}

function updateCounts() {
    const total = allMediaItems.length;
    const clips = allMediaItems.filter(x => x.type === 'clip').length;
    const cont = allMediaItems.filter(x => x.type === 'continuous').length;
    const snaps = allMediaItems.filter(x => x.type === 'snapshot').length;

    document.getElementById('countAll').textContent = total;
    document.getElementById('countClips').textContent = clips;
    document.getElementById('countCont').textContent = cont;
    document.getElementById('countSnaps').textContent = snaps;
}

// ----------------- CONSTRUCTOR DE LA BARRA DE 24 HORAS -----------------
function buildTimelineHours() {
    if (!timelineHoursStrip) return;
    timelineHoursStrip.innerHTML = '';

    // Filtrar elementos para el día actualmente seleccionado (si no es 'all')
    const dayItems = allMediaItems.filter(item => {
        if (currentFilterCam !== 'all' && item.camera_id !== currentFilterCam) return false;
        if (currentFilterDate && item.day !== currentFilterDate) return false;
        return true;
    });

    // Mapear densidad horaria (00 a 23)
    const hourDensity = {};
    for (let h = 0; h < 24; h++) {
        hourDensity[h] = { total: 0, clips: 0, continuous: 0 };
    }

    dayItems.forEach(item => {
        const h = item.hour;
        if (h >= 0 && h <= 23) {
            hourDensity[h].total++;
            if (item.type === 'clip') hourDensity[h].clips++;
            if (item.type === 'continuous') hourDensity[h].continuous++;
        }
    });

    // Generar los 24 botones de la barra
    for (let h = 0; h < 24; h++) {
        const data = hourDensity[h];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'hour-tick-btn';
        btn.dataset.hour = h;

        if (currentFilterHour !== 'all' && currentFilterHour === h) {
            btn.classList.add('active');
        }

        if (data.clips > 0 && data.continuous > 0) {
            btn.classList.add('has-both');
        } else if (data.clips > 0) {
            btn.classList.add('has-events');
        } else if (data.continuous > 0) {
            btn.classList.add('has-continuous');
        }

        const hourPadded = String(h).padStart(2, '0') + ':00';
        const countText = data.total > 0 ? `${data.total}` : '0';

        btn.title = `Hora ${hourPadded} - ${data.total} grabaciones (${data.clips} eventos, ${data.continuous} continuos)`;
        btn.innerHTML = `
            <span class="activity-indicator"></span>
            <span class="hour-label">${String(h).padStart(2, '0')}h</span>
            <span class="hour-count-pill">${countText}</span>
        `;

        btn.addEventListener('click', () => {
            document.querySelectorAll('.hour-tick-btn').forEach(b => b.classList.remove('active'));
            allHoursBtn.classList.remove('active');

            if (currentFilterHour === h) {
                currentFilterHour = 'all';
                allHoursBtn.classList.add('active');
            } else {
                currentFilterHour = h;
                btn.classList.add('active');
            }
            renderFilteredMedia();
        });

        timelineHoursStrip.appendChild(btn);
    }
}

// ----------------- RENDERIZADO Y FILTRADO MULTIMEDIA -----------------
function renderFilteredMedia() {
    selectedItemIds.clear();
    updateSelectionUI();

    const filtered = allMediaItems.filter(item => {
        if (currentFilterType !== 'all' && item.type !== currentFilterType) return false;
        if (currentFilterCam !== 'all' && item.camera_id !== currentFilterCam) return false;
        if (currentFilterDate && item.day !== currentFilterDate) return false;
        if (currentFilterHour !== 'all' && item.hour !== currentFilterHour) return false;
        return true;
    });

    // Guardar lista de reproducción activa en orden cronológico
    currentPlaylist = [...filtered].sort((a, b) => (a.timestamp > b.timestamp ? -1 : 1));
    currentPage = 1;

    renderPagedItems();
}

function renderPagedItems() {
    const total = currentPlaylist.length;

    if (total === 0) {
        if (paginationBar) paginationBar.style.display = 'none';
        const msg = `No hay grabaciones disponibles para ${currentFilterDate || 'esta fecha'}${currentFilterHour !== 'all' ? ` a las ${String(currentFilterHour).padStart(2, '0')}:00 hrs` : ''}.`;
        mediaGrid.innerHTML = `
            <div class="no-events-state" style="grid-column: 1 / -1; padding: 4rem 1rem;">
                <span class="empty-icon">📁</span>
                <p>${msg}</p>
            </div>
        `;
        if (timelineListBody) {
            timelineListBody.innerHTML = `
                <tr>
                    <td colspan="7" style="text-align: center; padding: 3rem; color: var(--text-muted);">
                        📁 ${msg}
                    </td>
                </tr>
            `;
        }
        return;
    }

    const totalPages = Math.ceil(total / itemsPerPage) || 1;
    currentPage = Math.min(Math.max(1, currentPage), totalPages);

    const start = (currentPage - 1) * itemsPerPage;
    const end = Math.min(start + itemsPerPage, total);
    const paged = currentPlaylist.slice(start, end);

    // Actualizar Barra de Paginación
    if (paginationBar) {
        paginationBar.style.display = totalPages > 1 ? 'flex' : 'none';
        if (paginationInfo) paginationInfo.textContent = `Mostrando ${start + 1}-${end} de ${total} grabaciones`;
        if (pageIndicator) pageIndicator.textContent = `${currentPage} / ${totalPages}`;
        if (prevPageBtn) prevPageBtn.disabled = currentPage <= 1;
        if (nextPageBtn) nextPageBtn.disabled = currentPage >= totalPages;
    }

    // Renderizar Vista Cuadrícula
    mediaGrid.innerHTML = '';
    paged.forEach(item => {
        const card = createMediaCard(item);
        mediaGrid.appendChild(card);
    });

    // Renderizar Vista Lista Cronológica
    if (timelineListBody) {
        timelineListBody.innerHTML = '';
        paged.forEach(item => {
            const row = createMediaTableRow(item);
            timelineListBody.appendChild(row);
        });
    }
}

if (prevPageBtn) {
    prevPageBtn.addEventListener('click', () => {
        if (currentPage > 1) {
            currentPage--;
            renderPagedItems();
            window.scrollTo({ top: 400, behavior: 'smooth' });
        }
    });
}

if (nextPageBtn) {
    nextPageBtn.addEventListener('click', () => {
        const totalPages = Math.ceil(currentPlaylist.length / itemsPerPage) || 1;
        if (currentPage < totalPages) {
            currentPage++;
            renderPagedItems();
            window.scrollTo({ top: 400, behavior: 'smooth' });
        }
    });
}

function createMediaCard(item) {
    const card = document.createElement('div');
    card.className = 'media-item-card';
    card.dataset.id = item.id;

    const isVideo = item.type === 'clip' || item.type === 'continuous';
    const dateStr = item.day;
    const timeStr = item.time_str || '00:00:00';

    let typeTag = 'Evento IA';
    let typeClass = 'clip';
    if (item.type === 'continuous') {
        typeTag = '24/7';
        typeClass = 'continuous';
    } else if (item.type === 'snapshot') {
        typeTag = 'Foto';
        typeClass = 'snapshot';
    }

    // NOTA DE ALTO RENDIMIENTO: Usamos poster CSS ultraligero en vez de <video>
    // para evitar que el navegador abra 100+ instancias de decodificación que congelaban la página
    card.innerHTML = `
        <div class="media-thumb-wrap">
            ${isVideo ? `
                <div class="video-poster-placeholder video-poster-${typeClass}">
                    <span class="poster-icon">${item.type === 'continuous' ? '📼' : '🎬'}</span>
                    <span class="poster-time">${timeStr}</span>
                </div>
                <div class="play-overlay-icon">▶</div>
            ` : `
                <img src="${item.url}" alt="${escapeHtml(item.filename)}" class="media-thumb-img" loading="lazy">
            `}
            <span class="media-cam-badge">${escapeHtml(item.camera_name || item.camera_id)}</span>
            <span class="media-type-badge ${typeClass}">${typeTag}</span>
        </div>
        <div class="media-card-body">
            <div class="media-file-title" title="${escapeHtml(item.filename)}">${escapeHtml(item.filename)}</div>
            <div class="media-file-meta">
                <span>📅 ${dateStr} &bull; ⏰ ${timeStr}</span>
                <span>💾 ${item.size_mb} MB</span>
            </div>
        </div>
        <div class="media-actions-footer">
            <label style="display: flex; align-items: center; gap: 0.35rem; cursor: pointer; font-size: 0.78rem; color: var(--text-muted);">
                <input type="checkbox" class="checkbox-select-item" data-id="${item.id}">
                <span>Elegir</span>
            </label>
            <div style="display: flex; gap: 0.3rem;">
                <button type="button" class="btn btn-xs btn-primary btn-play-item" title="Ver / Reproducir video">▶️ Ver</button>
                <a href="${item.url}" download class="btn btn-xs btn-outline" title="Descargar archivo">⬇️</a>
                <button type="button" class="btn btn-xs btn-outline btn-delete-item" style="border-color: rgba(239, 68, 68, 0.4); color: #fca5a5;" title="Eliminar este archivo">🗑️</button>
            </div>
        </div>
    `;

    const thumbWrap = card.querySelector('.media-thumb-wrap');
    const playBtn = card.querySelector('.btn-play-item');
    const deleteBtn = card.querySelector('.btn-delete-item');
    const checkbox = card.querySelector('.checkbox-select-item');

    thumbWrap.addEventListener('click', () => openPlayer(item));
    playBtn.addEventListener('click', () => openPlayer(item));
    deleteBtn.addEventListener('click', () => confirmDeleteSingle(item));

    checkbox.addEventListener('change', (e) => {
        if (e.target.checked) selectedItemIds.add(item.id);
        else selectedItemIds.delete(item.id);
        updateSelectionUI();
    });

    return card;
}

function createMediaTableRow(item) {
    const tr = document.createElement('tr');
    tr.dataset.id = item.id;

    const isVideo = item.type === 'clip' || item.type === 'continuous';
    const typeLabel = item.type === 'clip' ? '🎬 Evento IA' : (item.type === 'continuous' ? '📼 24/7 Continuo' : '📸 Foto');

    tr.innerHTML = `
        <td>
            <input type="checkbox" class="checkbox-select-item" data-id="${item.id}">
        </td>
        <td>
            <div style="width: 80px; aspect-ratio: 16/9; background: #000; border-radius: 4px; overflow: hidden; position: relative; cursor: pointer;" class="btn-play-row">
                ${isVideo ? `
                    <div class="table-poster-box">
                        <span>${item.type === 'continuous' ? '📼' : '🎬'}</span>
                        <span style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.4); font-size: 0.85rem; color: #fff;">▶</span>
                    </div>
                ` : `
                    <img src="${item.url}" alt="" style="width: 100%; height: 100%; object-fit: cover;" loading="lazy">
                `}
            </div>
        </td>
        <td>
            <strong style="font-family: var(--font-mono); color: #93c5fd;">⏰ ${item.time_str || '--:--:--'}</strong>
            <div style="font-size: 0.75rem; color: var(--text-muted);">📅 ${item.day}</div>
        </td>
        <td>
            <span class="badge badge-sm" style="background: rgba(255,255,255,0.06); border: 1px solid var(--border-subtle);">
                ${escapeHtml(item.camera_name || item.camera_id)}
            </span>
        </td>
        <td>
            <span style="font-size: 0.8rem; font-weight: 600;">${typeLabel}</span>
            <div style="font-size: 0.72rem; color: var(--text-dim); max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                ${escapeHtml(item.filename)}
            </div>
        </td>
        <td style="font-family: var(--font-mono); font-size: 0.8rem;">
            ${item.size_mb} MB
        </td>
        <td style="text-align: right;">
            <div style="display: inline-flex; gap: 0.35rem;">
                <button type="button" class="btn btn-xs btn-primary btn-play-row" title="Reproducir">▶️ Ver</button>
                <a href="${item.url}" download class="btn btn-xs btn-outline" title="Descargar">⬇️</a>
                <button type="button" class="btn btn-xs btn-outline btn-delete-row" style="border-color: rgba(239, 68, 68, 0.4); color: #fca5a5;" title="Eliminar">🗑️</button>
            </div>
        </td>
    `;

    tr.querySelectorAll('.btn-play-row').forEach(el => el.addEventListener('click', () => openPlayer(item)));
    tr.querySelector('.btn-delete-row').addEventListener('click', () => confirmDeleteSingle(item));

    const cb = tr.querySelector('.checkbox-select-item');
    cb.addEventListener('change', (e) => {
        if (e.target.checked) selectedItemIds.add(item.id);
        else selectedItemIds.delete(item.id);
        updateSelectionUI();
    });

    return tr;
}

function updateSelectionUI() {
    selectedCountText.textContent = selectedItemIds.size;
    deleteSelectedBtn.disabled = selectedItemIds.size === 0;

    const allVisibleCheckboxes = document.querySelectorAll('.checkbox-select-item');
    const checkedBoxes = Array.from(allVisibleCheckboxes).filter(cb => cb.checked);
    
    if (selectAllCheckbox) {
        selectAllCheckbox.checked = allVisibleCheckboxes.length > 0 && checkedBoxes.length === allVisibleCheckboxes.length;
    }
    if (selectAllListCheckbox) {
        selectAllListCheckbox.checked = allVisibleCheckboxes.length > 0 && checkedBoxes.length === allVisibleCheckboxes.length;
    }
}

function handleSelectAllChange(e) {
    const checkAll = e.target.checked;
    document.querySelectorAll('.checkbox-select-item').forEach(cb => {
        cb.checked = checkAll;
        const id = cb.dataset.id;
        if (id) {
            if (checkAll) selectedItemIds.add(id);
            else selectedItemIds.delete(id);
        }
    });
    updateSelectionUI();
}

if (selectAllCheckbox) selectAllCheckbox.addEventListener('change', handleSelectAllChange);
if (selectAllListCheckbox) selectAllListCheckbox.addEventListener('change', handleSelectAllChange);

// ----------------- FILTROS Y EVENTOS DE USUARIO -----------------
// Filtro de tipos (Todos, Clips, 24/7, Fotos)
document.querySelectorAll('#typeFilterGroup .filter-tab').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('#typeFilterGroup .filter-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilterType = btn.dataset.type;
        renderFilteredMedia();
    });
});

// Filtro de cámaras (Todas, Cam1, Cam2)
document.querySelectorAll('#camFilterGroup .filter-tab').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('#camFilterGroup .filter-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilterCam = btn.dataset.cam;
        loadCalendarSummary();
        buildTimelineHours();
        renderFilteredMedia();
    });
});

// ==========================================================================
// CALENDARIO VISUAL DE GRABACIONES POR DÍA
// ==========================================================================
const MONTH_NAMES_ES = [
    'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
];

async function loadCalendarSummary() {
    try {
        const url = `/api/media/calendar-summary?camera_id=${currentFilterCam}`;
        const res = await fetch(url);
        if (!res.ok) return;
        const data = await res.json();
        calendarSummaryData = data.recorded_days || {};

        // Actualizar selector rápido de píldoras con días históricos con grabaciones
        updateDynamicQuickDayPills(data.days_list || []);

        // Renderizar el mes en el calendario visual
        renderVisualCalendar(currentCalYear, currentCalMonth);
        updateCalendarSelectionBar();
    } catch (e) {
        console.error('Error cargando resumen de calendario:', e);
    }
}

function updateDynamicQuickDayPills(daysList) {
    if (!quickDaysGroup) return;
    const todayStr = getDaysAgoStr(0);
    const yesterdayStr = getDaysAgoStr(1);
    const twoDaysAgoStr = getDaysAgoStr(2);

    let pillsHtml = `
        <button type="button" class="quick-day-btn ${currentFilterDate === todayStr ? 'active' : ''}" data-date="${todayStr}">📅 Hoy</button>
        <button type="button" class="quick-day-btn ${currentFilterDate === yesterdayStr ? 'active' : ''}" data-date="${yesterdayStr}">📅 Ayer</button>
        <button type="button" class="quick-day-btn ${currentFilterDate === twoDaysAgoStr ? 'active' : ''}" data-date="${twoDaysAgoStr}">📅 Hace 2 días</button>
    `;

    // Agregar otras fechas que contengan grabaciones
    daysList.forEach(dStr => {
        if (dStr !== todayStr && dStr !== yesterdayStr && dStr !== twoDaysAgoStr) {
            const count = calendarSummaryData[dStr]?.total_files || 0;
            pillsHtml += `<button type="button" class="quick-day-btn ${currentFilterDate === dStr ? 'active' : ''}" data-date="${dStr}">📅 ${dStr} (${count})</button>`;
        }
    });

    pillsHtml += `<button type="button" class="quick-day-btn ${!currentFilterDate ? 'active' : ''}" data-date="all">🌐 Todo</button>`;
    quickDaysGroup.innerHTML = pillsHtml;

    quickDaysGroup.querySelectorAll('.quick-day-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const d = btn.dataset.date;
            if (d === 'all') {
                selectDay('');
            } else {
                selectDay(d);
            }
        });
    });
}

function renderVisualCalendar(year, month) {
    if (!calendarMonthTitle || !calendarDaysGrid) return;
    calendarMonthTitle.textContent = `${MONTH_NAMES_ES[month]} ${year}`;
    calendarDaysGrid.innerHTML = '';

    const todayStr = getDaysAgoStr(0);

    // Primer día del mes (Lunes=0 .. Domingo=6)
    const firstDay = new Date(year, month, 1).getDay();
    const startOffset = (firstDay + 6) % 7;

    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrevMonth = new Date(year, month, 0).getDate();

    // Días del mes anterior (para completar la primera semana)
    for (let i = startOffset - 1; i >= 0; i--) {
        const prevDayNum = daysInPrevMonth - i;
        const cell = document.createElement('div');
        cell.className = 'calendar-day-cell other-month';
        cell.innerHTML = `
            <div class="day-header">
                <span class="day-number">${prevDayNum}</span>
            </div>
        `;
        calendarDaysGrid.appendChild(cell);
    }

    // Días del mes actual
    for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const dayData = calendarSummaryData[dateStr];
        const hasData = !!dayData && dayData.total_files > 0;
        const isToday = (dateStr === todayStr);
        const isActive = (dateStr === currentFilterDate);

        const cell = document.createElement('div');
        cell.className = 'calendar-day-cell';
        cell.dataset.date = dateStr;

        if (hasData) cell.classList.add('has-data');
        if (isToday) cell.classList.add('is-today');
        if (isActive) cell.classList.add('active-day');

        let dotsHtml = '';
        let statsHtml = '';

        if (hasData) {
            dotsHtml = '<div class="calendar-activity-dots">';
            if (dayData.has_clips) dotsHtml += '<span class="activity-dot dot-clip" title="Clips de Eventos IA"></span>';
            if (dayData.has_continuous) dotsHtml += '<span class="activity-dot dot-cont" title="Grabaciones 24/7"></span>';
            if (dayData.has_snapshots) dotsHtml += '<span class="activity-dot dot-snap" title="Capturas de Fotos"></span>';
            dotsHtml += '</div>';

            const sizeDisplay = dayData.total_gb >= 1 ? `${dayData.total_gb} GB` : `${dayData.total_mb} MB`;
            statsHtml = `<div class="calendar-day-stats" title="${dayData.total_files} grabaciones (${sizeDisplay})">${dayData.total_files} grab. &bull; ${sizeDisplay}</div>`;
        }

        cell.innerHTML = `
            <div class="day-header">
                <span class="day-number">${d}</span>
                ${dotsHtml}
            </div>
            ${statsHtml}
        `;

        cell.addEventListener('click', () => {
            selectDay(dateStr);
        });

        calendarDaysGrid.appendChild(cell);
    }

    // Días del mes siguiente (para completar la última semana)
    const totalCells = startOffset + daysInMonth;
    const remaining = (7 - (totalCells % 7)) % 7;
    for (let j = 1; j <= remaining; j++) {
        const cell = document.createElement('div');
        cell.className = 'calendar-day-cell other-month';
        cell.innerHTML = `
            <div class="day-header">
                <span class="day-number">${j}</span>
            </div>
        `;
        calendarDaysGrid.appendChild(cell);
    }
}

function selectDay(dateStr) {
    currentFilterDate = dateStr;
    if (dateFilterInput) dateFilterInput.value = dateStr;

    if (timelineSelectedDayBadge) {
        if (!dateStr) {
            timelineSelectedDayBadge.textContent = 'Todo el Historial';
        } else if (dateStr === getDaysAgoStr(0)) {
            timelineSelectedDayBadge.textContent = 'Hoy';
        } else if (dateStr === getDaysAgoStr(1)) {
            timelineSelectedDayBadge.textContent = 'Ayer';
        } else if (dateStr === getDaysAgoStr(2)) {
            timelineSelectedDayBadge.textContent = 'Hace 2 días';
        } else {
            timelineSelectedDayBadge.textContent = dateStr;
        }
    }

    if (quickDaysGroup) {
        quickDaysGroup.querySelectorAll('.quick-day-btn').forEach(btn => {
            const bDate = btn.dataset.date;
            if (bDate === 'all') {
                btn.classList.toggle('active', !dateStr);
            } else {
                btn.classList.toggle('active', bDate === dateStr);
            }
        });
    }

    // Sincronizar mes del calendario si la fecha seleccionada no está en el mes visualizado
    if (dateStr && dateStr.length === 10) {
        const parts = dateStr.split('-');
        const y = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10) - 1;
        if (!isNaN(y) && !isNaN(m) && (y !== currentCalYear || m !== currentCalMonth)) {
            currentCalYear = y;
            currentCalMonth = m;
            renderVisualCalendar(currentCalYear, currentCalMonth);
        }
    }

    highlightCalendarActiveDay();
    updateCalendarSelectionBar();
    updateDatePurgeBtnState();

    currentFilterHour = 'all';
    if (allHoursBtn) {
        document.querySelectorAll('.hour-tick-btn').forEach(b => b.classList.remove('active'));
        allHoursBtn.classList.add('active');
    }

    buildTimelineHours();
    renderFilteredMedia();
}

function highlightCalendarActiveDay() {
    if (!calendarDaysGrid) return;
    calendarDaysGrid.querySelectorAll('.calendar-day-cell').forEach(cell => {
        const cellDate = cell.dataset.date;
        if (cellDate) {
            cell.classList.toggle('active-day', cellDate === currentFilterDate);
        }
    });
}

function updateCalendarSelectionBar() {
    if (!calSelectedDateText || !calSelectedDayStatsBadge) return;

    if (!currentFilterDate) {
        calSelectedDateText.textContent = 'Día seleccionado: Todo el Historial';
        calSelectedDayStatsBadge.textContent = `${allMediaItems.length} grabaciones en total`;
        if (calPurgeDayBtn) calPurgeDayBtn.style.display = 'none';
        return;
    }

    const todayStr = getDaysAgoStr(0);
    const label = currentFilterDate === todayStr ? `Hoy (${currentFilterDate})` : currentFilterDate;
    calSelectedDateText.textContent = `Día seleccionado: ${label}`;

    const dayData = calendarSummaryData[currentFilterDate];
    if (dayData && dayData.total_files > 0) {
        const sizeStr = dayData.total_gb >= 1 ? `${dayData.total_gb} GB` : `${dayData.total_mb} MB`;
        calSelectedDayStatsBadge.innerHTML = `
            <strong>${dayData.total_files} grabaciones</strong> (${sizeStr}) &bull; 
            🎬 ${dayData.clips} clips IA &bull; 
            📼 ${dayData.continuous} 24/7 &bull; 
            📸 ${dayData.snapshots} fotos
        `;
        if (calPurgeDayBtn) {
            calPurgeDayBtn.style.display = 'inline-block';
            calPurgeDayBtn.textContent = `🗑️ Purgar día ${currentFilterDate}`;
        }
    } else {
        calSelectedDayStatsBadge.textContent = 'Sin grabaciones en esta fecha';
        if (calPurgeDayBtn) calPurgeDayBtn.style.display = 'none';
    }
}

// Navegación de mes del calendario
if (calPrevMonthBtn) {
    calPrevMonthBtn.addEventListener('click', () => {
        currentCalMonth--;
        if (currentCalMonth < 0) {
            currentCalMonth = 11;
            currentCalYear--;
        }
        renderVisualCalendar(currentCalYear, currentCalMonth);
    });
}

if (calNextMonthBtn) {
    calNextMonthBtn.addEventListener('click', () => {
        currentCalMonth++;
        if (currentCalMonth > 11) {
            currentCalMonth = 0;
            currentCalYear++;
        }
        renderVisualCalendar(currentCalYear, currentCalMonth);
    });
}

if (calTodayBtn) {
    calTodayBtn.addEventListener('click', () => {
        const now = new Date();
        currentCalYear = now.getFullYear();
        currentCalMonth = now.getMonth();
        selectDay(getDaysAgoStr(0));
    });
}

// Alternar Visibilidad del Calendario
if (toggleCalendarBtn && calendarSectionCard) {
    toggleCalendarBtn.addEventListener('click', () => {
        const isHidden = calendarSectionCard.style.display === 'none';
        calendarSectionCard.style.display = isHidden ? 'flex' : 'none';
        toggleCalendarBtn.textContent = isHidden ? '📅 Ocultar Calendario' : '📅 Ver Calendario Mensual';
        if (isHidden) {
            renderVisualCalendar(currentCalYear, currentCalMonth);
            updateCalendarSelectionBar();
        }
    });
}

// Acciones de la barra de información del calendario
if (calFilterDayBtn) {
    calFilterDayBtn.addEventListener('click', () => {
        const target = document.querySelector('.media-controls-card') || mediaGrid;
        if (target) target.scrollIntoView({ behavior: 'smooth' });
    });
}

if (calPurgeDayBtn) {
    calPurgeDayBtn.addEventListener('click', () => {
        if (purgeDateBtn) purgeDateBtn.click();
    });
}

// Selector de fecha manual (input date)
if (dateFilterInput) {
    dateFilterInput.addEventListener('change', (e) => {
        selectDay(e.target.value);
    });
}

if (clearDateFilterBtn) {
    clearDateFilterBtn.addEventListener('click', () => {
        selectDay('');
    });
}

// Botón "Todas las 24 horas"
if (allHoursBtn) {
    allHoursBtn.addEventListener('click', () => {
        document.querySelectorAll('.hour-tick-btn').forEach(b => b.classList.remove('active'));
        allHoursBtn.classList.add('active');
        currentFilterHour = 'all';
        renderFilteredMedia();
    });
}

// Conmutador de Modo de Vista (Cuadrícula vs Lista Cronológica)
viewModeGridBtn.addEventListener('click', () => {
    viewModeGridBtn.classList.add('active');
    viewModeListBtn.classList.remove('active');
    currentViewMode = 'grid';
    mediaGrid.style.display = 'grid';
    timelineListView.style.display = 'none';
});

viewModeListBtn.addEventListener('click', () => {
    viewModeListBtn.classList.add('active');
    viewModeGridBtn.classList.remove('active');
    currentViewMode = 'list';
    mediaGrid.style.display = 'none';
    timelineListView.style.display = 'block';
});

// ----------------- REPRODUCTOR MODAL MEJORADO -----------------
function openPlayer(item) {
    activeModalItem = item;

    // Localizar posición en la lista de reproducción
    currentPlaylistIndex = currentPlaylist.findIndex(x => x.id === item.id);
    if (currentPlaylistIndex === -1) currentPlaylistIndex = 0;

    // Actualizar Título, Subtítulo y Badge Temporal
    playerTitle.textContent = item.filename;
    playerSubtitle.textContent = `${item.camera_name} • ${item.category} • ${item.size_mb} MB`;
    
    const timeDisplay = item.time_str || '00:00:00';
    playerTimeBadge.innerHTML = `📅 ${item.day} &bull; ⏰ <strong>${timeDisplay}</strong>`;

    // Actualizar contador de playlist
    updatePlaylistNavUI();

    playerDownloadBtn.href = item.url;

    const isVideo = item.type === 'clip' || item.type === 'continuous';
    if (isVideo) {
        playerImage.style.display = 'none';
        playerVideo.style.display = 'block';
        videoSpeedControls.style.display = 'flex';
        playerVideo.src = item.url;
        playerVideo.playbackRate = 1.0;
        document.querySelectorAll('.speed-btn').forEach(b => b.classList.toggle('active', b.dataset.speed === '1'));
        playerVideo.play().catch(() => {});
    } else {
        playerVideo.pause();
        playerVideo.style.display = 'none';
        videoSpeedControls.style.display = 'none';
        playerImage.style.display = 'block';
        playerImage.src = item.url;
    }

    mediaPlayerModal.style.display = 'flex';
}

function updatePlaylistNavUI() {
    if (currentPlaylist.length > 0 && currentPlaylistIndex >= 0) {
        playlistCounter.textContent = `${currentPlaylistIndex + 1} / ${currentPlaylist.length}`;
        playerPrevBtn.disabled = currentPlaylistIndex <= 0;
        playerNextBtn.disabled = currentPlaylistIndex >= currentPlaylist.length - 1;
    } else {
        playlistCounter.textContent = '1 / 1';
        playerPrevBtn.disabled = true;
        playerNextBtn.disabled = true;
    }
}

function playNext() {
    if (currentPlaylistIndex >= 0 && currentPlaylistIndex < currentPlaylist.length - 1) {
        openPlayer(currentPlaylist[currentPlaylistIndex + 1]);
    }
}

function playPrev() {
    if (currentPlaylistIndex > 0) {
        openPlayer(currentPlaylist[currentPlaylistIndex - 1]);
    }
}

// Botones de Anterior y Siguiente
playerPrevBtn.addEventListener('click', playPrev);
playerNextBtn.addEventListener('click', playNext);

// Auto-siguiente cuando termina un video
playerVideo.addEventListener('ended', () => {
    if (autoPlayNextToggle && autoPlayNextToggle.checked) {
        playNext();
    }
});

function closePlayer() {
    mediaPlayerModal.style.display = 'none';
    if (playerVideo) {
        playerVideo.pause();
        playerVideo.removeAttribute('src');
        playerVideo.load();
    }
    if (playerImage) playerImage.src = '';
    activeModalItem = null;
}

closePlayerBtn.addEventListener('click', closePlayer);
modalBackdrop.addEventListener('click', closePlayer);

// Atajos de Teclado para Navegación Cómoda
document.addEventListener('keydown', (e) => {
    if (mediaPlayerModal.style.display !== 'flex') return;

    if (e.key === 'Escape') {
        closePlayer();
    } else if (e.key === 'ArrowRight') {
        if (playerVideo) playerVideo.currentTime = Math.min(playerVideo.duration || 0, playerVideo.currentTime + 10);
    } else if (e.key === 'ArrowLeft') {
        if (playerVideo) playerVideo.currentTime = Math.max(0, playerVideo.currentTime - 10);
    } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        playNext();
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        playPrev();
    } else if (e.key === ' ' && e.target.tagName !== 'INPUT') {
        e.preventDefault();
        if (playerVideo.paused) playerVideo.play();
        else playerVideo.pause();
    }
});

// Selector de Velocidades de Reproducción
document.querySelectorAll('.speed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const speed = parseFloat(btn.dataset.speed);
        if (playerVideo) playerVideo.playbackRate = speed;
    });
});

jumpBackBtn.addEventListener('click', () => {
    if (playerVideo) playerVideo.currentTime = Math.max(0, playerVideo.currentTime - 10);
});

jumpForwardBtn.addEventListener('click', () => {
    if (playerVideo) playerVideo.currentTime = Math.min(playerVideo.duration || 0, playerVideo.currentTime + 10);
});

// ----------------- ELIMINACIÓN DE ARCHIVOS -----------------
async function confirmDeleteSingle(item) {
    if (!confirm(`¿Eliminar permanentemente este archivo?\n\n${item.filename}\n\nSe liberará espacio en el disco externo.`)) {
        return;
    }
    try {
        const res = await fetch('/api/media/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                camera_id: item.camera_id,
                file_type: item.type,
                filename: item.filename,
                day: item.day
            })
        });
        const data = await res.json();
        if (data.success) {
            allMediaItems = allMediaItems.filter(x => x.id !== item.id);
            updateCounts();
            buildTimelineHours();
            loadCalendarSummary();
            renderFilteredMedia();
            loadStorageEstimate();
        } else {
            alert('Error eliminando el archivo.');
        }
    } catch (e) {
        alert(`Error al intentar eliminar: ${e.message}`);
    }
}

playerDeleteBtn.addEventListener('click', () => {
    if (activeModalItem) {
        const itemToDelete = activeModalItem;
        closePlayer();
        confirmDeleteSingle(itemToDelete);
    }
});

// Eliminación Masiva
deleteSelectedBtn.addEventListener('click', async () => {
    const count = selectedItemIds.size;
    if (count === 0) return;
    if (!confirm(`¿Eliminar los ${count} archivos seleccionados permanentemente del disco externo?`)) {
        return;
    }

    const itemsToDelete = allMediaItems.filter(x => selectedItemIds.has(x.id)).map(x => ({
        camera_id: x.camera_id,
        file_type: x.type,
        filename: x.filename,
        day: x.day
    }));

    deleteSelectedBtn.disabled = true;
    deleteSelectedBtn.textContent = '⏳ Eliminando...';

    try {
        const res = await fetch('/api/media/bulk-delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: itemsToDelete })
        });
        const data = await res.json();
        if (data.success) {
            allMediaItems = allMediaItems.filter(x => !selectedItemIds.has(x.id));
            selectedItemIds.clear();
            updateCounts();
            buildTimelineHours();
            loadCalendarSummary();
            renderFilteredMedia();
            loadStorageEstimate();
            alert(`✅ Se eliminaron ${data.deleted_count} archivos correctamente.`);
        }
    } catch (e) {
        alert(`Error en eliminación masiva: ${e.message}`);
    } finally {
        deleteSelectedBtn.disabled = false;
        deleteSelectedBtn.textContent = '🗑️ Eliminar Seleccionados';
    }
});

// ==========================================================================
// ASISTENTE DE PURGA INTELIGENTE POR DÍAS Y RETENCIÓN AUTOMÁTICA
// ==========================================================================

function updateDatePurgeBtnState() {
    if (!purgeDateBtn) return;
    if (currentFilterDate && currentFilterDate.trim().length === 10) {
        purgeDateBtn.style.display = 'inline-block';
        purgeDateBtn.textContent = `🗑️ Purgar día ${currentFilterDate}`;
    } else {
        purgeDateBtn.style.display = 'none';
    }
}

// Purga directa de la fecha seleccionada en el calendario
if (purgeDateBtn) {
    purgeDateBtn.addEventListener('click', async () => {
        if (!currentFilterDate) return;
        const ok = confirm(`⚠️ ¿Deseas purgar TODAS las grabaciones del día ${currentFilterDate}?\n\nEsta acción eliminará de inmediato los videos 24/7, clips de eventos y capturas de esa fecha en ambas cámaras.`);
        if (!ok) return;

        try {
            purgeDateBtn.disabled = true;
            purgeDateBtn.textContent = '⏳ Purgando día...';
            const res = await fetch('/api/media/bulk-delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ specific_date: currentFilterDate, target_type: 'all', camera_id: 'all' })
            });
            const data = await res.json();
            if (data.success) {
                const freedStr = data.freed_mb > 1024 ? `${data.freed_gb} GB` : `${data.freed_mb} MB`;
                alert(`✅ Día ${currentFilterDate} purgado con éxito.\n\nArchivos eliminados: ${data.deleted_count}\nEspacio liberado: ${freedStr}`);
                loadMediaItems();
                loadStorageEstimate();
            } else {
                alert(`Error al purgar fecha: ${data.error || 'Desconocido'}`);
            }
        } catch (e) {
            alert(`Error al conectar con el servidor: ${e.message}`);
        } finally {
            purgeDateBtn.disabled = false;
            updateDatePurgeBtnState();
        }
    });
}

// Gestión de Pestañas del Modal
if (tabManualPurge && tabAutoRetention) {
    tabManualPurge.addEventListener('click', () => {
        tabManualPurge.classList.add('active');
        tabAutoRetention.classList.remove('active');
        panelManualPurge.style.display = 'flex';
        panelAutoRetention.style.display = 'none';
        purgeFooterControls.style.display = 'flex';
        updatePurgePreview();
    });

    tabAutoRetention.addEventListener('click', () => {
        tabAutoRetention.classList.add('active');
        tabManualPurge.classList.remove('active');
        panelManualPurge.style.display = 'none';
        panelAutoRetention.style.display = 'flex';
        purgeFooterControls.style.display = 'none';
        loadRetentionSettings();
    });
}

function openPurgeModal(initialDays = 7, targetTab = 'manual') {
    if (!purgeModal) return;
    purgeModal.style.display = 'flex';

    if (targetTab === 'auto') {
        if (tabAutoRetention) tabAutoRetention.click();
    } else {
        if (tabManualPurge) tabManualPurge.click();
        if (purgeCustomDaysInput) purgeCustomDaysInput.value = initialDays;
        document.querySelectorAll('.preset-chip-btn').forEach(btn => {
            btn.classList.toggle('active', parseInt(btn.dataset.days, 10) === initialDays);
        });
        updatePurgePreview();
    }
}

function closePurgeModal() {
    if (purgeModal) purgeModal.style.display = 'none';
}

if (openPurgeModalBtn) openPurgeModalBtn.addEventListener('click', () => openPurgeModal(7, 'manual'));
if (openRetentionBtn) openRetentionBtn.addEventListener('click', () => openPurgeModal(30, 'auto'));
if (purge1Btn) purge1Btn.addEventListener('click', () => openPurgeModal(1, 'manual'));
if (purge3Btn) purge3Btn.addEventListener('click', () => openPurgeModal(3, 'manual'));
if (purge7Btn) purge7Btn.addEventListener('click', () => openPurgeModal(7, 'manual'));
if (purge15Btn) purge15Btn.addEventListener('click', () => openPurgeModal(15, 'manual'));

if (closePurgeModalBtn) closePurgeModalBtn.addEventListener('click', closePurgeModal);
if (cancelPurgeBtn) cancelPurgeBtn.addEventListener('click', closePurgeModal);
if (purgeModalBackdrop) purgeModalBackdrop.addEventListener('click', closePurgeModal);

// Chips de días preestablecidos
document.querySelectorAll('.preset-chip-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.preset-chip-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const days = parseInt(btn.dataset.days, 10);
        if (purgeCustomDaysInput) purgeCustomDaysInput.value = days;
        updatePurgePreview();
    });
});

let _previewDebounce = null;
if (purgeCustomDaysInput) {
    purgeCustomDaysInput.addEventListener('input', () => {
        const val = parseInt(purgeCustomDaysInput.value, 10);
        document.querySelectorAll('.preset-chip-btn').forEach(b => {
            b.classList.toggle('active', parseInt(b.dataset.days, 10) === val);
        });
        clearTimeout(_previewDebounce);
        _previewDebounce = setTimeout(updatePurgePreview, 300);
    });
}

document.querySelectorAll('input[name="purgeContentType"]').forEach(radio => {
    radio.addEventListener('change', updatePurgePreview);
});

document.querySelectorAll('#purgeCamFilterTabs .filter-tab').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('#purgeCamFilterTabs .filter-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        updatePurgePreview();
    });
});

// Cálculo y previsualización en vivo (Dry-Run)
async function updatePurgePreview() {
    if (!purgeCustomDaysInput || !previewCountVal || !previewSizeVal) return;
    const days = Math.max(0, parseInt(purgeCustomDaysInput.value, 10) || 0);
    const targetType = document.querySelector('input[name="purgeContentType"]:checked')?.value || 'all';
    const activeCamBtn = document.querySelector('#purgeCamFilterTabs .filter-tab.active');
    const targetCam = activeCamBtn ? activeCamBtn.dataset.purgeCam : 'all';

    // Calcular fecha límite
    const d = new Date();
    d.setDate(d.getDate() - days);
    const cutoffStr = d.toISOString().split('T')[0];
    if (cutoffDateHintText) {
        cutoffDateHintText.textContent = days === 0 
            ? 'Se eliminarán grabaciones anteriores a hoy' 
            : `Grabaciones anteriores al ${cutoffStr} (conserva hoy + ${days} días)`;
    }

    if (previewStatusBadge) previewStatusBadge.textContent = 'Simulando...';

    try {
        const res = await fetch('/api/media/purge-preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ days_older_than: days, target_type: targetType, camera_id: targetCam })
        });
        const data = await res.json();
        if (data.success) {
            if (previewStatusBadge) previewStatusBadge.textContent = 'Listo';
            previewCountVal.textContent = data.total_count;
            const freedStr = data.freed_mb > 1024 ? `${data.freed_gb} GB` : `${data.freed_mb} MB`;
            previewSizeVal.textContent = freedStr;

            const datesStr = data.affected_days && data.affected_days.length > 0
                ? `${data.affected_days.length} día(s) afectados (${data.affected_days[0]} a ${data.affected_days[data.affected_days.length - 1]})`
                : 'No se encontraron grabaciones con esa antigüedad';

            if (previewBreakdownText) {
                previewBreakdownText.innerHTML = `
                    <div>📅 <strong>${datesStr}</strong></div>
                    <div style="margin-top: 0.25rem; font-size: 0.74rem; color: #94a3b8;">
                        📼 ${data.breakdown.continuous_count} videos 24/7 (${data.breakdown.continuous_mb} MB) &bull; 
                        🎬 ${data.breakdown.clip_count} clips IA (${data.breakdown.clip_mb} MB) &bull; 
                        📸 ${data.breakdown.snapshot_count} fotos (${data.breakdown.snapshot_mb} MB)
                    </div>
                `;
            }

            if (executePurgeBtn) {
                if (data.total_count > 0) {
                    executePurgeBtn.disabled = false;
                    executePurgeBtn.textContent = `🗑️ Confirmar Purga (${data.total_count} archivos | ${freedStr})`;
                } else {
                    executePurgeBtn.disabled = true;
                    executePurgeBtn.textContent = 'Sin archivos para purgar';
                }
            }
        }
    } catch (e) {
        if (previewStatusBadge) previewStatusBadge.textContent = 'Error';
        if (previewBreakdownText) previewBreakdownText.textContent = `Error en simulación: ${e.message}`;
    }
}

// Ejecución de la purga
if (executePurgeBtn) {
    executePurgeBtn.addEventListener('click', async () => {
        const days = Math.max(0, parseInt(purgeCustomDaysInput.value, 10) || 0);
        const targetType = document.querySelector('input[name="purgeContentType"]:checked')?.value || 'all';
        const activeCamBtn = document.querySelector('#purgeCamFilterTabs .filter-tab.active');
        const targetCam = activeCamBtn ? activeCamBtn.dataset.purgeCam : 'all';

        const typeLabel = targetType === 'continuous' ? 'Solo Grabaciones 24/7' : (targetType === 'clip' ? 'Solo Clips de Eventos' : (targetType === 'snapshot' ? 'Solo Fotos' : 'Todo el contenido'));
        const ok = confirm(`⚠️ ¿Confirmas la purga permanente de grabaciones con más de ${days} días?\n\nFiltro: ${typeLabel}\nCámara: ${targetCam === 'all' ? 'Ambas Cámaras' : targetCam}\n\nEsta acción liberará espacio de inmediato.`);
        if (!ok) return;

        try {
            executePurgeBtn.disabled = true;
            executePurgeBtn.textContent = '⏳ Liberando espacio en disco...';
            const res = await fetch('/api/media/bulk-delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ days_older_than: days, target_type: targetType, camera_id: targetCam })
            });
            const data = await res.json();
            if (data.success) {
                const freedStr = data.freed_mb > 1024 ? `${data.freed_gb} GB` : `${data.freed_mb} MB`;
                closePurgeModal();
                alert(`✨ Purgado completado exitosamente.\n\nArchivos eliminados: ${data.deleted_count}\nEspacio liberado: ${freedStr}`);
                loadMediaItems();
                loadStorageEstimate();
            } else {
                alert(`Error purgando archivos: ${data.error || 'Desconocido'}`);
            }
        } catch (e) {
            alert(`Error al conectar con el servidor: ${e.message}`);
        } finally {
            executePurgeBtn.disabled = false;
        }
    });
}

// Cargar y Guardar Política de Retención
async function loadRetentionSettings() {
    try {
        const res = await fetch('/api/settings/retention');
        const data = await res.json();
        if (retentionDaysInput) retentionDaysInput.value = data.max_recording_days || 30;
        if (autoPurgeEnabledToggle) autoPurgeEnabledToggle.checked = data.auto_purge_enabled !== false;
    } catch (e) {
        console.error('Error cargando retención:', e);
    }
}

if (saveRetentionBtn) {
    saveRetentionBtn.addEventListener('click', async () => {
        const days = parseInt(retentionDaysInput.value, 10) || 30;
        const enabled = autoPurgeEnabledToggle ? autoPurgeEnabledToggle.checked : true;
        try {
            saveRetentionBtn.disabled = true;
            saveRetentionBtn.textContent = '💾 Guardando...';
            const res = await fetch('/api/settings/retention', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ max_recording_days: days, auto_purge_enabled: enabled })
            });
            const data = await res.json();
            if (data.success) {
                alert(`✅ Política de retención guardada con éxito:\n\nEl sistema mantendrá grabaciones hasta un máximo de ${days} días.`);
                closePurgeModal();
            } else {
                alert(`Error al guardar política: ${data.error || 'Desconocido'}`);
            }
        } catch (e) {
            alert(`Error al conectar con el servidor: ${e.message}`);
        } finally {
            saveRetentionBtn.disabled = false;
            saveRetentionBtn.textContent = '💾 Guardar Política de Retención';
        }
    });
}

reloadMediaBtn.addEventListener('click', loadMediaItems);
refreshStorageBtn.addEventListener('click', loadStorageEstimate);

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
}

// Inicialización
document.addEventListener('DOMContentLoaded', () => {
    if (dateFilterInput) {
        dateFilterInput.value = currentFilterDate;
    }
    updateDatePurgeBtnState();
    loadStorageEstimate();
    loadMediaItems();
});
