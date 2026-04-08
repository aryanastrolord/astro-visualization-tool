// ============================================================
// maps.js — Map image registry
// ============================================================
window.MapRegistry = (() => {
  const _maps = new Map(); // id → MapRecord
  const _listeners = [];

  function _makeId() {
    return `map_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
  }

  async function _loadImg(url) {
    const img = new Image();
    await new Promise(res => { img.onload = res; img.onerror = res; img.src = url; });
    return (img.complete && img.naturalWidth > 0) ? img : null;
  }

  /** Add a map from a user-selected File object. */
  async function add(file) {
    const url    = URL.createObjectURL(file);
    const img    = await _loadImg(url);
    const id     = _makeId();
    const record = {
      id,
      name:               file.name.replace(/\.[^.]+$/, ''),
      image_url:          url,
      width:              img?.naturalWidth  || 1024,
      height:             img?.naturalHeight || 1024,
      calibration:        null,
      calibration_status: 'uncalibrated',
      _img:               img,
      _isPreset:          false,
    };
    _maps.set(id, record);
    _emit();
    return record;
  }

  /**
   * Add a map by fetching it from a server URL (used for preloading preset maps).
   * Falls back gracefully if the fetch fails (e.g. file not on server).
   */
  async function addFromUrl(url, name) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Map fetch failed: ${resp.status} ${url}`);
    const blob     = await resp.blob();
    const objUrl   = URL.createObjectURL(blob);
    const img      = await _loadImg(objUrl);
    const id       = _makeId();
    const record   = {
      id,
      name,
      image_url:          objUrl,
      width:              img?.naturalWidth  || 1024,
      height:             img?.naturalHeight || 1024,
      calibration:        null,
      calibration_status: 'uncalibrated',
      _img:               img,
      _isPreset:          true,
    };
    _maps.set(id, record);
    _emit();
    return record;
  }

  function setCalibration(id, calibration) {
    const m = _maps.get(id);
    if (!m) return;
    m.calibration         = { ...calibration, map_id: id, img_w: m.width, img_h: m.height };
    m.calibration_status  = 'calibrated';
    _emit();
  }

  function clearCalibration(id) {
    const m = _maps.get(id);
    if (!m) return;
    m.calibration         = null;
    m.calibration_status  = 'uncalibrated';
    _emit();
  }

  function get(id)  { return _maps.get(id); }
  function getAll() { return Array.from(_maps.values()); }

  function remove(id) {
    const m = _maps.get(id);
    if (m?.image_url) URL.revokeObjectURL(m.image_url);
    _maps.delete(id);
    _emit();
  }

  function onChange(fn) { _listeners.push(fn); }
  function _emit()      { _listeners.forEach(fn => fn(getAll())); }

  return { add, addFromUrl, setCalibration, clearCalibration, get, getAll, remove, onChange };
})();
