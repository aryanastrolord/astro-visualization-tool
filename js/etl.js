// ============================================================
// etl.js — Universal ETL pipeline (DuckDB-WASM + field mapping)
// ============================================================
window.ETL = (() => {
  let db = null, conn = null, initialized = false;

  // ── DuckDB init ───────────────────────────────────────────
  async function initialize(onProgress) {
    if (initialized) return;
    onProgress?.('Loading DuckDB-WASM…');
    const dk = window.duckdb;
    if (!dk) throw new Error('DuckDB-WASM not loaded. Refresh and try again.');

    const bundles = dk.getJsDelivrBundles?.() ?? dk.JSDELIVR_BUNDLES;
    const bundle  = await dk.selectBundle(bundles);
    const workerScript = `importScripts("${bundle.mainWorker}");`;
    const workerBlob   = new Blob([workerScript], { type: 'text/javascript' });
    const worker       = new Worker(URL.createObjectURL(workerBlob));
    const logger       = new dk.ConsoleLogger(dk.LogLevel?.WARNING ?? 2);

    db = new dk.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    conn = await db.connect();
    try { await conn.query("PRAGMA threads=4"); }         catch (_) {}
    try { await conn.query("PRAGMA memory_limit='512MB'"); } catch (_) {}

    initialized = true;
    onProgress?.('DuckDB ready ✓');
  }

  // ── Arrow table → plain JS rows ───────────────────────────
  function arrowToRows(result) {
    if (!result || result.numRows === 0) return [];
    const colNames = (result.schema?.fields ?? []).map(f => f.name);
    const rows = [];
    for (let r = 0; r < result.numRows; r++) {
      const row = {};
      for (const name of colNames) {
        const col = result.getChild(name);
        if (!col) { row[name] = null; continue; }
        let val = col.get(r);
        if (typeof val === 'bigint') val = Number(val);
        row[name] = val;
      }
      rows.push(row);
    }
    return rows;
  }

  // ── File registration (Parquet) ───────────────────────────
  async function _registerFile(file, alias) {
    const dk       = window.duckdb;
    const protocol = dk.DuckDBDataProtocol?.BROWSER_FILEREADER ?? dk.DuckDBDataProtocol?.HTTP ?? 2;
    await db.registerFileHandle(alias, file, protocol, true);
  }

  // ── Load raw rows from a Parquet file (all columns) ───────
  async function _loadParquetRaw(file, alias) {
    try {
      const result = await conn.query(`SELECT * FROM parquet_scan('${alias}')`);
      return arrowToRows(result);
    } catch (e) {
      console.warn(`[ETL] Parquet ${alias}:`, e.message);
      return [];
    }
  }

  // ── Load raw rows from a CSV file (all columns) ───────────
  async function _loadCSVRaw(file) {
    const text  = await file.text();
    const buf   = new TextEncoder().encode(text);
    const alias = `csv_${file.name.replace(/[^a-zA-Z0-9]/g, '_')}.csv`;
    await db.registerFileBuffer(alias, buf);
    try {
      const result = await conn.query(`SELECT * FROM read_csv_auto('${alias}', header=true)`);
      return arrowToRows(result);
    } catch (e) {
      console.warn(`[ETL] CSV ${file.name}:`, e.message);
      return [];
    }
  }

  // ── Main entry: load files → raw rows + column list + table list ───
  async function loadRawFiles(files, onProgress) {
    await initialize(onProgress);
    const arr          = Array.from(files);
    const parquetFiles = arr.filter(f => {
      const n = f.name.toLowerCase();
      return n.endsWith('.nakama-0') || n.endsWith('.parquet') || (!n.includes('.') && f.size > 512);
    });
    const csvFiles = arr.filter(f => f.name.toLowerCase().endsWith('.csv'));

    if (parquetFiles.length === 0 && csvFiles.length === 0) {
      throw new Error('No supported files found. Expected .nakama-0, .parquet, or .csv files.');
    }

    let allRows  = [];
    let loaded   = 0;
    const tables = []; // per-file metadata: [{id, file_name, row_count}]

    for (const file of parquetFiles) {
      const alias   = `raw_${loaded}_${file.name.replace(/[^a-zA-Z0-9]/g, '_')}.parquet`;
      const tableId = `tbl_${Date.now()}_${loaded}`;
      try {
        await _registerFile(file, alias);
        const rows = await _loadParquetRaw(file, alias);
        rows.forEach(r => { r._table_id = tableId; });
        allRows = allRows.concat(rows);
        const tblCols = rows.length > 0 ? Object.keys(rows[0]).filter(k => k !== '_table_id') : [];
        tables.push({ id: tableId, file_name: file.name, row_count: rows.length, render_modes_enabled: ['path', 'point', 'heatmap'], columns: tblCols });
        loaded++;
      } catch (err) {
        console.warn(`[ETL] Skip ${file.name}:`, err.message);
      }
      if (loaded % 10 === 0 || loaded === parquetFiles.length) {
        onProgress?.(`Loading Parquet: ${loaded}/${parquetFiles.length}…`);
      }
    }

    for (const file of csvFiles) {
      const tableId = `tbl_${Date.now()}_${loaded}`;
      try {
        const rows = await _loadCSVRaw(file);
        rows.forEach(r => { r._table_id = tableId; });
        allRows = allRows.concat(rows);
        const csvCols = rows.length > 0 ? Object.keys(rows[0]).filter(k => k !== '_table_id') : [];
        tables.push({ id: tableId, file_name: file.name, row_count: rows.length, render_modes_enabled: ['path', 'point', 'heatmap'], columns: csvCols });
        loaded++;
        onProgress?.(`Loaded CSV: ${file.name}`);
      } catch (err) {
        console.warn(`[ETL] CSV skip ${file.name}:`, err.message);
      }
    }

    if (allRows.length === 0) {
      throw new Error('No data read from files. Check the browser console for details.');
    }

    // Strip internal _table_id from column detection
    const columns = Object.keys(allRows[0]).filter(k => k !== '_table_id');
    console.log(`[ETL] Loaded ${allRows.length} raw rows across ${tables.length} file(s), columns:`, columns);
    return { rawRows: allRows, columns, tables };
  }

  // ── Timestamp parsing ─────────────────────────────────────
  function _parseTs(raw) {
    if (raw == null) return NaN;
    let n;
    if (raw instanceof Date) {
      return raw.getTime(); // Arrow TIMESTAMP → Date → ms ✓
    } else if (typeof raw === 'number') {
      n = raw;
    } else if (typeof raw === 'bigint') {
      n = Number(raw);
    } else if (raw instanceof Uint8Array || ArrayBuffer.isView(raw)) {
      const str = new TextDecoder().decode(raw).trim();
      n = parseInt(str, 10);
    } else {
      const s = String(raw).trim();
      n = /^\d+(\.\d+)?$/.test(s) ? parseFloat(s) : new Date(s.replace(/\//g, '-')).getTime();
    }
    if (!isFinite(n) || isNaN(n)) return NaN;
    // Normalize to milliseconds based on magnitude:
    // > 1e13 → microseconds (2001+ in µs ≈ 1e15) → divide by 1000
    // 1e10 to 1e13 → milliseconds (2001+ in ms ≈ 1e12) → as-is
    // 1e6 to 1e10  → seconds (2001+ in s ≈ 1.7e9) → multiply by 1000
    // < 1e6 → already a relative/small value → as-is
    if (n > 1e13) return n / 1000;   // µs → ms
    if (n > 1e10) return n;           // already ms
    if (n > 1e6)  return n * 1000;   // seconds → ms
    return n;                          // relative / small
  }

  // ── Event string normalization ────────────────────────────
  function _normalizeEvent(raw) {
    if (!raw) return 'Unknown';
    let s = raw;
    // Binary from Arrow
    if (s instanceof Uint8Array || ArrayBuffer.isView(s)) {
      s = new TextDecoder('utf-8').decode(s);
    } else if (Array.isArray(s)) {
      s = new TextDecoder('utf-8').decode(new Uint8Array(s));
    } else {
      s = String(s);
    }
    // Decode escape sequences e.g. \x50osition
    s = s.replace(/\\x([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    s = s.trim();
    if (!s) return 'Unknown';
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // ── Core: transform raw rows using per-table MappingConfig ──
  // Patterns used to auto-detect the spatial grouping column when not explicitly mapped
  const _MAP_ID_PATTERNS = ['map_id', 'mapid', 'map', 'level', 'scene', 'zone', 'area', 'world', 'location'];

  async function processDataset(datasetRecord, onProgress) {
    const { rawRows, id: datasetId } = datasetRecord;
    if (!rawRows || rawRows.length === 0) throw new Error('No raw data to process.');

    // Build per-table field map — each file uses its own column mapping
    const required = ['timestamp', 'entity_id', 'event_type', 'x', 'y'];
    const tableFieldsMap = new Map(); // tableId → { f, mapIdCol }

    for (const t of (datasetRecord.tables || [])) {
      const f = t.mapping?.fields;
      if (!f) throw new Error(`File "${t.file_name}" has no mapping configured.`);
      for (const req of required) {
        if (!f[req]) throw new Error(`File "${t.file_name}": required field "${req}" is not mapped.`);
      }
      // Resolve map_id column: explicit mapping wins, then auto-detect from this file's columns
      const mapIdCol = f.map_id ||
        (t.columns || []).find(k => _MAP_ID_PATTERNS.includes(k.toLowerCase())) || null;
      if (mapIdCol && !f.map_id) {
        console.log(`[ETL] "${t.file_name}" auto-detected spatial column: "${mapIdCol}"`);
      }
      tableFieldsMap.set(t.id, { f, mapIdCol });
    }

    if (tableFieldsMap.size === 0) throw new Error('No file mappings configured. Use Suggest on the dataset to generate mappings.');

    // Fallback for rows with no _table_id (shouldn't happen, but be safe)
    const fallbackEntry = tableFieldsMap.values().next().value;

    onProgress?.('Applying field mapping…');

    const events = [];
    let minTs = Infinity, maxTs = -Infinity;
    let skipped = 0;

    for (let i = 0; i < rawRows.length; i++) {
      const row = rawRows[i];

      // Look up this row's file-specific field mapping
      const { f, mapIdCol } = tableFieldsMap.get(row._table_id) || fallbackEntry;

      const x = Number(row[f.x] ?? NaN);
      const y = Number(row[f.y] ?? NaN);
      if (!isFinite(x) || !isFinite(y)) { skipped++; continue; }

      let tsMs = _parseTs(row[f.timestamp]);
      if (!isFinite(tsMs)) tsMs = i * 1000; // fallback: row-order ms

      if (tsMs < minTs) minTs = tsMs;
      if (tsMs > maxTs) maxTs = tsMs;

      const entityId   = String(row[f.entity_id]  ?? '').trim() || `e${i}`;
      const eventRaw   = row[f.event_type];
      const sessionId  = f.session_id  ? (String(row[f.session_id]  ?? '').trim() || null) : null;
      const entityName = f.entity_name ? (String(row[f.entity_name] ?? '').trim() || null) : null;
      const zRaw       = f.z ? Number(row[f.z] ?? NaN) : NaN;
      const mapId      = mapIdCol ? (String(row[mapIdCol] ?? '').trim() || null) : null;

      events.push({
        event_id:      `${datasetId}_${i}`,
        dataset_id:    datasetId,
        table_id:      row._table_id || null,
        raw_timestamp: tsMs,
        timestamp:     0,        // filled after minTs known
        entity_id:     entityId,
        event_type:    _normalizeEvent(eventRaw),
        x, y,
        z:             isFinite(zRaw) ? zRaw : null,
        session_id:    sessionId,
        entity_name:   entityName,
        map_id:        mapId,
        metadata_json: null,
        // px/py computed at render time by Renderer using CalibrationConfig
      });
    }

    if (events.length === 0) {
      throw new Error(`No valid rows after filtering null coordinates. (${skipped} rows skipped)`);
    }

    onProgress?.('Building indexes…');

    // Entity index
    const entities = new Map();
    for (const ev of events) {
      if (!entities.has(ev.entity_id)) {
        entities.set(ev.entity_id, { entity_id: ev.entity_id, event_count: 0, sessions: [] });
      }
      const ent = entities.get(ev.entity_id);
      ent.event_count++;
      if (ev.session_id && !ent.sessions.includes(ev.session_id)) {
        ent.sessions.push(ev.session_id);
      }
    }

    // Session index — build first so we can normalize per-session
    const sessions = new Map();
    for (const ev of events) {
      if (!ev.session_id) continue;
      if (!sessions.has(ev.session_id)) {
        sessions.set(ev.session_id, { session_id: ev.session_id, minTs: Infinity, maxTs: -Infinity, event_count: 0 });
      }
      const s = sessions.get(ev.session_id);
      s.event_count++;
      if (ev.raw_timestamp < s.minTs) s.minTs = ev.raw_timestamp;
      if (ev.raw_timestamp > s.maxTs) s.maxTs = ev.raw_timestamp;
    }
    for (const [, s] of sessions) {
      s.durationMs = isFinite(s.maxTs) ? s.maxTs - s.minTs : 0;
    }

    // Normalize timestamps: per-session so all sessions overlay on same 0→maxDuration timeline.
    // Events without a session_id fall back to dataset-wide baseline.
    const baseTs = isFinite(minTs) ? minTs : 0;
    for (const ev of events) {
      const sess = ev.session_id ? sessions.get(ev.session_id) : null;
      const sessBase = (sess && isFinite(sess.minTs)) ? sess.minTs : baseTs;
      ev.timestamp = ev.raw_timestamp - sessBase;
    }

    // durationMs = longest individual session (or full dataset span if no sessions)
    const maxSessionDuration = sessions.size > 0
      ? Math.max(...Array.from(sessions.values()).map(s => s.durationMs || 0))
      : (isFinite(minTs) && isFinite(maxTs) ? maxTs - minTs : 0);

    // Event types
    const eventTypes = new Set(events.map(e => e.event_type));

    // Unique map IDs found in data (null excluded)
    const mapIds = new Set(events.map(e => e.map_id).filter(Boolean));

    // Auto-generate event rules for any new types
    EventRules.ensureRulesForTypes(eventTypes);

    onProgress?.('Done!');
    if (skipped) console.log(`[ETL] Skipped ${skipped} rows with null x/y.`);

    return {
      dataset_id: datasetId,
      events,
      entities,
      sessions,
      event_types: eventTypes,
      map_ids:    mapIds,
      minTs:       isFinite(minTs) ? minTs : 0,
      maxTs:       isFinite(maxTs) ? maxTs : 0,
      durationMs:  maxSessionDuration,
      stats: {
        totalRows:      events.length,
        skippedRows:    skipped,
        entityCount:    entities.size,
        sessionCount:   sessions.size,
        eventTypeCount: eventTypes.size,
        mapIdCount:     mapIds.size,
      },
    };
  }

  return { loadRawFiles, processDataset, initialize };
})();
