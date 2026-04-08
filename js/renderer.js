// ============================================================
// renderer.js — Canvas 2D rendering engine (calibration + event-rules driven)
// ============================================================
window.Renderer = (() => {
  let canvas = null, ctx = null;
  let transform  = { x: 0, y: 0, scale: 1 };
  let dragging   = false;
  let dragStart  = { x: 0, y: 0 };

  let _currentMap     = null;  // MapRecord from MapRegistry
  let _heatmapBitmap  = null;  // ImageBitmap from Heatmap.generate()
  let _onInteract     = null;  // callback → App.scheduleRender()
  let _onCalibClick   = null;  // callback(px, py) when in calibration mode
  let _calibMode      = false;

  // Cached last render args — replayed on pan/zoom
  let _precomp = null, _lyr = null, _tsUpTo = Infinity, _settings = null;

  // ── Public interface ──────────────────────────────────────
  function setInteractCallback(fn)    { _onInteract   = fn; }
  function setCalibrationMode(active, clickCb) {
    _calibMode    = !!active;
    _onCalibClick = active ? clickCb : null;
    if (canvas) canvas.style.cursor = active ? 'crosshair' : 'default';
  }

  function init(canvasEl) {
    canvas = canvasEl;
    ctx    = canvas.getContext('2d');
    _setupInteraction();
    _resizeCanvas();
    window.addEventListener('resize', _resizeCanvas);
    _drawEmpty();
  }

  // Load a MapRecord (from MapRegistry) into the renderer
  async function loadMap(mapRecord) {
    _currentMap    = mapRecord || null;
    _heatmapBitmap = null;
    if (mapRecord && !mapRecord._img) {
      const img = new Image();
      img.src    = mapRecord.image_url;
      await new Promise(res => { img.onload = res; img.onerror = res; });
      mapRecord._img = (img.complete && img.naturalWidth > 0) ? img : null;
    }
    _fitMap();
    _repaint();
  }

  /** Called by app.js with pre-grouped data. Caches args and repaints. */
  function redrawPrecomputed(precomputed, layers, tsUpTo, settings) {
    if (precomputed !== undefined) _precomp  = precomputed;
    if (layers      !== undefined) _lyr      = layers;
    if (tsUpTo      !== undefined) _tsUpTo   = tsUpTo;
    if (settings    !== undefined) _settings = settings;
    _repaint();
  }

  /** Legacy redraw — kept for compatibility (calibration overlay path). */
  function redraw(filteredEvents, layers, tsUpTo, settings) {
    _precomp  = null;
    if (layers  !== undefined) _lyr      = layers;
    if (tsUpTo  !== undefined) _tsUpTo   = tsUpTo;
    if (settings !== undefined) _settings = settings;
    _repaint();
  }

  // ── Private: layout ───────────────────────────────────────
  function _resizeCanvas() {
    const r      = canvas.parentElement.getBoundingClientRect();
    canvas.width = r.width; canvas.height = r.height;
    _repaint();
  }

  function _mapSize() {
    return _currentMap
      ? { w: _currentMap.width, h: _currentMap.height }
      : { w: 1024, h: 1024 };
  }

  function _fitMap() {
    if (!canvas) return;
    const { w, h } = _mapSize();
    const sc  = Math.min(canvas.width / w, canvas.height / h) * 0.92;
    transform = { x: (canvas.width - w * sc) / 2, y: (canvas.height - h * sc) / 2, scale: sc };
  }

  function _applyTransform() {
    ctx.setTransform(transform.scale, 0, 0, transform.scale, transform.x, transform.y);
  }

  function _repaint() {
    _drawScene(_precomp, _lyr, _tsUpTo, _settings);
  }

  // ── Private: interaction ──────────────────────────────────
  function _setupInteraction() {
    canvas.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      if (_calibMode && _onCalibClick) {
        const r  = canvas.getBoundingClientRect();
        const lx = (e.clientX - r.left  - transform.x) / transform.scale;
        const ly = (e.clientY - r.top   - transform.y) / transform.scale;
        _onCalibClick({ px: lx, py: ly });
        return;
      }
      dragging  = true;
      dragStart = { x: e.clientX - transform.x, y: e.clientY - transform.y };
      canvas.style.cursor = 'grabbing';
    });
    canvas.addEventListener('mousemove', e => {
      if (!dragging) return;
      transform.x = e.clientX - dragStart.x;
      transform.y = e.clientY - dragStart.y;
      if (_onInteract) _onInteract(); else requestAnimationFrame(_repaint);
    });
    canvas.addEventListener('mouseup',    () => { dragging = false; canvas.style.cursor = 'crosshair'; });
    canvas.addEventListener('mouseleave', () => { dragging = false; });
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const f  = e.deltaY < 0 ? 1.12 : (1 / 1.12);
      const ns = Math.max(0.05, Math.min(40, transform.scale * f));
      const ratio = ns / transform.scale;
      transform.x = mx - (mx - transform.x) * ratio;
      transform.y = my - (my - transform.y) * ratio;
      transform.scale = ns;
      if (_onInteract) _onInteract(); else requestAnimationFrame(_repaint);
    }, { passive: false });
  }

  // ── Binary search helper ──────────────────────────────────
  // Returns last index i where arr[i].timestamp <= tsUpTo, or -1.
  function _bsearch(arr, tsUpTo) {
    let lo = 0, hi = arr.length - 1, result = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].timestamp <= tsUpTo) { result = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return result;
  }

  // ── Private: rendering ─────────────────────────────────────
  function _drawScene(precomp, lyr, tsUpTo, settings) {
    if (!ctx) return;
    const W = canvas.width, H = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);

    if (!_currentMap) { _drawEmpty(); return; }

    _applyTransform();
    _drawMapBase();

    // Heatmap overlay
    if (_heatmapBitmap) {
      const { w, h } = _mapSize();
      ctx.globalAlpha = 1;
      ctx.drawImage(_heatmapBitmap, 0, 0, w, h);
    }

    if (!precomp) { ctx.setTransform(1, 0, 0, 1, 0, 0); return; }

    const l    = lyr || {};
    const upTo = tsUpTo != null ? tsUpTo : Infinity;
    const th   = settings?.pathThickness || 2;

    if (l.paths  && precomp.pathGroups?.size > 0) _drawPathsPrecomputed(precomp.pathGroups, upTo, th);
    if (l.points && precomp.markers?.length  > 0) _drawMarkersPrecomputed(precomp.markers, upTo);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  function _drawEmpty() {
    const W = canvas.width, H = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#e8eaf2'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(91,33,182,0.05)'; ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    ctx.fillStyle = 'rgba(75,82,112,0.55)';
    ctx.font = '600 15px "Be Vietnam Pro",system-ui,sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('Upload a map image to begin', W / 2, H / 2 - 10);
    ctx.font = '400 12px "Be Vietnam Pro",system-ui,sans-serif'; ctx.fillStyle = 'rgba(136,146,170,0.7)';
    ctx.fillText('Use the Maps tab to upload any PNG or JPG', W / 2, H / 2 + 12);
  }

  function _drawMapBase() {
    const { w, h } = _mapSize();
    const img = _currentMap?._img;
    if (img) {
      ctx.drawImage(img, 0, 0, w, h);
    } else {
      ctx.fillStyle = '#dde4ef'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(75,82,112,0.25)';
      ctx.font = `bold 36px "Be Vietnam Pro",sans-serif`; ctx.textAlign = 'center';
      ctx.fillText(_currentMap?.name || 'Map', w / 2, h / 2);
    }
  }

  // ── Fast pre-computed path drawing ───────────────────────
  // pathGroups: Map<key, { rule, points: [{px,py,timestamp}] sorted by ts }>
  // Uses binary search to find the visible slice — O(log n) per group.
  function _drawPathsPrecomputed(pathGroups, tsUpTo, thickness) {
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const allVisible = tsUpTo === Infinity;
    for (const [, { rule, points }] of pathGroups) {
      const cutoff = allVisible ? points.length - 1 : _bsearch(points, tsUpTo);
      if (cutoff < 1) continue;
      ctx.strokeStyle = rule.color || '#06b6d4';
      ctx.lineWidth   = Math.max(0.3, (rule.line_width || thickness) / transform.scale);
      ctx.globalAlpha = 0.65;
      ctx.beginPath();
      ctx.moveTo(points[0].px, points[0].py);
      for (let i = 1; i <= cutoff; i++) ctx.lineTo(points[i].px, points[i].py);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // ── Icon character cache ──────────────────────────────────
  // Reads the ::before content of a Tabler icon element to get its Unicode
  // glyph, then caches it. Returns null if font not loaded / icon unknown.
  const _iconCharCache = {};
  function _iconChar(name) {
    if (!name) return null;
    if (_iconCharCache[name] !== undefined) return _iconCharCache[name];
    try {
      const el = document.createElement('i');
      el.className = `ti ti-${name}`;
      // font-size must be non-zero so the font loads; off-screen so not visible
      el.style.cssText = 'position:fixed;left:-9999px;top:-9999px;visibility:hidden;pointer-events:none;font-size:16px;font-family:tabler-icons';
      document.body.appendChild(el);
      const raw = getComputedStyle(el, '::before').content;
      document.body.removeChild(el);
      const ch = raw.replace(/^["']|["']$/g, '');
      _iconCharCache[name] = (ch && ch !== 'none' && ch.length > 0) ? ch : null;
    } catch (_) {
      _iconCharCache[name] = null;
    }
    return _iconCharCache[name];
  }

  // ── Fast pre-computed marker drawing ─────────────────────
  // markers: [{px, py, timestamp, rule, icon, markerText}] sorted by ts
  // Uses binary search to find count of visible markers.
  function _drawMarkersPrecomputed(markers, tsUpTo) {
    const radius   = Math.max(3, 8 / transform.scale);
    const fs       = Math.max(4, 8 / transform.scale);
    const limit    = tsUpTo === Infinity ? markers.length : _bsearch(markers, tsUpTo) + 1;
    const fontText = `bold ${fs}px "Be Vietnam Pro",sans-serif`;
    const fontIcon = `900 ${fs * 1.1}px tabler-icons`;

    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

    for (let i = 0; i < limit; i++) {
      const { px, py, rule, icon, markerText } = markers[i];
      ctx.globalAlpha = 0.88;
      ctx.fillStyle   = rule.color || '#6b7280';
      ctx.beginPath(); ctx.arc(px, py, radius, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';

      if (icon) {
        const ch = _iconChar(icon);
        if (ch) {
          ctx.font = fontIcon;
          ctx.fillText(ch, px, py);
        } else {
          ctx.font = fontText;
          ctx.fillText(markerText, px, py);
        }
      } else {
        ctx.font = fontText;
        ctx.fillText(markerText, px, py);
      }
    }
    ctx.globalAlpha = 1; ctx.textBaseline = 'alphabetic';
  }

  // Draw calibration reference point overlays on top of the current scene
  function drawCalibrationOverlay(refPoints, pendingPoint) {
    if (!ctx || !_currentMap) return;
    _applyTransform();
    const r   = Math.max(5, 8  / transform.scale);
    const lw  = Math.max(1, 1.5 / transform.scale);

    for (let i = 0; i < refPoints.length; i++) {
      const pt = refPoints[i];
      ctx.strokeStyle = '#0369a1'; ctx.fillStyle = 'rgba(3,105,161,0.25)'; ctx.lineWidth = lw;
      ctx.beginPath(); ctx.arc(pt.px, pt.py, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#0369a1';
      ctx.font = `bold ${Math.max(7, 9 / transform.scale)}px "Be Vietnam Pro",sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), pt.px, pt.py);
    }

    if (pendingPoint) {
      ctx.strokeStyle = '#dc2626'; ctx.lineWidth = lw;
      const s = Math.max(5, 7 / transform.scale);
      ctx.beginPath();
      ctx.moveTo(pendingPoint.px - s, pendingPoint.py - s); ctx.lineTo(pendingPoint.px + s, pendingPoint.py + s);
      ctx.moveTo(pendingPoint.px + s, pendingPoint.py - s); ctx.lineTo(pendingPoint.px - s, pendingPoint.py + s);
      ctx.stroke();
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  function setHeatmapBitmap(bitmap) { _heatmapBitmap = bitmap; requestAnimationFrame(_repaint); }
  function clearHeatmap()           { _heatmapBitmap = null;   requestAnimationFrame(_repaint); }
  function resetView()              { _fitMap(); _repaint(); }
  function getTransform()           { return { ...transform }; }

  return { init, loadMap, redraw, redrawPrecomputed, setInteractCallback, setCalibrationMode,
           setHeatmapBitmap, clearHeatmap, drawCalibrationOverlay, resetView, getTransform };
})();
