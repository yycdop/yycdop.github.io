// =====================================================================
// DATA LOADING — reads gnss_monitor_live.data (binary gzip, GNS2 format)
// =====================================================================
async function loadData() {
  const subEl   = document.querySelector('.loading-sub');
  const titleEl = document.querySelector('.loading-title');
  const status  = t => { subEl.textContent = t; };

  // Step 1: download with progress
  status('Downloading data file...');
  const response = await fetch('gnss_monitor_live.data');
  if (!response.ok) throw new Error(
    'HTTP ' + response.status + ' fetching gnss_monitor_live.data — ' +
    'make sure gnss_monitor_live.data is in the same directory as this HTML file.');

    const contentLength = response.headers.get('Content-Length');
    const dlTotal = contentLength ? parseInt(contentLength, 10) : 0;
    const dlReader = response.body.getReader();
    const dlChunks = [];
    let dlReceived = 0;
    while (true) {
        const { done, value } = await dlReader.read();
        if (done) break;
        dlChunks.push(value);
        dlReceived += value.length;
        if (dlTotal > 0) {
            const pct = Math.min(100, Math.round(dlReceived / dlTotal * 100));  // ← only change
            status('Rendering Map... ' + pct + '% (' +
                (dlReceived / 1048576).toFixed(1) + ' MB)');
        } else {
            status('Rendering Map... ' +
                (dlReceived / 1048576).toFixed(1) + ' MB received');
        }
    }

  // Reassemble compressed bytes
  const compSize = dlChunks.reduce((s, c) => s + c.length, 0);
  const compressed = new Uint8Array(compSize);
  let pos = 0;
  for (const c of dlChunks) { compressed.set(c, pos); pos += c.length; }

  // Step 2: decompress
  status('Decompressing... (~10 seconds)');
  await new Promise(r => setTimeout(r, 30));
  const ds = new DecompressionStream('gzip');
  const decompResp = new Response(
    new Blob([compressed]).stream().pipeThrough(ds)
  );
  const rawBuf = await decompResp.arrayBuffer();
  const raw = new Uint8Array(rawBuf);

  // Step 3: parse binary header — v1=64 bytes (GNSS), v2=68 bytes (GNS2)
  status('Parsing header...');
  await new Promise(r => setTimeout(r, 30));
  const view    = new DataView(rawBuf);
  const magic   = String.fromCharCode(raw[0], raw[1], raw[2], raw[3]);
  if (magic !== 'GNSS' && magic !== 'GNS2') throw new Error(
    'Bad magic bytes — .data file may be from an older run. ' +
    'Re-run convert_csv_to_website_data.py to regenerate both files.');
  const version    = view.getUint32(4, true);
  const headerSize = (version >= 2) ? 68 : 64;
  const grid_h   = view.getUint32(8,  true);
  const grid_w   = view.getUint32(12, true);
  const lat_min  = view.getFloat64(16, true);
  const lat_max  = view.getFloat64(24, true);
  const lon_min  = view.getFloat64(32, true);
  const lon_max  = view.getFloat64(40, true);
  const n_epochs = view.getUint32(48, true);
  const hours    = Array.from(raw.slice(52, 52 + n_epochs));
  const hasBuildings = (version >= 2) ? view.getUint32(64, true) : 0;

  // Step 4: slice epoch data (zero-copy subarray views)
  status('Building map...');
  await new Promise(r => setTimeout(r, 30));
  const cellsPerEpoch = grid_h * grid_w;
  const epochBytes    = cellsPerEpoch * 4;
  const dataStart     = headerSize;
  const epochs = [];
  for (let e = 0; e < n_epochs; e++) {
    const offset = dataStart + e * epochBytes;
    epochs.push(raw.subarray(offset, offset + epochBytes));
  }

  // Step 5: building mask (v2 only) — 1 byte per cell, appended after epochs
  let buildingMask = null;
  if (hasBuildings) {
    const maskStart = dataStart + n_epochs * epochBytes;
    buildingMask    = raw.subarray(maskStart, maskStart + cellsPerEpoch);
    const nMasked   = buildingMask.reduce((s, v) => s + v, 0);
    status('Building mask: ' + nMasked.toLocaleString() + ' cells');
  }

  return {
    meta: { grid_h, grid_w, lat_min, lat_max, lon_min, lon_max, hours,
            hasBuildings: !!hasBuildings },
    epochs,
    buildingMask
  };
}

// =====================================================================
// APP STATE
// =====================================================================
let gpsData       = null;
let currentEpoch  = 0;
let currentMetric = 'pdop';
let playInterval  = null;
let canvasLayer   = null;
let map           = null;
let showBuildings = true;

const HOURS = [0,2,4,6,8,10,12,14,16,18,20,22];
const METRIC_IDX = { vdop: 0, hdop: 1, pdop: 2, sats: 3 };
const METRIC_LABELS = {
  pdop: 'PDOP · Lower = Better',
  hdop: 'HDOP · Lower = Better',
  vdop: 'VDOP · Lower = Better',
  sats: 'Satellites · Higher = Better'
};

// =====================================================================
// COLOR LOOKUP TABLES  (pre-built at startup for fast render)
// =====================================================================
const DOP_LUT  = new Uint8Array(256 * 3);
const SATS_LUT = new Uint8Array(21  * 3);

(function buildLUTs() {
  const stops = [
    [0.00, [0,   255, 157]],
    [0.15, [126, 255, 0  ]],
    [0.33, [255, 215, 0  ]],
    [0.50, [255, 149, 0  ]],
    [0.67, [255, 68,  68 ]],
    [0.83, [204, 0,   0  ]],
    [1.00, [136, 0,   0  ]]
  ];
  function colorFromNorm(t) {
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        const lo = stops[i-1], hi = stops[i];
        const f  = (t - lo[0]) / (hi[0] - lo[0]);
        return lo[1].map((c, j) => Math.round(c + f * (hi[1][j] - c)));
      }
    }
    return stops[stops.length-1][1];
  }
  for (let v = 0; v < 100; v++) {
    const norm = Math.min(Math.max((v/10.0 - 0.5) / 9.0, 0), 1);
    const rgb  = colorFromNorm(norm);
    DOP_LUT[v*3] = rgb[0]; DOP_LUT[v*3+1] = rgb[1]; DOP_LUT[v*3+2] = rgb[2];
  }
  for (let v = 100; v < 255; v++) {
    DOP_LUT[v*3] = 136; DOP_LUT[v*3+1] = 0; DOP_LUT[v*3+2] = 0;
  }
  for (let v = 1; v <= 20; v++) {
    const rgb = colorFromNorm(1 - v/20.0);
    SATS_LUT[v*3] = rgb[0]; SATS_LUT[v*3+1] = rgb[1]; SATS_LUT[v*3+2] = rgb[2];
  }
})();

function dopColor(val, isSats) {
  if (val === 255 || (val === 0 && !isSats)) return null;
  const base = val * 3;
  const lut  = isSats ? SATS_LUT : DOP_LUT;
  return [lut[base], lut[base+1], lut[base+2]];
}

// =====================================================================
// CANVAS LAYER
// =====================================================================
// Persistent offscreen canvas + pixel buffer — created once, reused every frame
let _offscreen = null;
let _offCtx    = null;
let _imgData   = null;
let _pixels32  = null;

// Building overlay
let _bldOffscreen = null;
let _bldRendered  = false;
const BUILDING_ARGB = (160 << 24) | (153 << 16) | (153 << 8) | 0;  // dark slate blue #483D8B

// 32-bit ARGB colour tables (little-endian 0xAABBGGRR) — one write per pixel
const DOP_ARGB      = new Uint32Array(256);
const SATS_ARGB     = new Uint32Array(21);
const NO_SIG_ARGB   = (209 << 24) | (92 << 16) | (58 << 8) | 58;
const BLOCKED_ARGB  = (230 << 24) | (50 << 16) | (50 << 8) | 255;
const CLEAR_ARGB    = 0x00000000;

(function buildARGB() {
  for (let v = 0; v < 256; v++) {
    const b = v * 3;
    DOP_ARGB[v] = (209 << 24) | (DOP_LUT[b+2] << 16) | (DOP_LUT[b+1] << 8) | DOP_LUT[b];
  }
  DOP_ARGB[255] = NO_SIG_ARGB;
  for (let v = 0; v < 21; v++) {
    const b = v * 3;
    SATS_ARGB[v] = (209 << 24) | (SATS_LUT[b+2] << 16) | (SATS_LUT[b+1] << 8) | SATS_LUT[b];
  }
})();

function renderEpoch() {
  if (!gpsData || !canvasLayer) return;

  const meta      = gpsData.meta;
  const epoch     = gpsData.epochs[currentEpoch];
  const isBlocked = currentMetric === 'blocked';
  const isSats    = currentMetric === 'sats';
  const metricIdx = isBlocked ? 0 : METRIC_IDX[currentMetric];
  const argbLut   = isSats ? SATS_ARGB : DOP_ARGB;

  const canvas = canvasLayer._canvas;
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const GW  = meta.grid_w;
  const GH  = meta.grid_h;
  const N   = GW * GH;

  if (!_offscreen || _offscreen.width !== GW || _offscreen.height !== GH) {
    _offscreen = new OffscreenCanvas(GW, GH);
    _offCtx    = _offscreen.getContext('2d');
    _imgData   = _offCtx.createImageData(GW, GH);
    _pixels32  = new Uint32Array(_imgData.data.buffer);
  }

  if (isBlocked) {
    for (let idx = 0; idx < N; idx++)
      _pixels32[idx] = (epoch[idx * 4] === 255) ? BLOCKED_ARGB : CLEAR_ARGB;
  } else {
    for (let idx = 0; idx < N; idx++) {
      const val = epoch[idx * 4 + metricIdx];
      _pixels32[idx] = (val === 255 || (val === 0 && !isSats)) ? NO_SIG_ARGB : argbLut[val];
    }
  }

  _offCtx.putImageData(_imgData, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(_offscreen, 0, 0, canvas.width, canvas.height);

  // Draw building footprint overlay on top
  if (gpsData.buildingMask && showBuildings) {
    if (!_bldRendered || !_bldOffscreen ||
        _bldOffscreen.width !== GW || _bldOffscreen.height !== GH) {
      _bldOffscreen = new OffscreenCanvas(GW, GH);
      const bCtx  = _bldOffscreen.getContext('2d');
      const bImg  = bCtx.createImageData(GW, GH);
      const bPx32 = new Uint32Array(bImg.data.buffer);
      const mask  = gpsData.buildingMask;
      for (let i = 0; i < N; i++)
        bPx32[i] = mask[i] ? BUILDING_ARGB : 0x00000000;
      bCtx.putImageData(bImg, 0, 0);
      _bldRendered = true;
    }
    ctx.drawImage(_bldOffscreen, 0, 0, canvas.width, canvas.height);
  }
}

// Custom Leaflet canvas layer
function createCanvasLayer() {
  const Layer = L.Layer.extend({
    _canvas: null,
    onAdd(map) {
      this._map = map;
      const pane = map.getPanes().overlayPane;
      this._canvas = L.DomUtil.create('canvas', '', pane);
      this._canvas.style.position = 'absolute';
      this._canvas.style.zIndex = 200;
      this._canvas.style.imageRendering = 'pixelated';
      map.on('moveend zoomend resize', this._update, this);
      this._update();
    },
    onRemove(map) {
      this._canvas.remove();
      map.off('moveend zoomend resize', this._update, this);
    },
    _update() {
      const map = this._map;
      const meta = gpsData ? gpsData.meta : null;
      if (!meta) return;

      const topLeft     = map.latLngToLayerPoint([meta.lat_max, meta.lon_min]);
      const bottomRight = map.latLngToLayerPoint([meta.lat_min, meta.lon_max]);
      const w = bottomRight.x - topLeft.x;
      const h = bottomRight.y - topLeft.y;

      this._canvas.style.left   = topLeft.x + 'px';
      this._canvas.style.top    = topLeft.y + 'px';
      this._canvas.style.width  = w + 'px';
      this._canvas.style.height = h + 'px';
      this._canvas.width  = meta.grid_w;
      this._canvas.height = meta.grid_h;

      renderEpoch();
    }
  });
  return new Layer();
}

// =====================================================================
// STATS
// =====================================================================
function updateStats() {
  if (!gpsData) return;
  const epoch     = gpsData.epochs[currentEpoch];
  const isBlocked = currentMetric === 'blocked';
  const isSats    = currentMetric === 'sats';
  const metricIdx = isBlocked ? 0 : METRIC_IDX[currentMetric];
  const total     = epoch.length / 4;

  if (isBlocked) {
    let blocked = 0;
    for (let i = 0; i < total; i++) { if (epoch[i * 4] === 255) blocked++; }
    const pct = (blocked / total * 100).toFixed(1);
    document.getElementById('stat-mean').textContent   = pct + '%';
    document.getElementById('stat-median').textContent = '—';
    document.getElementById('stat-min').textContent    = '0%';
    document.getElementById('stat-max').textContent    = '100%';
    document.getElementById('stat-nosig').textContent  = blocked + ' / ' + total;
    document.getElementById('stat-mean').className     = 'stat-val' +
      (parseFloat(pct) > 50 ? ' bad' : parseFloat(pct) > 20 ? ' mid' : ' good');
    return;
  }

  let sum = 0, count = 0, nosig = 0, vmin = Infinity, vmax = -Infinity;
  const hist = new Uint32Array(101);

  for (let i = 0; i < total; i++) {
    const raw = epoch[i * 4 + metricIdx];
    if (isSats ? (raw === 0) : (raw === 255)) { nosig++; continue; }
    const v = isSats ? raw : raw / 10;
    sum += v; count++;
    if (v < vmin) vmin = v;
    if (v > vmax) vmax = v;
    hist[Math.min(100, isSats ? Math.round(v * 5) : Math.round(v * 10))]++;
  }

  let median = '—';
  if (count > 0) {
    const half = count / 2; let cum = 0;
    for (let b = 0; b <= 100; b++) {
      cum += hist[b];
      if (cum >= half) { median = isSats ? (b/5).toFixed(1) : (b/10).toFixed(2); break; }
    }
  }
  const fmt  = isSats ? 1 : 2;
  const mean = count > 0 ? (sum / count).toFixed(fmt) : '—';
  const min  = isFinite(vmin) ? vmin.toFixed(isSats ? 0 : 2) : '—';
  const max  = isFinite(vmax) ? vmax.toFixed(isSats ? 0 : 2) : '—';

  document.getElementById('stat-mean').textContent   = mean;
  document.getElementById('stat-median').textContent = median;
  document.getElementById('stat-min').textContent    = min;
  document.getElementById('stat-max').textContent    = max;
  document.getElementById('stat-nosig').textContent  = nosig + ' / ' + total;
  if (!isSats) {
    const meanEl = document.getElementById('stat-mean');
    meanEl.className = 'stat-val' +
      (parseFloat(mean) < 2 ? ' good' : parseFloat(mean) < 4 ? ' mid' : ' bad');
  }
}

// =====================================================================
// UI CONTROLS
// =====================================================================
function setMetric(m) {
  currentMetric = m;
  document.querySelectorAll('.metric-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.metric === m);
  });

  const isSats    = m === 'sats';
  const isBlocked = m === 'blocked';
  document.getElementById('legend-range-label').textContent = METRIC_LABELS[m];
  document.getElementById('overlay-metric').innerHTML = `Metric: <span>${m.toUpperCase()}</span>`;

  if (isBlocked) {
    document.getElementById('legend-bar').style.background =
      'linear-gradient(to right, #0a0f1a 0%, #3a3a5c 40%, #ff4444 100%)';
    document.getElementById('legend-min').textContent = 'Signal';
    document.getElementById('legend-mid').textContent = '';
    document.getElementById('legend-max').textContent = 'Blocked';
  } else if (isSats) {
    document.getElementById('legend-bar').style.background =
      'linear-gradient(to right, #880000, #cc0000, #ff4444, #ff9500, #ffd700, #7eff00, #00ff9d)';
    document.getElementById('legend-min').textContent = '0';
    document.getElementById('legend-mid').textContent = '10';
    document.getElementById('legend-max').textContent = '20';
  } else {
    document.getElementById('legend-bar').style.background =
      'linear-gradient(to right, #00ff9d 0%, #7eff00 16%, #ffd700 33%, #ff9500 50%, #ff4444 66%, #cc0000 83%, #880000 100%)';
    document.getElementById('legend-min').textContent = '0.5';
    document.getElementById('legend-mid').textContent = '5.0';
    document.getElementById('legend-max').textContent = '9.9';
  }

  canvasLayer._update();
  updateStats();
}

function setEpoch(idx) {
  currentEpoch = parseInt(idx);
  document.getElementById('time-slider').value = idx;
  const h = HOURS[currentEpoch];
  document.getElementById('time-label').textContent  = String(h).padStart(2,'0') + ':00';
  document.getElementById('epoch-label').textContent = `Epoch ${currentEpoch+1}/12`;
  canvasLayer._update();
  updateStats();
}

function toggleBuildings() {
  showBuildings = !showBuildings;
  _bldRendered  = false;
  const btn = document.getElementById('bld-toggle-btn');
  if (btn) {
    btn.textContent   = showBuildings ? '🏢 Buildings: ON' : '🏢 Buildings: OFF';
    btn.style.opacity = showBuildings ? '1' : '0.4';
  }
  canvasLayer._update();
}

function togglePlay() {
  if (playInterval) {
    clearInterval(playInterval);
    playInterval = null;
    document.getElementById('play-btn').classList.remove('playing');
    document.getElementById('play-icon').textContent = '▶';
    document.getElementById('play-text').textContent = 'ANIMATE DAY';
  } else {
    document.getElementById('play-btn').classList.add('playing');
    document.getElementById('play-icon').textContent = '■';
    document.getElementById('play-text').textContent = 'STOP';
    playInterval = setInterval(() => { setEpoch((currentEpoch + 1) % 12); }, 1200);
  }
}

// =====================================================================
// MAP HOVER
// =====================================================================
function setupHover() {
  const meta = gpsData.meta;
  map.on('mousemove', (e) => {
    const { lat, lng } = e.latlng;
    if (lat < meta.lat_min || lat > meta.lat_max ||
        lng < meta.lon_min || lng > meta.lon_max) {
      document.getElementById('pv-pdop').textContent  = 'N/A';
      document.getElementById('pv-hdop').textContent  = 'N/A';
      document.getElementById('pv-vdop').textContent  = 'N/A';
      document.getElementById('pv-sats').textContent  = 'N/A';
      document.getElementById('pv-coords').innerHTML  = 'Hover over the map<br>to inspect a location';
      return;
    }

    const j = Math.round((lng - meta.lon_min) / (meta.lon_max - meta.lon_min) * (meta.grid_w - 1));
    const i = Math.round((meta.lat_max - lat) / (meta.lat_max - meta.lat_min) * (meta.grid_h - 1));
    if (i < 0 || i >= meta.grid_h || j < 0 || j >= meta.grid_w) return;

    const idx   = i * meta.grid_w + j;
    const epoch = gpsData.epochs[currentEpoch];
    const base  = idx * 4;
    const vdop  = epoch[base];
    const hdop  = epoch[base + 1];
    const pdop  = epoch[base + 2];
    const sats  = epoch[base + 3];
    const noSig = vdop === 255;

    document.getElementById('pv-pdop').textContent = noSig ? 'N/A' : (pdop/10).toFixed(2);
    document.getElementById('pv-hdop').textContent = noSig ? 'N/A' : (hdop/10).toFixed(2);
    document.getElementById('pv-vdop').textContent = noSig ? 'N/A' : (vdop/10).toFixed(2);
    document.getElementById('pv-sats').textContent = noSig ? '0' : sats;
    document.getElementById('pv-coords').innerHTML =
      `Lat: ${lat.toFixed(6)}°N<br>Lon: ${lng.toFixed(6)}°E` +
      (noSig ? '<br><span style="color:var(--bad)">● Blocked by building</span>' : '');
  });
}

// =====================================================================
// INIT
// =====================================================================
async function init() {
  const subEl = document.querySelector('.loading-sub');
  const t0 = performance.now();
  const log = [];
  function status(msg) {
    const s    = ((performance.now() - t0) / 1000).toFixed(2);
    const line = '[' + s + 's] ' + msg;
    log.push(line);
    subEl.textContent = log.slice(-6).join('\n');
    console.log(line);
  }

  status('Initialising map...');
  map = L.map('map', {
    center: [51.050, -114.075],
    zoom: 14,
    zoomControl: true,
    attributionControl: false
  });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19
  }).addTo(map);
  status('Map ready');

  try {
    status('Loading GNSS data...');
    gpsData = await loadData();
    status('Data loaded — ' + gpsData.epochs.length + ' epochs, ' +
      gpsData.meta.grid_w + 'x' + gpsData.meta.grid_h + ' grid');
  } catch(e) {
    console.error('Data load failed:', e);
    document.querySelector('.loading-title').textContent = 'Error Loading Data';
    subEl.textContent = e && e.message ? e.message : String(e);
    return;
  }

  status('Creating canvas overlay...');
  await new Promise(r => setTimeout(r, 20));
  canvasLayer = createCanvasLayer();
  canvasLayer.addTo(map);
  status('Canvas overlay ready');

  status('Setting metric (PDOP)...');
  await new Promise(r => setTimeout(r, 20));
  setMetric('pdop');
  status('Metric set');

  status('Rendering epoch 0...');
  await new Promise(r => setTimeout(r, 20));
  setEpoch(0);
  status('Epoch rendered');

  status('Setting up hover...');
  setupHover();
  status('Done — total ' + ((performance.now() - t0) / 1000).toFixed(2) + 's');

  await new Promise(r => setTimeout(r, 800));
  document.getElementById('loading-overlay').classList.add('hidden');
}

// =====================================================================
// PANEL — DESKTOP RESIZE + DOCK  /  MOBILE RESIZE + DOCK
// =====================================================================
(function setupPanel() {
  const sidebar      = document.getElementById('sidebar');
  const resizeHandle = document.getElementById('resize-handle');
  const dockBtn      = document.getElementById('dock-btn');
  const mobileDock   = document.getElementById('mobile-dock-btn');
    if (window.innerWidth <= 600) mobileDock.style.bottom = 'calc(44vh + 2vh)';
  const mobileResize = document.getElementById('mobile-resize-handle');

  let collapsed = false;
  let lastWidth = 320;

  // ── Desktop: toggle collapse ────────────────────────────────────────
  function desktopToggle() {
    if (!collapsed) {
      lastWidth = sidebar.offsetWidth;
      collapsed = true;
      sidebar.style.width    = '0';
      sidebar.style.minWidth = '0';
      sidebar.classList.add('collapsed');
    } else {
      collapsed = false;
      sidebar.style.width    = lastWidth + 'px';
      sidebar.style.minWidth = '180px';
      sidebar.classList.remove('collapsed');
    }
    dockBtn.textContent = collapsed ? '▶' : '◀';
    setTimeout(() => { if (map) map.invalidateSize(); }, 280);
  }
  dockBtn.addEventListener('click', desktopToggle);

  // ── Desktop: drag to resize ─────────────────────────────────────────
  let dragging = false;
  let dragStartX, dragStartW;

  resizeHandle.addEventListener('mousedown', e => {
    if (e.target === dockBtn) return;   // let button click through
    dragging   = true;
    dragStartX = e.clientX;
    dragStartW = sidebar.offsetWidth;
    resizeHandle.classList.add('dragging');
    document.body.style.cursor     = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const newW = Math.min(520, Math.max(180, dragStartW + e.clientX - dragStartX));
    sidebar.style.width = newW + 'px';
    lastWidth = newW;
    if (collapsed) {
      collapsed = false;
      sidebar.classList.remove('collapsed');
      sidebar.style.minWidth = '180px';
      dockBtn.textContent = '◀';
    }
    if (map) map.invalidateSize();
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizeHandle.classList.remove('dragging');
    document.body.style.cursor     = '';
    document.body.style.userSelect = '';
  });

  // ── Mobile: toggle collapse ─────────────────────────────────────────
  // The mobile dock button is sticky at the top of the sidebar,
  // so it stays visible even when the panel is collapsed to 48px.
  let mobileCollapsed = false;
  let lastMobileH     = null;

function mobileToggle() {
    if (!mobileCollapsed) {
        lastMobileH = sidebar.style.height || '44vh';
        mobileCollapsed = true;
        sidebar.classList.add('collapsed');
        mobileDock.innerHTML = '▲ SHOW PANEL';
        mobileDock.style.bottom = '2vh';              // panel hidden — sit near bottom
    } else {
        mobileCollapsed = false;
        sidebar.classList.remove('collapsed');
        if (lastMobileH) sidebar.style.height = lastMobileH;
        mobileDock.innerHTML = '▼ HIDE PANEL';
        mobileDock.style.bottom = 'calc(' + (lastMobileH || '44vh') + ' + 2vh)'; // above panel
    }
    setTimeout(() => { if (map) map.invalidateSize(); }, 320);
}
  mobileDock.addEventListener('click', mobileToggle);

  // ── Mobile: touch-drag top edge to resize ───────────────────────────
  let touchDragging = false;
  let touchStartY, touchStartH;

  mobileResize.addEventListener('touchstart', e => {
    touchDragging = true;
    touchStartY   = e.touches[0].clientY;
    touchStartH   = sidebar.offsetHeight;
    e.preventDefault();
  }, { passive: false });

  document.addEventListener('touchmove', e => {
    if (!touchDragging) return;
    const dy   = touchStartY - e.touches[0].clientY;
    const newH = Math.min(window.innerHeight * 0.78, Math.max(48, touchStartH + dy));
    sidebar.style.height = newH + 'px';
    mobileDock.style.bottom = 'calc(' + newH + 'px + 2vh)';
    if (mobileCollapsed && newH > 60) {
      mobileCollapsed      = false;
      sidebar.classList.remove('collapsed');
      mobileDock.innerHTML = '▼ HIDE PANEL';
    }
    if (map) map.invalidateSize();
    e.preventDefault();
  }, { passive: false });

  document.addEventListener('touchend', () => { touchDragging = false; });

  window.addEventListener('resize', () => { if (map) map.invalidateSize(); });
})();

window.addEventListener('load', init);
