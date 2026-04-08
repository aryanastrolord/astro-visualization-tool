// ============================================================
// datasets.js — Dataset registry, lifecycle, auto-mapping
// ============================================================
window.DatasetRegistry = (() => {
  const _datasets = new Map(); // id → DatasetRecord
  const _listeners = [];

  // ── Auto-mapping heuristics ──────────────────────────────
  // Ordered lists: first match wins, earlier = higher confidence.
  // NOTE: for 3D game data (x/y=elevation/z), the system 'y' field should map to the
  // game Z column (horizontal), not Y (elevation). We detect this via the 3D heuristic
  // in autoSuggestMapping below.
  const FIELD_PATTERNS = {
    timestamp:     ['ts', 'time', 'timestamp', 'datetime', 'created_at', 'date', 'createdat', 'event_time'],
    entity_id:     ['user_id', 'player_id', 'entity_id', 'userid', 'playerid', 'entityid', 'uid', 'id'],
    event_type:    ['event_type', 'event', 'eventtype', 'type', 'action', 'event_name'],
    x:             ['x', 'pos_x', 'posx', 'position_x', 'world_x', 'coord_x', 'loc_x'],
    y:             ['z', 'pos_z', 'posz', 'position_z', 'world_z', 'y', 'pos_y', 'posy', 'position_y', 'world_y'],
    z:             ['y', 'height', 'altitude', 'elevation', 'depth', 'z2'],
    entity_name:   ['name', 'username', 'player_name', 'entity_name', 'displayname', 'display_name'],
    session_id:    ['match_id', 'session_id', 'game_id', 'room_id', 'matchid', 'sessionid', 'gameid', 'round_id'],
    map_id:        ['map_id', 'map', 'level', 'scene', 'mapid', 'zone', 'area'],
    metadata_json: ['metadata', 'meta', 'extra', 'data', 'json', 'payload'],
  };

  function autoSuggestMapping(columns) {
    const fields = {
      timestamp: null, entity_id: null, event_type: null, x: null, y: null,
      z: null, entity_name: null, session_id: null, map_id: null, metadata_json: null,
    };
    const confidence = {};
    const used = new Set();

    for (const [field, patterns] of Object.entries(FIELD_PATTERNS)) {
      let bestCol = null, bestScore = 0;
      for (const col of columns) {
        const norm = col.toLowerCase().replace(/[-_\s]/g, '');
        for (let i = 0; i < patterns.length; i++) {
          const pat = patterns[i].replace(/[-_\s]/g, '');
          let score = 0;
          if (norm === pat)                               score = 1.00 - i * 0.005;
          else if (norm.startsWith(pat) || pat.startsWith(norm)) score = 0.75 - i * 0.005;
          else if (norm.includes(pat) || pat.includes(norm))     score = 0.50 - i * 0.005;
          if (score > bestScore && !used.has(col)) { bestScore = score; bestCol = col; }
        }
      }
      if (bestCol) {
        fields[field] = bestCol;
        used.add(bestCol);
        confidence[field] = bestScore >= 0.95 ? 'high' : bestScore >= 0.65 ? 'medium' : 'low';
      } else {
        confidence[field] = 'none';
      }
    }
    return { fields, confidence };
  }

  // ── CRUD ─────────────────────────────────────────────────
  /**
   * @param {string} name - display name (folder or file name)
   * @param {string} fileType - 'csv' | 'parquet'
   * @param {object[]} rawRows - combined rows from all files (each has _table_id)
   * @param {string[]} columns - column names (without _table_id)
   * @param {object[]} tables - per-file metadata from ETL [{id, file_name, row_count, columns}]
   */
  function add(name, fileType, rawRows, columns, tables = []) {
    const id = `ds_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
    // Each table gets its own auto-suggested mapping based on its own columns
    const tableDefs = tables.map(t => {
      const tblCols = t.columns || columns;
      const suggested = autoSuggestMapping(tblCols);
      return {
        ...t,
        render_modes_enabled: t.render_modes_enabled || ['path', 'point', 'heatmap'],
        mapping: { fields: { ...suggested.fields }, confidence: { ...suggested.confidence } },
      };
    });
    const record = {
      id, name, file_type: fileType,
      row_count: rawRows.length,
      col_count:  columns.length,
      columns,
      tables:     tableDefs,
      uploaded_at: new Date().toISOString(),
      status: 'uploaded',
      rawRows,
      processed: null,
      error: null,
    };
    _datasets.set(id, record);
    _emit();
    return record;
  }

  /** Update one specific table's mapping without affecting others. */
  function updateTableMapping(datasetId, tableId, fields) {
    const d = _datasets.get(datasetId);
    if (!d) return;
    const t = d.tables?.find(t => t.id === tableId);
    if (!t) return;
    t.mapping = { ...t.mapping, fields: { ...fields } };
    // If all tables have required fields → mark dataset as mapped
    const required = ['timestamp', 'entity_id', 'event_type', 'x', 'y'];
    const allMapped = (d.tables || []).every(tbl => required.every(f => tbl.mapping?.fields?.[f]));
    if (allMapped && d.status === 'uploaded') d.status = 'mapped';
    _emit();
  }

  /** Re-run auto-suggest for every table in a dataset (resets manual overrides). */
  function suggestTableMappings(datasetId) {
    const d = _datasets.get(datasetId);
    if (!d) return;
    for (const t of (d.tables || [])) {
      const tblCols = t.columns || d.columns;
      const suggested = autoSuggestMapping(tblCols);
      t.mapping = { fields: { ...suggested.fields }, confidence: { ...suggested.confidence } };
    }
    const required = ['timestamp', 'entity_id', 'event_type', 'x', 'y'];
    const allMapped = (d.tables || []).every(tbl => required.every(f => tbl.mapping?.fields?.[f]));
    if (allMapped && d.status === 'uploaded') d.status = 'mapped';
    _emit();
  }

  /** Remove a single table from a dataset (marks for reprocess). */
  function removeTable(datasetId, tableId) {
    const d = _datasets.get(datasetId);
    if (!d) return;
    d.tables    = (d.tables || []).filter(t => t.id !== tableId);
    d.rawRows   = (d.rawRows || []).filter(r => r._table_id !== tableId);
    d.row_count = d.rawRows.length;
    // Reset processed state — must reprocess
    d.processed = null;
    if (d.status === 'processed') d.status = 'mapped';
    _emit();
  }

  function setProcessed(id, processedDataset) {
    const d = _datasets.get(id);
    if (!d) return;
    d.processed  = processedDataset;
    d.status     = 'processed';
    d.error      = null;
    _emit();
  }

  function setError(id, msg) {
    const d = _datasets.get(id);
    if (!d) return;
    d.status = 'error';
    d.error  = msg;
    _emit();
  }

  function get(id)     { return _datasets.get(id); }
  function getAll()    { return Array.from(_datasets.values()); }
  function getProcessed() { return getAll().filter(d => d.status === 'processed'); }

  function remove(id) {
    _datasets.delete(id);
    _emit();
  }

  function onChange(fn) { _listeners.push(fn); }
  function _emit()      { _listeners.forEach(fn => fn(getAll())); }

  return { add, updateTableMapping, suggestTableMappings, setProcessed, setError, removeTable, get, getAll, getProcessed, remove, onChange, autoSuggestMapping };
})();
