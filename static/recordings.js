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
const purge7Btn = document.getElementById('purge7Btn');
const purge15Btn = document.getElementById('purge15Btn');
const purge30Btn = document.getElementById('purge30Btn');
const purgeCustomBtn = document.getElementById('purgeCustomBtn');

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
        buildTimelineHours();
        renderFilteredMedia();
    });
});

// Píldoras rápidas de días (Hoy, Ayer, Hace 2 días, Todo)
document.querySelectorAll('#quickDaysGroup .quick-day-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('#quickDaysGroup .quick-day-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const daysAgo = btn.dataset.daysAgo;
        if (daysAgo === 'all') {
            currentFilterDate = '';
            dateFilterInput.value = '';
            timelineSelectedDayBadge.textContent = 'Todo el Historial';
        } else {
            const n = parseInt(daysAgo, 10);
            currentFilterDate = getDaysAgoStr(n);
            dateFilterInput.value = currentFilterDate;
            timelineSelectedDayBadge.textContent = n === 0 ? 'Hoy' : (n === 1 ? 'Ayer' : `Hace ${n} días`);
        }

        currentFilterHour = 'all';
        allHoursBtn.classList.add('active');
        buildTimelineHours();
        renderFilteredMedia();
    });
});

// Selector de fecha manual (input date)
dateFilterInput.addEventListener('change', (e) => {
    document.querySelectorAll('#quickDaysGroup .quick-day-btn').forEach(b => b.classList.remove('active'));
    currentFilterDate = e.target.value;
    timelineSelectedDayBadge.textContent = currentFilterDate || 'Todo';
    currentFilterHour = 'all';
    allHoursBtn.classList.add('active');
    buildTimelineHours();
    renderFilteredMedia();
});

clearDateFilterBtn.addEventListener('click', () => {
    document.querySelectorAll('#quickDaysGroup .quick-day-btn').forEach(b => b.classList.remove('active'));
    const allBtn = document.querySelector('#quickDaysGroup .quick-day-btn[data-days-ago="all"]');
    if (allBtn) allBtn.classList.add('active');
    dateFilterInput.value = '';
    currentFilterDate = '';
    timelineSelectedDayBadge.textContent = 'Todo el Historial';
    currentFilterHour = 'all';
    allHoursBtn.classList.add('active');
    buildTimelineHours();
    renderFilteredMedia();
});

// Botón "Todas las 24 horas"
allHoursBtn.addEventListener('click', () => {
    document.querySelectorAll('.hour-tick-btn').forEach(b => b.classList.remove('active'));
    allHoursBtn.classList.add('active');
    currentFilterHour = 'all';
    renderFilteredMedia();
});

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

// Purgar grabaciones antiguas
async function purgeOlderThan(days) {
    if (!confirm(`¿Deseas purgar todas las grabaciones con más de ${days} días de antigüedad en ambas cámaras?\n\nEsta acción liberará espacio de inmediato.`)) {
        return;
    }
    try {
        const res = await fetch('/api/media/bulk-delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ days_older_than: days })
        });
        const data = await res.json();
        if (data.success) {
            alert(`✅ Purgado completado. Se eliminaron ${data.deleted_count} archivos antiguos.`);
            loadMediaItems();
            loadStorageEstimate();
        }
    } catch (e) {
        alert(`Error purgando archivos: ${e.message}`);
    }
}

if (purge7Btn) purge7Btn.addEventListener('click', () => purgeOlderThan(7));
if (purge15Btn) purge15Btn.addEventListener('click', () => purgeOlderThan(15));
if (purge30Btn) purge30Btn.addEventListener('click', () => purgeOlderThan(30));
if (purgeCustomBtn) {
    purgeCustomBtn.addEventListener('click', () => {
        const inputDays = prompt("🧹 Purgar Grabaciones por Días:\n\nIngrese la antigüedad mínima en días para eliminar (ejemplo: 5, 7, 10, 20):", "7");
        if (inputDays !== null) {
            const days = parseInt(inputDays.trim(), 10);
            if (!isNaN(days) && days >= 0) {
                purgeOlderThan(days);
            } else {
                alert("Por favor ingrese un número válido de días mayores o iguales a 0.");
            }
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
    loadStorageEstimate();
    loadMediaItems();
});
