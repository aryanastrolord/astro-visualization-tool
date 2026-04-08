// ============================================================
// app.js — Astro Analytics · Central controller + UI bindings v8
// ============================================================
window.App = (() => {

  // ── Application State ─────────────────────────────────────
  const state = {
    activeDatasetId:  null,
    activeMapId:      null,
    activeSessionIds: [],
    activeEntityIds:  [],
    activeMapIds:     [],   // filter by map_id field in events ([] = show all)

    layers: {
      paths:   true,   // default ON — most Nakama data is path-based
      points:  true,
      heatmap: false,
    },
    settings: {
      pathThickness:    2,
      heatmapIntensity: 0.7,
      playbackSpeed:    1,
    },

    // Per-map calibration state (keyed by mapId)
    // calibData[mapId] = { refPoints: [], pending: null, open: false }
    calibData: {},

    savedViews: [],
    processingIds: new Set(),  // dataset IDs currently being processed
  };

  // ── Map-ID column detection ──────────────────────────────
  // Finds the spatial grouping column in rawRows (same patterns as ETL auto-detect).
  // Returns the column name or null if not found / rawRows empty.
  const _MAP_ID_PATTERNS = ['map_id', 'mapid', 'map', 'level', 'scene', 'zone', 'area', 'world', 'location'];
  function _detectMapIdCol(rawRows) {
    if (!rawRows || rawRows.length === 0) return null;
    return Object.keys(rawRows[0])
      .filter(k => k !== '_table_id')
      .find(k => _MAP_ID_PATTERNS.includes(k.toLowerCase())) || null;
  }

  // Collect unique map_id values from rawRows using the detected column
  function _rawRowMapIds(rawRows) {
    const col = _detectMapIdCol(rawRows);
    if (!col) return new Set();
    const ids = new Set();
    for (const r of rawRows) {
      const v = String(r[col] ?? '').trim();
      if (v) ids.add(v);
    }
    return ids;
  }

  // ── Map-ID event filtering ───────────────────────────────
  // Shared by _doRender and _regenHeatmap. Filters events to only those
  // belonging to the active map, preventing cross-map coordinate pollution.
  // Caches result so playback frames don't re-scan rawRows every frame.
  let _mapFilterCache = { key: null, events: null };

  function _invalidateMapFilterCache() { _mapFilterCache = { key: null, events: null }; }

  function _filterEventsByActiveMap(events, ds, map) {
    if (!map?.name) return events;

    const manualKey = state.activeMapIds.join(',');
    const cacheKey  = `${ds.id}::${map.name}::${manualKey}`;

    // Return cached result when dataset+map+manual-filter haven't changed
    if (_mapFilterCache.key === cacheKey && _mapFilterCache.events) {
      return _mapFilterCache.events;
    }

    const mapNameLower = map.name.toLowerCase();
    const _mapMatch = (id) =>
      id && (id.toLowerCase() === mapNameLower ||
             id.toLowerCase().includes(mapNameLower) ||
             mapNameLower.includes(id.toLowerCase()));

    let filtered;
    if (state.activeMapIds.length > 0) {
      const allowed = new Set(state.activeMapIds);
      filtered = events.filter(ev => allowed.has(ev.map_id));
    } else if (ds.processed.map_ids?.size > 0) {
      filtered = events.filter(ev => !ev.map_id || _mapMatch(ev.map_id));
    } else {
      // Fallback: rawRow scan — run ONCE then cache
      const rawRows  = ds.rawRows;
      const mapIdCol = _detectMapIdCol(rawRows);
      if (!rawRows || !mapIdCol) {
        filtered = events; // no map_id column → show all
      } else {
        const dsPrefix = ds.id + '_';
        const kept = new Set();
        for (const ev of events) {
          const idx = parseInt(ev.event_id.slice(dsPrefix.length), 10);
          const raw = rawRows[idx];
          if (!raw) { kept.add(ev.event_id); continue; }
          const rawMapId = String(raw[mapIdCol] ?? '').trim();
          if (!rawMapId || _mapMatch(rawMapId)) kept.add(ev.event_id);
        }
        filtered = events.filter(ev => kept.has(ev.event_id));
      }
    }

    _mapFilterCache = { key: cacheKey, events: filtered };
    return filtered;
  }

  // ── Deferred render ───────────────────────────────────────
  let _renderPending = false;
  function scheduleRender() {
    if (_renderPending) return;
    _renderPending = true;
    requestAnimationFrame(() => { _renderPending = false; _doRender(); });
  }

  // ── Render event cache ────────────────────────────────────
  // Pre-computes filtered events + pixel coords + pre-grouped path/marker
  // structures ONCE per dataset/map/filter combination.
  // During playback only tsUpTo changes — the expensive work is skipped
  // every frame, giving truly smooth 60fps animation.
  let _eventsCache = { key: null, precomputed: null };
  function _invalidateEventsCache() { _eventsCache = { key: null, precomputed: null }; }

  function _getPrecomputed(ds, map) {
    const manualKey  = state.activeMapIds.join(',');
    const sessionKey = state.activeSessionIds.join(',');
    const tableKey   = (ds.tables || [])
      .map(t => `${t.id}:${(t.render_modes_enabled || []).join('|')}`).join(',');
    const cacheKey   = `${ds.id}::${map.id}::${manualKey}::${sessionKey}::${tableKey}`;

    if (_eventsCache.key === cacheKey && _eventsCache.precomputed) return _eventsCache.precomputed;

    // Build per-table render-mode set
    const tableEnabledModes = {};
    for (const t of (ds.tables || [])) {
      tableEnabledModes[t.id] = new Set(t.render_modes_enabled || ['path', 'point', 'heatmap']);
    }
    const hasTableFilter = Object.keys(tableEnabledModes).length > 0;

    let events = _filterEventsByActiveMap(ds.processed.events, ds, map);
    if (state.activeSessionIds.length > 0) {
      const sSet = new Set(state.activeSessionIds);
      events = events.filter(ev => sSet.has(ev.session_id));
    }
    events = Filters.applyToEvents(events);

    // Pre-group into path chains and marker list — do this ONCE so the
    // renderer never rebuilds these structures per frame.
    const cal        = map.calibration;
    const pathGroups = new Map();   // key → { rule, points[] } sorted by timestamp
    const markers    = [];          // { px, py, rule, icon, markerText, timestamp }

    for (const ev of events) {
      const rule = EventRules.getRule(ev.event_type);
      if (!rule) continue;

      // Per-table mode filter
      if (hasTableFilter && ev.table_id) {
        const modes = tableEnabledModes[ev.table_id];
        if (modes && !rule.render_modes.some(m => modes.has(m))) continue;
      }

      // Pre-compute pixel position
      let { px, py } = (ev.px != null && ev.py != null)
        ? ev
        : Calibration.worldToPixel(ev.x, ev.y, cal);

      if (rule.render_modes.includes('path')) {
        const key = `${ev.session_id || ''}::${ev.entity_id}::${ev.event_type}`;
        if (!pathGroups.has(key)) pathGroups.set(key, { rule, points: [] });
        pathGroups.get(key).points.push({ px, py, timestamp: ev.timestamp });
      }
      if (rule.render_modes.includes('point')) {
        const markerText = rule.label
          ? rule.label.slice(0, 2)
          : ev.event_type.charAt(0).toUpperCase();
        markers.push({ px, py, timestamp: ev.timestamp, rule, icon: rule.icon || null, markerText });
      }
    }

    // Sort each path group by timestamp (ensures correct line order)
    for (const [, g] of pathGroups) g.points.sort((a, b) => a.timestamp - b.timestamp);
    // Sort markers by timestamp for binary search during playback
    markers.sort((a, b) => a.timestamp - b.timestamp);

    const precomputed = { pathGroups, markers };
    _eventsCache = { key: cacheKey, precomputed };
    return precomputed;
  }

  function _doRender() {
    const ds  = state.activeDatasetId ? DatasetRegistry.get(state.activeDatasetId) : null;
    const map = state.activeMapId     ? MapRegistry.get(state.activeMapId)          : null;

    if (!ds?.processed || !map?.calibration) {
      Renderer.redrawPrecomputed(null, state.layers, Infinity, state.settings);
      return;
    }

    const pb     = Playback.getState();
    const tsUpTo = (pb.status === 'playing' || pb.status === 'paused') ? pb.currentTs : Infinity;
    Renderer.redrawPrecomputed(_getPrecomputed(ds, map), state.layers, tsUpTo, state.settings);
  }

  // ── Heatmap ───────────────────────────────────────────────
  async function _regenHeatmap() {
    if (!state.layers.heatmap) { Renderer.clearHeatmap(); return; }
    const ds  = state.activeDatasetId ? DatasetRegistry.get(state.activeDatasetId) : null;
    const map = state.activeMapId     ? MapRegistry.get(state.activeMapId)          : null;
    if (!ds?.processed || !map?.calibration) { Renderer.clearHeatmap(); return; }

    let events = ds.processed.events;
    // Same map-ID filtering as _doRender (including rawRow fallback)
    events = _filterEventsByActiveMap(events, ds, map);
    events = Filters.applyToEvents(events);
    const heatEvents = events.filter(ev => {
      const rule = EventRules.getRule(ev.event_type);
      return rule?.render_modes?.includes('heatmap') && rule.visible;
    });
    if (heatEvents.length === 0) { Renderer.clearHeatmap(); scheduleRender(); return; }

    const cal  = map.calibration;
    const imgW = map.width  || 1024;
    const imgH = map.height || 1024;
    const pb   = Playback.getState();
    const tsUpTo = (pb.status === 'playing' || pb.status === 'paused') ? pb.currentTs : Infinity;

    const withPx = heatEvents.map(ev => {
      const { px, py } = Calibration.worldToPixel(ev.x, ev.y, cal);
      return { ...ev, px: (px / imgW) * 1024, py: (py / imgH) * 1024 };
    });

    const bitmap = await Heatmap.generate(withPx, state.settings.heatmapIntensity, tsUpTo);
    if (bitmap) Renderer.setHeatmapBitmap(bitmap);
    else        Renderer.clearHeatmap();
    scheduleRender();
  }

  // ── Active dataset / map setters ─────────────────────────
  function setActiveDataset(id) {
    state.activeDatasetId  = id || null;
    state.activeSessionIds = [];
    state.activeEntityIds  = [];
    state.activeMapIds     = [];
    _invalidateMapFilterCache();
    _invalidateEventsCache();
    Filters.reset();

    const ds = id ? DatasetRegistry.get(id) : null;
    if (ds?.processed) {
      _populateSessionSelector(Array.from(ds.processed.sessions.keys()));
      _populateEventTypeFilter(Array.from(ds.processed.event_types));
      // Use processed map_ids if available; fall back to scanning rawRows
      const mapIds = (ds.processed.map_ids?.size > 0)
        ? ds.processed.map_ids
        : _rawRowMapIds(ds.rawRows);
      _populateMapIdSelector(mapIds);
      Playback.setRange(0, ds.processed.durationMs || 0);
    } else {
      _populateSessionSelector([]);
      _populateEventTypeFilter([]);
      _populateMapIdSelector(new Set());
    }

    // Sync both the upload-tab selector and the top-level selector
    const sel = document.getElementById('dataset-selector');
    if (sel) sel.value = id || '';

    _regenHeatmap();
    scheduleRender();
  }

  function setActiveMap(id) {
    state.activeMapId = id || null;
    state.activeMapIds = [];
    _invalidateMapFilterCache();
    _invalidateEventsCache();
    const map = id ? MapRegistry.get(id) : null;
    Renderer.loadMap(map).then(() => { _regenHeatmap(); scheduleRender(); });

    const sel = document.getElementById('map-selector');
    if (sel) sel.value = id || '';

    // Re-populate the map ID dropdown for the new active map
    const ds = state.activeDatasetId ? DatasetRegistry.get(state.activeDatasetId) : null;
    if (ds?.processed || ds?.rawRows) {
      const mapIds = (ds.processed?.map_ids?.size > 0)
        ? ds.processed.map_ids
        : _rawRowMapIds(ds.rawRows);
      _populateMapIdSelector(mapIds);  // re-runs with new state.activeMapId → pre-checks correct entry
    }
  }

  // ── Preset maps preloading ────────────────────────────────
  // Calibration source: player_data/README.md
  //
  // README formula (1024×1024 reference):
  //   u = (x - origin_x) / scale       → pixel_x = u * imgW
  //   v = (z - origin_z) / scale       → pixel_y = (1 - v) * imgH  (Y flipped)
  //
  // Our CalibrationConfig formula: px = (wx - origin_x) / scale_x [then invert]
  //   → scale_x = scale / imgW   (world units per actual image pixel)
  //   → scale_y = scale / imgH   (must use ACTUAL image dimensions, not 1024)
  //
  // NOTE: images may NOT be 1024×1024 (AmbroseValley is 4320×4320 etc.).
  //       scale must be computed AFTER the image loads using actual dimensions.
  //
  // Nakama field mapping: x→x, z→y(2D), y→z(elevation), ts→timestamp,
  //   user_id→entity_id, event→event_type, match_id→session_id, map_id→map_id
  const PRESET_MAPS = [
    { url: 'player_data/minimaps/AmbroseValley_Minimap.png', name: 'AmbroseValley', v1scale: 900,  origin_x: -370, origin_z: -473 },
    { url: 'player_data/minimaps/GrandRift_Minimap.png',     name: 'GrandRift',     v1scale: 581,  origin_x: -290, origin_z: -290 },
    { url: 'player_data/minimaps/Lockdown_Minimap.jpg',      name: 'Lockdown',      v1scale: 1000, origin_x: -500, origin_z: -500 },
  ];


  async function _preloadDefaultMaps() {
    console.log('[App] Preloading preset maps…');
    const mapListEl = document.getElementById('map-list');
    if (mapListEl) mapListEl.innerHTML = '<p class="empty-hint"><i class="ti ti-loader-2 spin" style="margin-right:4px"></i>Loading preset maps…</p>';

    const overlay = document.getElementById('map-loading-overlay');
    const subEl   = document.getElementById('map-loading-sub');
    if (overlay) overlay.classList.remove('hidden');

    let firstId = null;
    for (const preset of PRESET_MAPS) {
      if (subEl) subEl.textContent = `Fetching ${preset.name}…`;
      try {
        const record = await MapRegistry.addFromUrl(preset.url, preset.name);
        // Use ACTUAL image dimensions (may differ from 1024×1024)
        const imgW = record.width  || 1024;
        const imgH = record.height || 1024;
        // scale_x = world_units_per_pixel = v1scale / actual_image_size
        const cal = Calibration.buildFromInputs({
          origin_x: preset.origin_x,
          origin_y: preset.origin_z,   // Z column is the 2D Y axis in Nakama
          scale_x:  preset.v1scale / imgW,
          scale_y:  preset.v1scale / imgH,
          invert_x: false,
          invert_y: true,              // pixel_y = imgH - py_pre (README formula)
          axis_map: 'xz',
          img_w:    imgW,
          img_h:    imgH,
        });
        MapRegistry.setCalibration(record.id, cal);
        if (!firstId) firstId = record.id;
        console.log(`[App] ✓ Map "${preset.name}" loaded: ${imgW}×${imgH}px, scale_x=${(preset.v1scale/imgW).toFixed(4)}, origin=(${preset.origin_x},${preset.origin_z})`);
      } catch (e) {
        console.error(`[App] ✗ Could not preload "${preset.name}":`, e.message);
      }
    }
    if (firstId && !state.activeMapId) {
      setActiveMap(firstId);
      console.log('[App] Auto-selected first preset map:', firstId);
      // Wait for the map to actually paint before hiding overlay
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (overlay) overlay.classList.add('hidden');
      }));
    }
    if (!firstId) {
      // All maps failed — show retry UI in overlay
      if (overlay) {
        const card = overlay.querySelector('.map-loading-card');
        if (card) {
          card.innerHTML = `
            <div class="map-loading-spinner" style="color:var(--warning)"><i class="ti ti-alert-triangle"></i></div>
            <div class="map-loading-text">Maps failed to load</div>
            <div class="map-loading-sub">Requires a local HTTP server on port 8080, or upload a map manually.</div>
            <div style="display:flex;gap:8px;margin-top:12px;justify-content:center;flex-wrap:wrap">
              <button class="btn btn-sm btn-secondary" id="map-retry-btn"><i class="ti ti-refresh"></i> Retry</button>
              <button class="btn btn-sm btn-ghost" id="map-dismiss-btn">Dismiss</button>
            </div>`;
          document.getElementById('map-retry-btn')?.addEventListener('click', () => {
            card.innerHTML = `
              <div class="map-loading-spinner"><i class="ti ti-loader-2 spin"></i></div>
              <div class="map-loading-text">Loading map…</div>
              <div class="map-loading-sub" id="map-loading-sub">Fetching preset maps from server</div>`;
            _preloadDefaultMaps();
          });
          document.getElementById('map-dismiss-btn')?.addEventListener('click', () => {
            overlay.classList.add('hidden');
          });
        }
      }
      if (mapListEl && !MapRegistry.getAll().length) {
        mapListEl.innerHTML = '<p class="empty-hint" style="color:var(--warning)"><i class="ti ti-alert-triangle"></i> Preset maps could not load — requires HTTP server (localhost:8080). Upload maps manually.</p>';
      }
    }
  }

  // ── Init ──────────────────────────────────────────────────
  function init() {
    _loadSavedViews();

    Renderer.init(document.getElementById('minimap-canvas'));
    Renderer.setInteractCallback(() => scheduleRender());

    _initPlayback();
    _initFilters();
    _initTabs();
    _initDatasetUI();
    _initEventRulesUI();
    _initMapsUI();
    _initVisualizationUI();
    _initViewsUI();
    _initTopBar();
    _initPlaybackBar();
    _initAssistant();

    // Registry → UI sync
    DatasetRegistry.onChange(_onDatasetsChanged);
    MapRegistry.onChange(_onMapsChanged);
    EventRules.onChange(_onEventRulesChanged);

    UI.renderSavedViews(state.savedViews);
    scheduleRender();

    // Preload preset maps immediately — no DuckDB dependency for map loading
    _preloadDefaultMaps();
  }

  // ── Playback wiring ───────────────────────────────────────
  function _initPlayback() {
    // 'frame' fires every rAF during playback — only update scrubber/time, not full UI
    Playback.on('frame', () => { _updateScrubber(); scheduleRender(); });
    // State-change events update the full UI (play/pause button, status)
    ['play','pause','stop','ended','rangeSet'].forEach(ev =>
      Playback.on(ev, () => { _updatePlaybackUI(); scheduleRender(); })
    );
  }

  function _initFilters() {
    Filters.onChange(() => { _invalidateEventsCache(); _regenHeatmap(); scheduleRender(); });
    EventRules.onChange(() => { _invalidateEventsCache(); scheduleRender(); });
  }

  // ── Tab + Sub-tab switching ───────────────────────────────
  function _initTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => _switchTab(btn.dataset.tab));
    });

    // Sub-tab buttons (inside Data and Rules tabs)
    document.querySelectorAll('.sub-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const subtabId = btn.dataset.subtab;
        // Find sibling sub-tab buttons (same parent)
        btn.closest('.sub-tab-bar').querySelectorAll('.sub-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        // Show matching sub-tab-content, hide others in the same tab-content parent
        const tabContent = btn.closest('.tab-content');
        tabContent.querySelectorAll('.sub-tab-content').forEach(c => c.classList.remove('active'));
        document.getElementById('sub-' + subtabId)?.classList.add('active');
      });
    });
  }

  function _switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabName));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === 'tab-' + tabName));

    // Manage calibration click mode — active when Maps tab is open AND a map's calib panel is open
    const inMaps = tabName === 'maps';
    const calibMapId = _getOpenCalibMapId();
    Renderer.setCalibrationMode(inMaps && !!calibMapId, inMaps && calibMapId ? (pt) => _onCalibCanvasClick(calibMapId, pt) : null);
  }

  // ── Dataset tab ───────────────────────────────────────────
  function _initDatasetUI() {
    document.getElementById('btn-upload-csv')?.addEventListener('click',    () => document.getElementById('input-csv')?.click());
    document.getElementById('btn-upload-parquet')?.addEventListener('click', () => document.getElementById('input-parquet')?.click());
    document.getElementById('btn-upload-folder')?.addEventListener('click',  () => document.getElementById('input-folder')?.click());

    // IMPORTANT: capture FileList into Array BEFORE resetting value,
    // because resetting input.value clears the live FileList reference.
    const _onFiles = (e) => {
      const files = Array.from(e.target.files); // snapshot
      e.target.value = '';                       // allow re-picking same file
      if (files.length) _handleFileUpload(files);
    };
    document.getElementById('input-csv')?.addEventListener('change',     _onFiles);
    document.getElementById('input-parquet')?.addEventListener('change', _onFiles);
    document.getElementById('input-folder')?.addEventListener('change',  _onFiles);

    // Sample data loader
    document.getElementById('btn-load-sample')?.addEventListener('click', _loadSampleData);

    // Active dataset selector in Upload sub-tab
    document.getElementById('dataset-selector')?.addEventListener('change', e =>
      setActiveDataset(e.target.value || null));
  }

  async function _loadSampleData(autoProcess = false, onProgress = null) {
    const btn = document.getElementById('btn-load-sample');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader-2 spin"></i> Loading…'; }
    UI.showProgress(-1, 'Fetching sample data…');
    let record = null;
    try {
      const resp = await fetch('player_data/February_14/index.json');
      if (!resp.ok) throw new Error('Could not fetch sample data index. Make sure the server is running (python serve.py).');
      const fileNames = await resp.json();
      const total = fileNames.filter(n => n !== 'index.json').length;

      onProgress?.('Fetching sample files…', 0);
      const files = [];
      for (let i = 0; i < fileNames.length; i++) {
        const name = fileNames[i];
        if (name === 'index.json') continue;
        const r = await fetch(`player_data/February_14/${name}`);
        if (!r.ok) { console.warn(`[Sample] Skip ${name}: ${r.status}`); continue; }
        const blob = await r.blob();
        files.push(new File([blob], name, { type: blob.type }));
        const pct = Math.round((files.length / total) * 60); // 0–60% for fetching
        if (files.length % 10 === 0) {
          UI.showProgress(-1, `Fetching files… ${files.length}/${total}`);
          onProgress?.(`Fetching files… ${files.length} of ${total}`, pct);
        }
      }
      if (!files.length) throw new Error('No files fetched from sample data folder.');
      onProgress?.('Reading data…', 65);
      record = await _handleFileUpload(files, { silent: autoProcess });
    } catch (err) {
      UI.hideProgress();
      UI.showToast('Sample load failed: ' + err.message, 'error');
      console.error('[App] Sample load:', err);
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-database-import"></i> Load Sample Data'; }
    }
    if (autoProcess && record?.id) {
      onProgress?.('Processing data…', 75);
      await _processDataset(record.id);
      onProgress?.('Done!', 100);
    }
  }

  // Friendly progress messages — hide internal technical terms from users
  function _friendlyProgress(msg) {
    if (!msg) return 'Loading…';
    const m = msg.toLowerCase();
    if (m.includes('duckdb') || m.includes('wasm') || m.includes('pragma') || m.includes('ready ✓')) return 'Preparing data engine…';
    if (m.includes('parquet') || m.includes('reading')) return 'Reading files…';
    if (m.includes('query') || m.includes('sql')) return 'Parsing data…';
    return msg;
  }

  async function _handleFileUpload(files, { silent = false } = {}) {
    if (!files?.length) return null;
    UI.showProgress(-1, 'Reading files…');
    try {
      const { rawRows, columns, tables } = await ETL.loadRawFiles(files, msg => UI.showProgress(-1, _friendlyProgress(msg)));
      // Determine collection name: folder name or first file name
      const name = files[0].webkitRelativePath
        ? files[0].webkitRelativePath.split('/')[0]
        : files[0].name;
      const fileType = name.toLowerCase().endsWith('.csv') ? 'csv' : 'parquet';
      const record   = DatasetRegistry.add(name, fileType, rawRows, columns, tables);
      UI.hideProgress();
      if (!silent) UI.showToast(`Loaded ${rawRows.length.toLocaleString()} rows from ${tables.length} file(s). Use "Suggest" then "Process" on the dataset card.`, 'success');
      return record;
    } catch (err) {
      UI.hideProgress();
      UI.showToast('Error: ' + err.message, 'error');
      console.error('[App]', err);
      return null;
    }
  }



  function _onDatasetsChanged(datasets) {
    _renderDatasetList(datasets);
    _syncDatasetSelector(datasets);
    _updateChatWelcome(datasets);
  }

  function _updateChatWelcome(datasets) {
    const panel     = document.getElementById('astro-welcome-panel');
    const actionsEl = document.getElementById('astro-welcome-actions');
    if (!panel) return;

    const hasAny = datasets.length > 0;

    if (!hasAny) {
      // No data at all — show full welcome with buttons
      panel.style.display = '';
      if (actionsEl) actionsEl.style.display = 'flex';
    } else if (panel.style.display !== 'none') {
      // Data was uploaded from the Data tab (panel wasn't hidden by the chat button)
      // Keep the icon+title visible but hide the action buttons
      if (actionsEl) actionsEl.style.display = 'none';
    }
    // If panel.display === 'none', the user loaded via the chat button — bubble is the UI, leave it hidden
  }

  /** Inject a live-updating assistant bubble. Returns { setText, setDone } controllers. */
  function _createLoadingBubble(initialText) {
    const container = document.getElementById('chat-messages');
    if (!container) return { setText: () => {}, setDone: () => {} };

    const wrap = document.createElement('div');
    wrap.className = 'chat-message chat-assistant';
    wrap.innerHTML = `
      <div class="chat-bubble">
        <div class="bubble-status-text" style="margin-bottom:8px;font-size:12px;line-height:1.5">
          <i class="ti ti-loader-2 spin" style="margin-right:5px;font-size:11px"></i>
          <span id="bubble-status-label">${initialText}</span>
        </div>
        <div class="bubble-progress-track">
          <div class="bubble-progress-bar" id="bubble-progress-bar"></div>
        </div>
      </div>`;
    container.appendChild(wrap);
    container.scrollTop = container.scrollHeight;

    let pct = 0;
    const barEl   = wrap.querySelector('#bubble-progress-bar');
    const labelEl = wrap.querySelector('#bubble-status-label');

    function setText(text, progress) {
      if (labelEl) labelEl.textContent = text;
      if (progress != null) {
        pct = Math.min(100, progress);
        if (barEl) barEl.style.width = pct + '%';
      }
      container.scrollTop = container.scrollHeight;
    }

    function setDone(text) {
      const statusRow = wrap.querySelector('.bubble-status-text');
      const track     = wrap.querySelector('.bubble-progress-track');
      if (barEl) barEl.style.width = '100%';
      if (track) {
        setTimeout(() => {
          if (statusRow) statusRow.innerHTML = `<i class="ti ti-circle-check" style="color:var(--accent);margin-right:5px"></i><span>${text}</span>`;
          if (track) track.style.display = 'none';
          container.scrollTop = container.scrollHeight;
        }, 400);
      }
    }

    return { setText, setDone };
  }

  function _syncDatasetSelector(datasets) {
    const el = document.getElementById('dataset-selector');
    if (!el) return;
    const cur = el.value;
    el.innerHTML = '<option value="">— select active dataset —</option>' +
      datasets.filter(d => d.status === 'processed')
              .map(d => `<option value="${d.id}">${d.name}</option>`).join('');
    if (cur && datasets.find(d => d.id === cur && d.status === 'processed')) el.value = cur;
    else if (state.activeDatasetId) el.value = state.activeDatasetId;
  }

  function _renderDatasetList(datasets) {
    const container = document.getElementById('dataset-list');
    if (!container) return;
    if (datasets.length === 0) {
      container.innerHTML = '<p class="empty-hint">No datasets loaded yet.<br>Upload a CSV or Parquet file above.</p>';
      return;
    }

    container.innerHTML = datasets.map(d => {
      const isProcessing = state.processingIds.has(d.id);
      const displayStatus = isProcessing ? 'processing' : d.status;
      // mappingFields available for future use

      return `
      <div class="dataset-card ${d.id === state.activeDatasetId ? 'active' : ''}" data-id="${d.id}">
        <div class="dataset-card-header">
          <span class="dataset-name" title="${d.name}">${d.name}</span>
          <div class="ds-header-actions">
            <span class="status-badge status-${displayStatus}">${isProcessing ? '<i class="ti ti-loader-2 spin"></i> processing' : displayStatus}</span>
            <button class="icon-btn ds-btn-delete danger-btn" data-id="${d.id}" title="Delete dataset"><i class="ti ti-trash"></i></button>
          </div>
        </div>
        <div class="dataset-meta">${d.row_count.toLocaleString()} rows · ${d.col_count} cols · ${d.file_type.toUpperCase()}</div>
        ${d.error ? `<div class="dataset-error"><i class="ti ti-alert-circle"></i> ${d.error}</div>` : ''}
        ${d.status === 'processed' && d.processed ? `
        <div class="dataset-stats">
          <span>${d.processed.stats.totalRows.toLocaleString()} events</span>
          <span>${d.processed.stats.entityCount} entities</span>
          <span>${d.processed.stats.eventTypeCount} event types</span>
        </div>` : ''}

        <!-- Action buttons — before file list so no scrolling needed -->
        <div class="dataset-actions">
          <button class="btn btn-ghost btn-sm ds-btn-suggest" data-id="${d.id}" title="Auto-suggest column mapping for all files">
            <i class="ti ti-wand"></i> Suggest
          </button>
          ${(!isProcessing && (d.status === 'mapped' || d.status === 'uploaded' || d.status === 'error')) ? `
          <button class="btn btn-primary btn-sm ds-btn-process" data-id="${d.id}">
            <i class="ti ti-cpu"></i> Process
          </button>` : ''}
          ${isProcessing ? `
          <button class="btn btn-ghost btn-sm" disabled>
            <i class="ti ti-loader-2 spin"></i> Processing…
          </button>` : ''}
          ${(!isProcessing && d.status === 'processed') ? `
          <button class="btn btn-secondary btn-sm ds-btn-process" data-id="${d.id}">
            <i class="ti ti-refresh"></i> Reprocess
          </button>
          <button class="btn btn-primary btn-sm ds-btn-activate" data-id="${d.id}">
            <i class="ti ti-${d.id === state.activeDatasetId ? 'check' : 'eye'}"></i> ${d.id === state.activeDatasetId ? 'Active' : 'Use'}
          </button>` : ''}
        </div>

        <!-- Per-file table list -->
        ${(d.tables || []).length > 0 ? `
        <div class="table-list">
          ${d.tables.map(t => `
          <div class="table-row" data-dsid="${d.id}" data-tid="${t.id}">
            <i class="ti ti-file" style="color:var(--text-4);font-size:11px"></i>
            <span class="table-name" title="${t.file_name}">${t.file_name.length > 24 ? t.file_name.slice(0, 12) + '…' + t.file_name.slice(-8) : t.file_name}</span>
            <span class="table-rows">${t.row_count.toLocaleString()}</span>
            <div class="table-actions">
              <button class="icon-btn tbl-settings" data-dsid="${d.id}" data-tid="${t.id}" title="Column mapping &amp; settings">
                <i class="ti ti-settings"></i>
              </button>
              <button class="icon-btn danger-btn tbl-delete" data-dsid="${d.id}" data-tid="${t.id}" title="Remove file">
                <i class="ti ti-x"></i>
              </button>
            </div>
          </div>
          <!-- Per-table settings panel: editable column mapping -->
          <div class="table-settings-panel" id="tbl-settings-${t.id}" style="display:none">
            <div class="table-settings-label">Column Mapping
              <span class="tbl-cm-note">(this file only)</span>
            </div>
            ${_renderTableColMappingEditable(d, t)}
          </div>`).join('')}
        </div>` : ''}
      </div>`;
    }).join('');

    // Bind actions
    container.querySelectorAll('.ds-btn-suggest').forEach(b => b.addEventListener('click', () => {
      DatasetRegistry.suggestTableMappings(b.dataset.id);
      UI.showToast('Mapping suggested for all files — open settings gear to review', 'success');
    }));
    container.querySelectorAll('.ds-btn-process').forEach(b =>
      b.addEventListener('click', () => _processDataset(b.dataset.id)));
    container.querySelectorAll('.ds-btn-activate').forEach(b =>
      b.addEventListener('click', () => setActiveDataset(b.dataset.id)));
    container.querySelectorAll('.ds-btn-delete').forEach(b =>
      b.addEventListener('click', () => {
        if (confirm(`Delete dataset "${DatasetRegistry.get(b.dataset.id)?.name}"?`)) {
          if (state.activeDatasetId === b.dataset.id) setActiveDataset(null);
          DatasetRegistry.remove(b.dataset.id);
        }
      }));

    // Per-table: settings toggle
    container.querySelectorAll('.tbl-settings').forEach(b => b.addEventListener('click', () => {
      const panel = document.getElementById('tbl-settings-' + b.dataset.tid);
      if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    }));
    // Per-table: editable column mapping selects
    container.querySelectorAll('.tbl-cm-select').forEach(sel => {
      sel.addEventListener('change', () => {
        const dsId = sel.dataset.dsid;
        const tid  = sel.dataset.tid;
        const panel   = sel.closest('.table-settings-panel');
        const allSels = panel?.querySelectorAll('.tbl-cm-select') || [];
        const updated = {};
        // Collect all fields from THIS table's panel selects
        allSels.forEach(s => { updated[s.dataset.field] = s.value || null; });
        // Merge with this table's existing mapping (preserve unmapped optional fields)
        const ds = DatasetRegistry.get(dsId);
        const existing = ds?.tables?.find(t => t.id === tid)?.mapping?.fields || {};
        DatasetRegistry.updateTableMapping(dsId, tid, { ...existing, ...updated });
        // Update status indicator
        const statusEl = sel.parentElement?.querySelector('.tbl-cm-status');
        if (statusEl) {
          const tblCols = ds?.tables?.find(t => t.id === tid)?.columns || ds?.columns || [];
          const exists  = sel.value && tblCols.includes(sel.value);
          statusEl.textContent = exists ? '✓' : sel.value ? '✗' : '';
          statusEl.className   = `tbl-cm-status ${exists ? 'tbl-cm-ok' : sel.value ? 'tbl-cm-warn' : ''}`;
        }
      });
    });
    // Per-table: delete
    container.querySelectorAll('.tbl-delete').forEach(b => b.addEventListener('click', () => {
      const ds = DatasetRegistry.get(b.dataset.dsid);
      const t  = ds?.tables?.find(t => t.id === b.dataset.tid);
      if (!t) return;
      if (confirm(`Remove file "${t.file_name}" from dataset? Dataset will need to be reprocessed.`)) {
        DatasetRegistry.removeTable(b.dataset.dsid, b.dataset.tid);
      }
    }));
  }

  /**
   * Render an editable column mapping panel for a table within a dataset.
   * Columns are shared across all tables; changes update the shared mapping.
   */
  function _renderTableColMappingEditable(dataset, table) {
    // Each table has its own mapping and its own column list
    const fields  = table.mapping?.fields || {};
    const tblCols = table.columns || dataset.columns || [];
    const allOpts = ['', ...tblCols].map(c => `<option value="${c}">${c || '— none —'}</option>`).join('');
    const SYSTEM  = [
      { key: 'timestamp',  label: 'Timestamp',   req: true },
      { key: 'entity_id',  label: 'Entity ID',   req: true },
      { key: 'event_type', label: 'Event Type',  req: true },
      { key: 'x',          label: 'X Coord',     req: true },
      { key: 'y',          label: 'Y Coord (2D)', req: true },
      { key: 'session_id', label: 'Session',      req: false },
    ];
    return `<div class="tbl-cm-grid">${
      SYSTEM.map(({ key, label, req }) => {
        const cur    = fields[key] || '';
        const exists = cur && tblCols.includes(cur);
        const opts   = allOpts.replace(`value="${cur}"`, `value="${cur}" selected`);
        return `<div class="tbl-cm-row">
          <span class="tbl-cm-sys">${label}${req ? '<span class="req-star">*</span>' : ''}</span>
          <select class="tbl-cm-select" data-field="${key}" data-dsid="${dataset.id}" data-tid="${table.id}">${opts}</select>
          <span class="tbl-cm-status ${cur ? (exists ? 'tbl-cm-ok' : 'tbl-cm-warn') : ''}">${cur ? (exists ? '✓' : '✗') : ''}</span>
        </div>`;
      }).join('')
    }</div>`;
  }

  async function _processDataset(id) {
    const record = DatasetRegistry.get(id);
    if (!record) return;
    if (state.processingIds.has(id)) return; // prevent double-click

    state.processingIds.add(id);
    _renderDatasetList(DatasetRegistry.getAll()); // update card to show processing state

    try {
      const processed = await ETL.processDataset(record, msg => console.log('[ETL]', msg));
      DatasetRegistry.setProcessed(id, processed);
      state.processingIds.delete(id);
      UI.showToast(`✓ ${processed.stats.totalRows.toLocaleString()} events processed · ${processed.stats.entityCount} entities`, 'success');
      if (!state.activeDatasetId) setActiveDataset(id);
    } catch (err) {
      DatasetRegistry.setError(id, err.message);
      state.processingIds.delete(id);
      UI.showToast('Processing error: ' + err.message, 'error');
      console.error('[App]', err);
    }
  }



  // ── Event Rules ───────────────────────────────────────────
  function _initEventRulesUI() {
    EventRules.onChange(_renderEventRulesList);
  }
  function _onEventRulesChanged(rules) { _renderEventRulesList(rules); }

  // ── Icon picker ───────────────────────────────────────────
  // Curated subset of Tabler icons useful for game/spatial event visualization
  const ICON_PICKER_ICONS = [
    // Movement / position
    'route','compass','map-pin','map-pin-2','navigation','current-location',
    'arrow-up-right','arrows-shuffle','direction','walk',
    // Combat
    'sword','skull','crosshair','target','shield','shield-filled','axe','knife',
    'bolt','flame','medal','swords',
    // Items / loot
    'backpack','diamond','gift','package','box','coin','star','trophy','crown','gem',
    // Health / status
    'heart','heart-broken','medical-cross','bandage','pill','stethoscope',
    // Environment / storm
    'cloud-storm','wind','wave-sine','circle-dot','tornado','snowflake',
    // Players / social
    'user','users','robot','user-circle','run','person',
    // Events / info
    'flag','flag-filled','alert-circle','alert-triangle','info-circle','check-circle',
    'bell','exclamation-mark','circle-x',
    // Map / spatial
    'map','map-2','pin','radar','scan','circle-plus','gps',
    // Misc / useful
    'eye','eye-off','lock','unlock','key','door','home','building',
    'car','plane','anchor','circle','square','triangle','parachute',
  ];

  let _iconPickerOpen = null; // event_type of currently open picker

  function _closeIconPicker() {
    const existing = document.getElementById('icon-picker-popover');
    if (existing) existing.remove();
    _iconPickerOpen = null;
  }

  function _openIconPicker(btn, eventType) {
    if (_iconPickerOpen === eventType) { _closeIconPicker(); return; }
    _closeIconPicker();
    _iconPickerOpen = eventType;

    const popover = document.createElement('div');
    popover.id = 'icon-picker-popover';
    popover.className = 'icon-picker-popover';
    popover.innerHTML = `
      <div class="icon-picker-header">
        <span>Pick an icon</span>
        <button class="icon-picker-close"><i class="ti ti-x"></i></button>
      </div>
      <div class="icon-picker-grid">
        <button class="icon-pick-btn ${!EventRules.getRule(eventType)?.icon ? 'selected' : ''}" data-icon="" title="No icon">
          <span style="font-size:10px;color:var(--text-4)">none</span>
        </button>
        ${ICON_PICKER_ICONS.map(name => `
          <button class="icon-pick-btn ${EventRules.getRule(eventType)?.icon === name ? 'selected' : ''}" data-icon="${name}" title="${name}">
            <i class="ti ti-${name}"></i>
          </button>`).join('')}
      </div>`;

    // Position relative to the trigger button
    document.body.appendChild(popover);
    const rect = btn.getBoundingClientRect();
    popover.style.top  = (rect.bottom + 6 + window.scrollY) + 'px';
    popover.style.left = Math.min(rect.left, window.innerWidth - 260) + 'px';

    popover.querySelector('.icon-picker-close').addEventListener('click', _closeIconPicker);
    popover.querySelectorAll('.icon-pick-btn').forEach(b => {
      b.addEventListener('click', () => {
        const icon = b.dataset.icon || null;
        const r = EventRules.getRule(eventType);
        // Mutual exclusivity: setting an icon clears the custom label
        EventRules.setRule({ ...r, icon, label: icon ? null : r.label });
        _closeIconPicker();
        scheduleRender();
        // Re-render rules list to update the button appearance
        _renderEventRulesList(EventRules.getAllRules());
      });
    });

    // Close on outside click
    setTimeout(() => {
      const outside = (e) => {
        if (!popover.contains(e.target) && e.target !== btn) {
          _closeIconPicker();
          document.removeEventListener('click', outside);
        }
      };
      document.addEventListener('click', outside);
    }, 50);
  }

  function _renderEventRulesList(rules) {
    const container = document.getElementById('event-rules-list');
    const empty     = document.getElementById('event-rules-empty');
    if (!container) return;
    if (!rules.length) {
      if (empty) empty.style.display = 'block';
      container.style.display = 'none';
      return;
    }
    if (empty) empty.style.display = 'none';
    container.style.display = 'block';

    container.innerHTML = rules.map(rule => {
      // Effective canvas marker: custom label takes priority over auto char
      const effectiveMarker = rule.label
        ? rule.label.slice(0, 2)
        : rule.event_type.charAt(0).toUpperCase();
      // If icon is active, label field is blank (mutually exclusive)
      const labelValue = rule.icon ? '' : (rule.label || effectiveMarker);
      return `
      <div class="rule-card">
        <div class="rule-header">
          <div class="rule-header-left">
            <span class="rule-color-dot" style="background:${rule.color}"></span>
            <span class="rule-name">${rule.event_type}</span>
          </div>
          <label class="toggle-switch" style="flex-shrink:0">
            <input type="checkbox" class="rule-visible" data-type="${rule.event_type}" ${rule.visible ? 'checked' : ''}>
            <span class="toggle-track"></span>
          </label>
        </div>
        <div class="rule-controls">
          <input type="color" class="rule-color" data-type="${rule.event_type}" value="${rule.color}" title="Color">
          <!-- Icon picker button: shows current icon or placeholder -->
          <button class="rule-icon-btn ${rule.icon ? 'has-icon' : ''}" data-type="${rule.event_type}"
            title="${rule.icon ? 'Icon: ' + rule.icon + ' (click to change)' : 'Pick icon (clears label)'}">
            ${rule.icon ? `<i class="ti ti-${rule.icon}"></i>` : '<i class="ti ti-mood-empty" style="opacity:0.4"></i>'}
          </button>
          <!-- Marker label: canvas text. Mutually exclusive with icon. Pre-filled with effective char. -->
          <input type="text" class="rule-label-input" data-type="${rule.event_type}"
            value="${labelValue}" placeholder="${effectiveMarker}"
            maxlength="3" title="Canvas marker text — clears icon when set"
            ${rule.icon ? 'style="opacity:0.45"' : ''}>
          <div class="rule-modes">
            ${['path','point','heatmap'].map(m => `
              <button class="mode-btn ${rule.render_modes.includes(m) ? 'active' : ''}"
                data-type="${rule.event_type}" data-mode="${m}">${m}</button>`).join('')}
          </div>
        </div>
        <div class="rule-marker-preview">
          <span class="marker-preview-dot" style="background:${rule.color}">
            ${rule.icon ? `<i class="ti ti-${rule.icon}" style="font-size:9px;color:#fff"></i>` : `<span style="font-size:9px;font-weight:700;color:#fff">${effectiveMarker}</span>`}
          </span>
          <span class="marker-preview-label">Canvas: ${rule.icon ? `icon (ti-${rule.icon})` : `"${effectiveMarker}"`}</span>
        </div>
      </div>`;
    }).join('');

    container.querySelectorAll('.rule-visible').forEach(chk => {
      chk.addEventListener('change', () => {
        const r = EventRules.getRule(chk.dataset.type);
        EventRules.setRule({ ...r, visible: chk.checked });
        scheduleRender();
      });
    });
    container.querySelectorAll('.rule-color').forEach(inp => {
      inp.addEventListener('input', () => {
        const r = EventRules.getRule(inp.dataset.type);
        EventRules.setRule({ ...r, color: inp.value });
        // Update dot color live without full re-render
        const dot = inp.closest('.rule-card')?.querySelector('.rule-color-dot');
        if (dot) dot.style.background = inp.value;
        scheduleRender();
      });
    });
    container.querySelectorAll('.rule-icon-btn').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); _openIconPicker(btn, btn.dataset.type); });
    });
    container.querySelectorAll('.rule-label-input').forEach(inp => {
      inp.addEventListener('input', () => {
        const r = EventRules.getRule(inp.dataset.type);
        const newLabel = inp.value.trim() || null;
        // Mutual exclusivity: typing a label clears the icon
        EventRules.setRule({ ...r, label: newLabel, icon: newLabel ? null : r.icon });
        // Update opacity live to reflect mutual exclusivity state
        inp.style.opacity = '';
        scheduleRender();
        // Update the preview and icon btn without full re-render if possible
        const card = inp.closest('.rule-card');
        if (card) {
          const iconBtn = card.querySelector('.rule-icon-btn');
          if (iconBtn && newLabel) {
            iconBtn.classList.remove('has-icon');
            iconBtn.innerHTML = '<i class="ti ti-mood-empty" style="opacity:0.4"></i>';
          }
        }
      });
    });
    container.querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const r     = EventRules.getRule(btn.dataset.type);
        const mode  = btn.dataset.mode;
        const modes = r.render_modes.includes(mode)
          ? r.render_modes.filter(m => m !== mode)
          : [...r.render_modes, mode];
        EventRules.setRule({ ...r, render_modes: modes });
        btn.classList.toggle('active', modes.includes(mode));
        if (mode === 'heatmap') _regenHeatmap();
        scheduleRender();
      });
    });
  }

  // ── Maps Tab (with inline calibration) ───────────────────
  function _initMapsUI() {
    document.getElementById('btn-upload-map')?.addEventListener('click', () =>
      document.getElementById('input-map-image')?.click());
    document.getElementById('input-map-image')?.addEventListener('change', async e => {
      const files = e.target.files;
      if (!files?.length) return;
      try {
        const record = await MapRegistry.add(files[0]);
        UI.showToast(`✓ Map "${record.name}" loaded (${record.width}×${record.height}px)`, 'success');
        if (!state.activeMapId) setActiveMap(record.id);
      } catch (err) {
        UI.showToast('Map load error: ' + err.message, 'error');
      }
    });

    // Calibration point confirm/cancel (shared panel at bottom of Maps tab)
    document.getElementById('btn-add-refpoint')?.addEventListener('click', _addRefPoint);
    document.getElementById('btn-cancel-refpoint')?.addEventListener('click', () => {
      const mapId = _getOpenCalibMapId();
      if (mapId) {
        const cd = _calibFor(mapId);
        cd.pending = null;
        document.getElementById('calib-point-input').style.display = 'none';
        _renderCalibOverlay(mapId);
      }
    });
  }

  function _onMapsChanged(maps) {
    _renderMapList(maps);
    _syncMapSelectors(maps);
  }

  function _renderMapList(maps) {
    const container = document.getElementById('map-list');
    if (!container) return;
    if (maps.length === 0) {
      container.innerHTML = '<p class="empty-hint">No maps loaded yet.</p>';
      return;
    }
    container.innerHTML = maps.map(m => `
      <div class="map-card ${m.id === state.activeMapId ? 'active' : ''}" data-id="${m.id}">
        <div class="map-preview" style="background-image:url('${m.image_url}')"></div>
        <div class="map-info">
          <div class="map-name">${m.name}${m._isPreset ? ' <span class="preset-badge">preset</span>' : ''}</div>
          <div class="map-meta">${m.width}×${m.height}px
            · <span class="calib-status-${m.calibration_status}">${m.calibration_status}</span>
          </div>
        </div>
        <div class="map-actions">
          <button class="btn btn-secondary btn-sm map-btn-use" data-id="${m.id}">
            <i class="ti ti-eye"></i> Use
          </button>
          <button class="btn btn-secondary btn-sm map-btn-configure" data-id="${m.id}">
            <i class="ti ti-crosshair"></i> ${_calibFor(m.id).open ? 'Close' : 'Configure'}
          </button>
          <button class="icon-btn danger-btn map-btn-del" data-id="${m.id}" title="Delete map">
            <i class="ti ti-trash"></i>
          </button>
        </div>

        <!-- Inline calibration panel -->
        <div class="calib-inline" id="calib-panel-${m.id}" style="display:${_calibFor(m.id).open ? 'block' : 'none'}">
          <div class="calib-inline-section">
            <div class="calib-inline-title">
              <i class="ti ti-map-pin-2"></i> Reference Points
              <span style="color:var(--text-4);font-size:10px;margin-left:4px">Click map canvas to place</span>
            </div>
            <div id="refpoints-${m.id}" class="refpoints-list">
              ${_renderRefPointsHTML(m.id)}
            </div>
            <div style="display:flex;gap:6px;margin-top:6px">
              ${_calibFor(m.id).refPoints.length >= 2 ? `
              <button class="btn btn-secondary btn-sm calib-solve" data-mapid="${m.id}" style="flex:1">
                <i class="ti ti-calculator"></i> Solve from Points
              </button>` : ''}
              <button class="btn btn-ghost btn-sm calib-clear-pts" data-mapid="${m.id}">
                <i class="ti ti-x"></i> Clear
              </button>
            </div>
          </div>

          <div class="calib-inline-section">
            <div class="calib-inline-title"><i class="ti ti-sliders"></i> Coordinate Transform</div>
            <div class="calib-grid">
              <label>Origin X <input type="number" class="calib-input-sm" id="ci-ox-${m.id}" value="${m.calibration?.origin_x ?? 0}" step="any"></label>
              <label>Origin Y <input type="number" class="calib-input-sm" id="ci-oy-${m.id}" value="${m.calibration?.origin_y ?? 0}" step="any"></label>
              <label>Scale X  <input type="number" class="calib-input-sm" id="ci-sx-${m.id}" value="${m.calibration?.scale_x ?? 1}" step="any"></label>
              <label>Scale Y  <input type="number" class="calib-input-sm" id="ci-sy-${m.id}" value="${m.calibration?.scale_y ?? 1}" step="any"></label>
              <label class="calib-check"><input type="checkbox" id="ci-ix-${m.id}" ${m.calibration?.invert_x ? 'checked' : ''}> Invert X</label>
              <label class="calib-check"><input type="checkbox" id="ci-iy-${m.id}" ${m.calibration?.invert_y ? 'checked' : ''}> Invert Y</label>
              <label style="grid-column:span 2">Axis Map
                <select class="calib-input-sm" id="ci-am-${m.id}" style="width:100%">
                  <option value="xy" ${(m.calibration?.axis_map || 'xy') === 'xy' ? 'selected' : ''}>X / Y</option>
                  <option value="xz" ${m.calibration?.axis_map === 'xz' ? 'selected' : ''}>X / Z</option>
                </select>
              </label>
            </div>
            <button class="btn btn-primary full-width calib-apply" data-mapid="${m.id}" style="margin-top:8px">
              <i class="ti ti-check"></i> Apply Calibration
            </button>
          </div>
        </div>
      </div>`).join('');

    // Bind map actions
    container.querySelectorAll('.map-btn-use').forEach(b =>
      b.addEventListener('click', () => setActiveMap(b.dataset.id)));
    container.querySelectorAll('.map-btn-configure').forEach(b =>
      b.addEventListener('click', () => _toggleCalibPanel(b.dataset.id)));
    container.querySelectorAll('.map-btn-del').forEach(b =>
      b.addEventListener('click', () => {
        if (confirm(`Delete map "${MapRegistry.get(b.dataset.id)?.name}"?`)) {
          if (state.activeMapId === b.dataset.id) setActiveMap(null);
          MapRegistry.remove(b.dataset.id);
        }
      }));

    // Inline calibration: solve / clear / apply
    container.querySelectorAll('.calib-solve').forEach(b =>
      b.addEventListener('click', () => _solveCalib(b.dataset.mapid)));
    container.querySelectorAll('.calib-clear-pts').forEach(b =>
      b.addEventListener('click', () => {
        const cd = _calibFor(b.dataset.mapid);
        cd.refPoints = []; cd.pending = null;
        document.getElementById('calib-point-input').style.display = 'none';
        _renderMapList(maps); // re-render to update refpoints list
        _renderCalibOverlay(b.dataset.mapid);
      }));
    container.querySelectorAll('.calib-apply').forEach(b =>
      b.addEventListener('click', () => _applyCalib(b.dataset.mapid)));
  }

  // ── Per-map calibration state helpers ────────────────────
  function _calibFor(mapId) {
    if (!state.calibData[mapId]) {
      state.calibData[mapId] = { refPoints: [], pending: null, open: false };
    }
    return state.calibData[mapId];
  }

  function _getOpenCalibMapId() {
    return Object.keys(state.calibData).find(id => state.calibData[id].open) || null;
  }

  function _toggleCalibPanel(mapId) {
    const cd = _calibFor(mapId);
    cd.open = !cd.open;
    // If opening, load this map in canvas so clicks register
    if (cd.open) {
      const map = MapRegistry.get(mapId);
      if (map) Renderer.loadMap(map);
      Renderer.setCalibrationMode(true, (pt) => _onCalibCanvasClick(mapId, pt));
    } else {
      // Close any open calibration mode if no other map panel is open
      const anyOpen = _getOpenCalibMapId();
      if (!anyOpen) Renderer.setCalibrationMode(false, null);
    }
    // Re-render map list to update button label and panel visibility
    _renderMapList(MapRegistry.getAll());
  }

  function _renderRefPointsHTML(mapId) {
    const cd = _calibFor(mapId);
    if (cd.refPoints.length === 0) {
      return '<div class="refpoints-empty">Click on the map canvas to add reference points.</div>';
    }
    return cd.refPoints.map((pt, i) => `
      <div class="refpoint-row">
        <span class="refpoint-index">${i + 1}</span>
        <span class="refpoint-data">px(${Math.round(pt.px)},${Math.round(pt.py)}) → world(${pt.wx.toFixed(1)},${pt.wy.toFixed(1)})</span>
        <button class="icon-btn danger-btn refpoint-del" data-mapid="${mapId}" data-idx="${i}"><i class="ti ti-x"></i></button>
      </div>`).join('');
  }

  function _onCalibCanvasClick(mapId, { px, py }) {
    const cd = _calibFor(mapId);
    cd.pending = { px, py };
    // Show the shared point-input panel
    const panel = document.getElementById('calib-point-input');
    if (panel) {
      panel.style.display = 'block';
      document.getElementById('calib-point-px').textContent = `px=(${Math.round(px)}, ${Math.round(py)})`;
      document.getElementById('calib-wx').value = '';
      document.getElementById('calib-wy').value = '';
      document.getElementById('calib-wx')?.focus();
    }
    _renderCalibOverlay(mapId);
  }

  function _addRefPoint() {
    const mapId = _getOpenCalibMapId();
    if (!mapId) return;
    const cd = _calibFor(mapId);
    if (!cd.pending) return;
    const wx = parseFloat(document.getElementById('calib-wx')?.value);
    const wy = parseFloat(document.getElementById('calib-wy')?.value);
    if (!isFinite(wx) || !isFinite(wy)) { UI.showToast('Enter valid world X and Y', 'error'); return; }
    cd.refPoints.push({ ...cd.pending, wx, wy });
    cd.pending = null;
    document.getElementById('calib-point-input').style.display = 'none';
    // Update refpoints list in card without full re-render
    const listEl = document.getElementById(`refpoints-${mapId}`);
    if (listEl) listEl.innerHTML = _renderRefPointsHTML(mapId);
    _bindRefpointDeletes(mapId);
    _renderCalibOverlay(mapId);
  }

  function _bindRefpointDeletes(mapId) {
    const listEl = document.getElementById(`refpoints-${mapId}`);
    if (!listEl) return;
    listEl.querySelectorAll('.refpoint-del').forEach(b => {
      b.addEventListener('click', () => {
        const cd = _calibFor(b.dataset.mapid);
        cd.refPoints.splice(Number(b.dataset.idx), 1);
        listEl.innerHTML = _renderRefPointsHTML(b.dataset.mapid);
        _bindRefpointDeletes(b.dataset.mapid);
        _renderCalibOverlay(b.dataset.mapid);
      });
    });
  }

  function _solveCalib(mapId) {
    const map = MapRegistry.get(mapId);
    const cd  = _calibFor(mapId);
    if (!map || cd.refPoints.length < 2) return;
    const solved = Calibration.solveFromRefPoints(cd.refPoints, map.width, map.height);
    if (!solved) { UI.showToast('Could not solve — points may be collinear', 'error'); return; }
    // Fill inputs
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = typeof val === 'number' ? val.toFixed(6) : val; };
    const chk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = val; };
    set(`ci-ox-${mapId}`, solved.origin_x);
    set(`ci-oy-${mapId}`, solved.origin_y);
    set(`ci-sx-${mapId}`, solved.scale_x);
    set(`ci-sy-${mapId}`, solved.scale_y);
    chk(`ci-ix-${mapId}`, solved.invert_x);
    chk(`ci-iy-${mapId}`, solved.invert_y);
    UI.showToast('Calibration solved from reference points ✓', 'success');
  }

  function _applyCalib(mapId) {
    const map = MapRegistry.get(mapId);
    if (!map) return;
    const get = (id) => document.getElementById(id);
    const cal = Calibration.buildFromInputs({
      origin_x: get(`ci-ox-${mapId}`)?.value,
      origin_y: get(`ci-oy-${mapId}`)?.value,
      scale_x:  get(`ci-sx-${mapId}`)?.value,
      scale_y:  get(`ci-sy-${mapId}`)?.value,
      invert_x: get(`ci-ix-${mapId}`)?.checked,
      invert_y: get(`ci-iy-${mapId}`)?.checked,
      axis_map: get(`ci-am-${mapId}`)?.value || 'xy',
      img_w:    map.width,
      img_h:    map.height,
    });
    if (!Calibration.isValid(cal)) { UI.showToast('Invalid calibration: scale must be > 0', 'error'); return; }
    cal.ref_points = [...(_calibFor(mapId).refPoints)];
    MapRegistry.setCalibration(mapId, cal);
    UI.showToast(`✓ Calibration applied to "${map.name}"`, 'success');
    if (state.activeMapId === mapId) {
      // Calibration changes pixel positions — must bust both caches
      _invalidateMapFilterCache();
      _invalidateEventsCache();
      _regenHeatmap();
      scheduleRender();
    }
  }

  function _renderCalibOverlay(mapId) {
    const map = MapRegistry.get(mapId);
    if (!map) return;
    if (state.activeMapId !== mapId) Renderer.loadMap(map);
    const cd = _calibFor(mapId);
    requestAnimationFrame(() => {
      _doRender();
      Renderer.drawCalibrationOverlay(cd.refPoints, cd.pending);
    });
  }

  function _syncMapSelectors(maps) {
    const el = document.getElementById('map-selector');
    if (!el) return;
    const cur = el.value;
    el.innerHTML = '<option value="">— map —</option>' +
      maps.map(m => `<option value="${m.id}">${m.name}${m.calibration_status === 'calibrated' ? '' : ' (uncalibrated)'}</option>`).join('');
    if (cur && maps.find(m => m.id === cur)) el.value = cur;
    else if (state.activeMapId) el.value = state.activeMapId;
  }

  // ── Visualization / Layout sub-tab ───────────────────���────
  function _initVisualizationUI() {
    document.querySelectorAll('.layer-toggle').forEach(toggle => {
      toggle.addEventListener('change', () => {
        state.layers[toggle.dataset.layer] = toggle.checked;
        if (toggle.dataset.layer === 'heatmap') _regenHeatmap();
        else scheduleRender();
      });
    });
    // Sync initial toggle states from state
    _syncLayerToggles();

    _initMapIdDropdown();

    document.getElementById('btn-apply-viz-filters')?.addEventListener('click', _applyVizFilters);

    // Session dropdown toggle
    const _sdTrigger = document.getElementById('session-dropdown-trigger');
    const _sdPanel   = document.getElementById('session-dropdown-panel');
    _sdTrigger?.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = _sdPanel.classList.toggle('open');
      _sdTrigger.classList.toggle('open', open);
    });
    document.addEventListener('click', (e) => {
      if (!document.getElementById('session-dropdown')?.contains(e.target)) {
        _sdPanel?.classList.remove('open');
        _sdTrigger?.classList.remove('open');
      }
    });
    // Select All checkbox
    document.getElementById('session-select-all')?.addEventListener('change', (e) => {
      document.querySelectorAll('#session-dropdown-list input[type="checkbox"]')
        .forEach(cb => { cb.checked = e.target.checked; });
      _updateSessionDropdownLabel();
    });

    // Session Filter: clear = select all
    document.getElementById('btn-clear-session-filter')?.addEventListener('click', () => {
      document.querySelectorAll('#session-dropdown-list input[type="checkbox"]')
        .forEach(cb => { cb.checked = true; });
      const allCb = document.getElementById('session-select-all');
      if (allCb) allCb.checked = true;
      _updateSessionDropdownLabel();
      Filters.setSessions([]);
      scheduleRender();
    });

    // Date Range: clear only date inputs
    document.getElementById('btn-clear-date-range')?.addEventListener('click', () => {
      const fromEl = document.getElementById('filter-date-from');
      const toEl   = document.getElementById('filter-date-to');
      if (fromEl) fromEl.value = '';
      if (toEl)   toEl.value   = '';
      const hint = document.getElementById('date-range-hint');
      if (hint) hint.style.display = 'none';
      // Restore full session list since date filter is gone
      const ds = state.activeDatasetId ? DatasetRegistry.get(state.activeDatasetId) : null;
      if (ds?.processed) _populateSessionSelector(Array.from(ds.processed.sessions.keys()));
      Filters.setDateRange(null, null);
      scheduleRender();
    });

    // Map ID Filter: reset to default (current map auto = no manual overrides)
    document.getElementById('btn-default-mapid')?.addEventListener('click', () => {
      _setCheckedMapIds([]);
      _updateMapIdToggleLabel();
      state.activeMapIds = [];
      _invalidateEventsCache();
      scheduleRender();
    });

    // Date range inputs: update session list preview live as user types
    document.getElementById('filter-date-from')?.addEventListener('change', _onDateRangeInput);
    document.getElementById('filter-date-to')?.addEventListener('change', _onDateRangeInput);

    const pathSlider = document.getElementById('path-thickness');
    pathSlider?.addEventListener('input', () => {
      const v = Number(pathSlider.value);
      document.getElementById('path-thickness-val').textContent = v + 'px';
      state.settings.pathThickness = v;
      scheduleRender();
    });
    const heatSlider = document.getElementById('heatmap-intensity');
    heatSlider?.addEventListener('input', () => {
      const v = Number(heatSlider.value) / 100;
      document.getElementById('heatmap-intensity-val').textContent = Math.round(v * 100) + '%';
      state.settings.heatmapIntensity = v;
      _regenHeatmap();
    });
  }

  function _applyVizFilters() {
    // Date range
    const fromMs = _readDateInput('filter-date-from');
    const toMs   = _readDateInput('filter-date-to');
    Filters.setDateRange(fromMs, toMs);

    // Sessions — empty array = all sessions (no filter)
    const allCbs   = document.querySelectorAll('#session-dropdown-list input[type="checkbox"]');
    const allCheck = document.getElementById('session-select-all');
    const allSelected = allCheck?.checked || Array.from(allCbs).every(cb => cb.checked);
    const selected = allSelected ? [] : Array.from(allCbs).filter(cb => cb.checked).map(cb => cb.value);
    Filters.setSessions(selected);

    // Map IDs from custom dropdown
    state.activeMapIds = _getCheckedMapIds();
    _invalidateEventsCache();
    scheduleRender();
  }

  /** Read a datetime-local input and return epoch ms, or null if empty/invalid. */
  function _readDateInput(id) {
    const el = document.getElementById(id);
    if (!el || !el.value) return null;
    const ms = new Date(el.value).getTime();
    return isFinite(ms) ? ms : null;
  }

  /**
   * Called live when either date input changes.
   * Filters the session list to only show sessions overlapping the date range.
   */
  function _onDateRangeInput() {
    const fromMs = _readDateInput('filter-date-from');
    const toMs   = _readDateInput('filter-date-to');
    const ds     = state.activeDatasetId ? DatasetRegistry.get(state.activeDatasetId) : null;
    const hint   = document.getElementById('date-range-hint');

    if (!ds?.processed) return;

    const allSessions = Array.from(ds.processed.sessions.values());

    // A session overlaps the range if it starts before dateTo AND ends after dateFrom
    const matching = allSessions.filter(s => {
      if (fromMs != null && s.maxTs < fromMs) return false;
      if (toMs   != null && s.minTs > toMs)   return false;
      return true;
    });

    const matchingIds = matching.map(s => s.session_id);
    _populateSessionSelector(matchingIds);

    // Show hint text
    if (hint) {
      const hasFilter = fromMs != null || toMs != null;
      if (hasFilter) {
        hint.textContent = `${matching.length} of ${allSessions.length} sessions match this range.`;
        hint.style.display = 'block';
      } else {
        hint.style.display = 'none';
      }
    }
  }

  // ── Map ID custom dropdown ─────────────────────────────────
  let _mapIdDropdownOpen = false;

  function _initMapIdDropdown() {
    const toggle = document.getElementById('mapid-toggle');
    const panel  = document.getElementById('mapid-panel');
    const clearBtn = document.getElementById('mapid-clear-btn');
    if (!toggle || !panel) return;

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      _mapIdDropdownOpen = !_mapIdDropdownOpen;
      toggle.classList.toggle('open', _mapIdDropdownOpen);
      panel.classList.toggle('open', _mapIdDropdownOpen);
    });

    clearBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      _setCheckedMapIds([]);
      _updateMapIdToggleLabel();
      // Auto-apply immediately on clear
      state.activeMapIds = [];
      scheduleRender();
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
      const dropdown = document.getElementById('mapid-dropdown');
      if (dropdown && !dropdown.contains(e.target) && _mapIdDropdownOpen) {
        _mapIdDropdownOpen = false;
        toggle.classList.remove('open');
        panel.classList.remove('open');
        // Auto-apply when closing dropdown
        state.activeMapIds = _getCheckedMapIds();
        scheduleRender();
      }
    });
  }

  function _getCheckedMapIds() {
    const opts = document.querySelectorAll('.mapid-checkbox:checked');
    return Array.from(opts).map(cb => cb.value);
  }

  function _setCheckedMapIds(ids) {
    document.querySelectorAll('.mapid-checkbox').forEach(cb => {
      cb.checked = ids.includes(cb.value);
    });
    _updateMapIdToggleLabel();
  }

  function _updateMapIdToggleLabel() {
    const label   = document.getElementById('mapid-toggle-label');
    if (!label) return;
    const checked = _getCheckedMapIds();
    if (checked.length === 0) {
      label.textContent = 'Current map (auto)';
    } else if (checked.length === 1) {
      label.textContent = checked[0];
    } else {
      label.textContent = `${checked.length} maps selected`;
    }
  }

  function _populateMapIdSelector(mapIds) {
    const group       = document.getElementById('map-id-filter-group');
    const empty       = document.getElementById('map-id-filter-empty');
    const placeholder = document.getElementById('map-id-filter-placeholder');
    const options     = document.getElementById('mapid-options');
    if (!options) return;

    if (!mapIds || mapIds.size === 0) {
      if (group)       group.style.display = 'none';
      if (empty)       empty.style.display = 'block';
      if (placeholder) placeholder.style.display = 'none';
      return;
    }
    if (group)       group.style.display = 'block';
    if (empty)       empty.style.display = 'none';
    if (placeholder) placeholder.style.display = 'none';

    // Determine which IDs match the active map (pre-check these)
    const activeMap    = state.activeMapId ? MapRegistry.get(state.activeMapId) : null;
    const mapNameLower = activeMap?.name?.toLowerCase() || '';
    const isCurrentMap = (id) =>
      mapNameLower && (id.toLowerCase() === mapNameLower ||
                       id.toLowerCase().includes(mapNameLower) ||
                       mapNameLower.includes(id.toLowerCase()));

    options.innerHTML = [...mapIds].sort().map(id => {
      const isCurrent = isCurrentMap(id);
      return `<label class="mapid-option ${isCurrent ? 'is-current' : ''}" data-id="${id}">
        <input type="checkbox" class="mapid-checkbox" value="${id}" ${isCurrent ? 'checked' : ''}>
        <span class="mapid-option-label">${id}</span>
      </label>`;
    }).join('');

    // Wire up checkbox changes → update label + auto-apply
    options.querySelectorAll('.mapid-checkbox').forEach(cb => {
      cb.addEventListener('change', () => {
        _updateMapIdToggleLabel();
        state.activeMapIds = _getCheckedMapIds();
        _invalidateMapFilterCache();
        _invalidateEventsCache();
        scheduleRender();
      });
    });

    _updateMapIdToggleLabel();
    _checkMapMismatch(mapIds);
  }

  function _checkMapMismatch(mapIds) {
    const warning = document.getElementById('map-mismatch-warning');
    const msg     = document.getElementById('map-mismatch-msg');
    if (!warning || !mapIds || mapIds.size === 0) { if (warning) warning.style.display = 'none'; return; }
    const activeMap = state.activeMapId ? MapRegistry.get(state.activeMapId) : null;
    if (!activeMap) { warning.style.display = 'none'; return; }
    const mapName = activeMap.name || '';
    const matchingIds = [...mapIds].filter(id =>
      id && mapName && (id.toLowerCase().includes(mapName.toLowerCase()) || mapName.toLowerCase().includes(id.toLowerCase()))
    );
    const otherIds = [...mapIds].filter(id => !matchingIds.includes(id));
    if (otherIds.length > 0) {
      warning.style.display = 'flex';
      if (matchingIds.length > 0) {
        msg.textContent = `Data has ${otherIds.length} other map(s): [${otherIds.join(', ')}]. Showing "${mapName}" only. Use dropdown to include others.`;
      } else {
        msg.textContent = `No "${mapName}" events found. Data has: [${[...mapIds].join(', ')}]. Use dropdown to select a map.`;
      }
    } else {
      warning.style.display = 'none';
    }
  }
  function _populateSessionSelector(sessionIds) {
    const list = document.getElementById('session-dropdown-list');
    const allCb = document.getElementById('session-select-all');
    if (!list) return;
    if (sessionIds.length === 0) {
      list.innerHTML = '<span style="color:var(--text-4);font-size:11px;padding:6px 8px;display:block">— no sessions —</span>';
      if (allCb) allCb.checked = true;
      _updateSessionDropdownLabel();
      return;
    }
    list.innerHTML = sessionIds.map((id, i) =>
      `<label class="session-dropdown-item">
        <input type="checkbox" value="${id}" checked>
        <span>Session ${i + 1}: ${id.slice(0, 8)}…</span>
      </label>`
    ).join('');
    if (allCb) allCb.checked = true;
    // Re-attach per-item change listeners
    list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', _onSessionItemChange);
    });
    _updateSessionDropdownLabel();
  }

  function _onSessionItemChange() {
    const allCbs = document.querySelectorAll('#session-dropdown-list input[type="checkbox"]');
    const allCb  = document.getElementById('session-select-all');
    if (allCb) allCb.checked = Array.from(allCbs).every(cb => cb.checked);
    _updateSessionDropdownLabel();
  }

  function _updateSessionDropdownLabel() {
    const label  = document.getElementById('session-dropdown-label');
    const allCbs = document.querySelectorAll('#session-dropdown-list input[type="checkbox"]');
    const allCb  = document.getElementById('session-select-all');
    if (!label) return;
    const total    = allCbs.length;
    const checked  = Array.from(allCbs).filter(cb => cb.checked).length;
    if (total === 0)           label.textContent = 'No sessions';
    else if (checked === total || allCb?.checked) label.textContent = 'All sessions';
    else if (checked === 0)    label.textContent = 'None selected';
    else                       label.textContent = `${checked} of ${total} selected`;
  }
  function _populateEventTypeFilter(eventTypes) {
    const container = document.getElementById('event-type-filter-group');
    if (!container) return;
    if (eventTypes.length === 0) {
      container.innerHTML = '<p style="color:var(--text-4);font-size:11px">Load a dataset to see event types.</p>';
      return;
    }
    container.innerHTML = eventTypes.map(t => {
      const rule = EventRules.getRule(t);
      return `<label class="layer-item">
        <span class="layer-label">
          <span class="layer-dot" style="background:${rule?.color||'#aaa'}"></span>${t}
        </span>
        <label class="toggle-switch">
          <input type="checkbox" class="event-type-toggle" data-type="${t}" checked>
          <span class="toggle-track"></span>
        </label>
      </label>`;
    }).join('');
    container.querySelectorAll('.event-type-toggle').forEach(chk => {
      chk.addEventListener('change', () => {
        const rule = EventRules.getRule(chk.dataset.type);
        EventRules.setRule({ ...rule, visible: chk.checked });
        scheduleRender();
      });
    });
  }

  // ── Saved Views ───────────────────────────────────────────
  function _initViewsUI() {
    document.getElementById('btn-save-view')?.addEventListener('click', () => {
      const name = prompt('View name:', 'My View ' + new Date().toLocaleTimeString());
      if (name) { _saveView(name); UI.showToast('View saved!', 'success'); }
    });
  }

  function _saveView(name) {
    const view = {
      id: Date.now().toString(), name,
      createdAt:     new Date().toISOString(),
      datasetId:     state.activeDatasetId,
      mapId:         state.activeMapId,
      sessionIds:    [...state.activeSessionIds],
      layers:        { ...state.layers },
      settings:      { ...state.settings },
      playbackState: Playback.getState(),
      eventRules:    EventRules.getAllRules(),
    };
    state.savedViews.push(view);
    _persistViews();
    UI.renderSavedViews(state.savedViews);
  }

  function _loadView(viewId) {
    const view = state.savedViews.find(v => v.id === viewId);
    if (!view) return;

    // Restore layers, settings, event rules — always safe
    state.layers   = { ...state.layers, ...view.layers };
    state.settings = { ...state.settings, ...view.settings };
    if (view.eventRules) view.eventRules.forEach(r => EventRules.setRule(r));

    // Only switch dataset/map if the IDs still exist in current session registries.
    // IDs are session-specific (Date.now()) so old IDs from a previous session won't resolve.
    // Don't wipe the current active dataset/map if the view's IDs are stale.
    let datasetSwitched = false;
    if (view.datasetId && DatasetRegistry.get(view.datasetId)) {
      setActiveDataset(view.datasetId);
      state.activeSessionIds = [...(view.sessionIds || [])];
      datasetSwitched = true;
    }
    if (view.mapId && MapRegistry.get(view.mapId)) {
      setActiveMap(view.mapId);
    }

    if (!datasetSwitched) {
      // Restore session filter against current dataset if available
      state.activeSessionIds = [...(view.sessionIds || [])];
    }

    _invalidateEventsCache();
    _syncLayerToggles();
    UI.showToast(`View "${view.name}" restored.`, 'success');
    scheduleRender();
  }

  function _deleteView(viewId) {
    state.savedViews = state.savedViews.filter(v => v.id !== viewId);
    _persistViews();
    UI.renderSavedViews(state.savedViews);
  }

  function _loadSavedViews() {
    try { state.savedViews = JSON.parse(localStorage.getItem('astro_views') || '[]'); } catch (_) { state.savedViews = []; }
  }
  function _persistViews() {
    try { localStorage.setItem('astro_views', JSON.stringify(state.savedViews)); } catch (_) {}
  }

  // ── Top Bar ───────────────────────────────────────────────
  function _initTopBar() {
    document.getElementById('map-selector')?.addEventListener('change', e => setActiveMap(e.target.value || null));
    document.getElementById('view-selector')?.addEventListener('change', e => {
      if (e.target.value) _loadView(e.target.value);
    });
    document.getElementById('btn-save-view-top')?.addEventListener('click', () => {
      const name = prompt('View name:', 'My View ' + new Date().toLocaleTimeString());
      if (name) { _saveView(name); UI.showToast('View saved!', 'success'); }
    });
    document.getElementById('btn-reset-view-top')?.addEventListener('click', () => Renderer.resetView());

    // Collapse / expand top bar
    const topBar = document.getElementById('top-bar');
    const pill   = document.getElementById('topbar-pill');
    document.getElementById('btn-topbar-collapse')?.addEventListener('click', () => {
      topBar.style.display = 'none';
      if (pill) pill.style.display = 'block';
    });
    document.getElementById('btn-topbar-expand')?.addEventListener('click', () => {
      topBar.style.display = '';
      if (pill) pill.style.display = 'none';
    });
  }

  // ── Playback Bar ──────────────────────────────────────────
  function _initPlaybackBar() {
    document.getElementById('btn-play')?.addEventListener('click',     () => { Playback.play();        _updatePlaybackUI(); });
    document.getElementById('btn-pause')?.addEventListener('click',    () => { Playback.pause();       _updatePlaybackUI(); });
    document.getElementById('btn-stop')?.addEventListener('click',     () => { Playback.stop();        _updatePlaybackUI(); });
    document.getElementById('btn-step-fwd')?.addEventListener('click', () => { Playback.stepForward(); _updatePlaybackUI(); });
    document.getElementById('btn-step-bwd')?.addEventListener('click', () => { Playback.stepBackward(); _updatePlaybackUI(); });

    document.querySelectorAll('.speed-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const speed = parseFloat(btn.dataset.speed);
        Playback.setSpeed(speed);
        state.settings.playbackSpeed = speed;
        document.querySelectorAll('.speed-btn').forEach(b => b.classList.toggle('active', parseFloat(b.dataset.speed) === speed));
      });
    });

    const scrubber = document.getElementById('timeline-scrubber');
    scrubber?.addEventListener('input', () => {
      const pb    = Playback.getState();
      const range = pb.windowEnd - pb.windowStart;
      const ts    = pb.windowStart + (parseFloat(scrubber.value) / 1000) * range;
      Playback.scrubTo(ts);
    });
  }

  // Lightweight scrubber-only update called on every 'frame' event (60fps)
  const _scrubberEl  = () => document.getElementById('timeline-scrubber');
  const _curEl       = () => document.getElementById('playback-current');
  function _updateScrubber() {
    const pb = Playback.getState();
    const scrubber = _scrubberEl();
    if (scrubber && pb.maxTs > 0) {
      const range = pb.windowEnd - pb.windowStart;
      const prog  = range > 0 ? (pb.currentTs - pb.windowStart) / range : 0;
      scrubber.value = Math.round(Math.max(0, Math.min(1, prog)) * 1000);
    }
    const curEl = _curEl();
    if (curEl) curEl.textContent = Playback.formatMs(pb.currentTs);
  }

  // Full UI update for play/pause/stop/end state changes
  function _updatePlaybackUI() {
    const pb = Playback.getState();
    const playBtn  = document.getElementById('btn-play');
    const pauseBtn = document.getElementById('btn-pause');
    if (playBtn)  playBtn.style.display  = pb.playing ? 'none'  : 'flex';
    if (pauseBtn) pauseBtn.style.display = pb.playing ? 'flex'  : 'none';

    const statusEl = document.getElementById('playback-status');
    if (statusEl) statusEl.textContent = { idle:'', playing:'▶', paused:'⏸', ended:'⏹' }[pb.status] || '';

    _updateScrubber();
    const durEl = document.getElementById('playback-duration');
    if (durEl) durEl.textContent = Playback.formatMs((pb.windowEnd || 0) - (pb.windowStart || 0));
  }

  // ── Assistant ─────────────────────────────────────────────
  function _initAssistant() {
    // Chat welcome buttons
    document.getElementById('btn-chat-load-sample')?.addEventListener('click', async () => {
      // Hide the welcome panel immediately — the bubble is the UI from here on
      const panel = document.getElementById('astro-welcome-panel');
      if (panel) panel.style.display = 'none';
      const bubble = _createLoadingBubble('Fetching sample data…');
      await _loadSampleData(true, (msg, pct) => bubble.setText(msg, pct));
      bubble.setDone('Sample data loaded and processed! You can now explore your data.');
    });
    document.getElementById('btn-chat-upload')?.addEventListener('click', () => {
      _switchTab('data');
    });

    Assistant.init(actions => {
      for (const action of actions) {
        switch (action.type) {
          case 'layer':
            state.layers[action.key] = action.value;
            _syncLayerToggles();
            if (action.key === 'heatmap') _regenHeatmap(); else scheduleRender();
            break;
          case 'playback':
            if (action.action === 'play')  Playback.play();
            if (action.action === 'pause') Playback.pause();
            if (action.action === 'stop')  Playback.stop();
            _updatePlaybackUI();
            break;
          case 'speed':   Playback.setSpeed(action.value); break;
          case 'resetView': Renderer.resetView(); break;
        }
      }
    });

    const chatInput = document.getElementById('chat-input');
    const chatSend  = document.getElementById('chat-send');
    const doSend = () => {
      const text = chatInput?.value?.trim();
      if (!text) return;
      chatInput.value = '';
      const { response } = Assistant.processInput(text);
      UI.appendChatMessage('user', text);
      UI.appendChatMessage('assistant', response);
    };
    chatSend?.addEventListener('click', doSend);
    chatInput?.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } });
    document.querySelectorAll('.suggestion-chip').forEach(chip =>
      chip.addEventListener('click', () => { if (chatInput) chatInput.value = chip.textContent; doSend(); }));
  }

  // ── Utilities ─────────────────────────────────────────────
  function _syncLayerToggles() {
    for (const [key, val] of Object.entries(state.layers)) {
      const toggle = document.querySelector(`.layer-toggle[data-layer="${key}"]`);
      if (toggle) toggle.checked = val;
    }
  }

  return { init, _loadView, _deleteView };
})();


// ── UI helpers module ─────────────────────────────────────────
window.UI = (() => {

  function appendChatMessage(role, text) {
    const container = document.getElementById('chat-messages');
    if (!container) return;
    const div = document.createElement('div');
    div.className = `chat-message chat-${role}`;
    div.innerHTML = `<div class="chat-bubble">${text.replace(/\n/g, '<br>').replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')}</div>`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  function renderSavedViews(views) {
    const container = document.getElementById('saved-views-list');
    if (!container) return;
    if (!views?.length) {
      container.innerHTML = '<p class="empty-hint">No saved views yet.</p>';
      // Update view selector
      _syncViewSelector(views || []);
      return;
    }
    container.innerHTML = views.map(v => `
      <div class="view-card">
        <div class="view-info">
          <div class="view-name">${v.name}</div>
          <div class="view-meta">${new Date(v.createdAt).toLocaleDateString()}</div>
        </div>
        <div class="view-actions">
          <button class="btn btn-secondary btn-sm view-load" data-id="${v.id}">Load</button>
          <button class="icon-btn danger-btn view-del" data-id="${v.id}"><i class="ti ti-trash"></i></button>
        </div>
      </div>`).join('');

    container.querySelectorAll('.view-load').forEach(b =>
      b.addEventListener('click', () => App._loadView?.(b.dataset.id)));
    container.querySelectorAll('.view-del').forEach(b =>
      b.addEventListener('click', () => {
        if (confirm('Delete this view?')) App._deleteView?.(b.dataset.id);
      }));

    _syncViewSelector(views);
  }

  function _syncViewSelector(views) {
    const sel = document.getElementById('view-selector');
    if (!sel) return;
    sel.innerHTML = '<option value="">— views —</option>' +
      views.map(v => `<option value="${v.id}">${v.name}</option>`).join('');
  }

  function showProgress(pct, label) {
    const area  = document.getElementById('progress-area');
    const bar   = document.getElementById('progress-bar');
    const lbl   = document.getElementById('progress-label');
    if (!area) return;
    area.style.display = 'block';
    if (lbl) lbl.textContent = label || '';
    if (bar) {
      if (pct < 0) { bar.style.width = '100%'; bar.style.animation = 'indeterminate 1.5s ease infinite'; }
      else         { bar.style.width = pct + '%'; bar.style.animation = ''; }
    }
  }

  function hideProgress() {
    const area = document.getElementById('progress-area');
    if (area) area.style.display = 'none';
  }

  let _toastTimer = null;
  function showToast(msg, type = 'info') {
    let toast = document.getElementById('astro-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'astro-toast';
      document.body.appendChild(toast);
    }
    toast.className = `toast toast-${type}`;
    toast.textContent = msg;
    toast.style.opacity = '1';
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { toast.style.opacity = '0'; }, 3000);
  }

  return { appendChatMessage, renderSavedViews, showProgress, hideProgress, showToast };
})();

// ── Boot ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => App.init());
