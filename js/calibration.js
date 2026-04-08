// ============================================================
// calibration.js — Coordinate transform utilities
// ============================================================
window.Calibration = (() => {

  /**
   * Convert world (x, y) → image pixel (px, py).
   * cal = { origin_x, origin_y, scale_x, scale_y, invert_x, invert_y, img_w, img_h }
   * Formula:
   *   px = (wx - origin_x) / scale_x        [then optionally flip]
   *   py = (wy - origin_y) / scale_y
   */
  function worldToPixel(wx, wy, cal) {
    if (!cal || !isValid(cal)) return { px: 0, py: 0 };
    const w = cal.img_w || 1024;
    const h = cal.img_h || 1024;
    let px = (wx - cal.origin_x) / cal.scale_x;
    let py = (wy - cal.origin_y) / cal.scale_y;
    if (cal.invert_x) px = w - px;
    if (cal.invert_y) py = h - py;
    return { px, py };
  }

  /**
   * Convert image pixel (px, py) → world (wx, wy). Inverse of worldToPixel.
   */
  function pixelToWorld(px, py, cal) {
    if (!cal || !isValid(cal)) return { wx: px, wy: py };
    const w = cal.img_w || 1024;
    const h = cal.img_h || 1024;
    if (cal.invert_x) px = w - px;
    if (cal.invert_y) py = h - py;
    return {
      wx: px * cal.scale_x + cal.origin_x,
      wy: py * cal.scale_y + cal.origin_y,
    };
  }

  /**
   * Build a CalibrationConfig from manual inputs.
   * Returns a config object ready for MapRegistry.setCalibration().
   */
  function buildFromInputs({ origin_x, origin_y, scale_x, scale_y, invert_x, invert_y, axis_map, img_w, img_h }) {
    return {
      origin_x: Number(origin_x) || 0,
      origin_y: Number(origin_y) || 0,
      scale_x:  Math.abs(Number(scale_x)) || 1,
      scale_y:  Math.abs(Number(scale_y)) || 1,
      invert_x: !!invert_x,
      invert_y: !!invert_y,
      axis_map: axis_map || 'xy',
      img_w:    img_w || 1024,
      img_h:    img_h || 1024,
      ref_points: [],
    };
  }

  /**
   * Solve a CalibrationConfig from 2+ reference points.
   * Each refPoint: { px, py, wx, wy }
   * Returns null if fewer than 2 points or degenerate geometry.
   */
  function solveFromRefPoints(refPoints, img_w = 1024, img_h = 1024) {
    if (refPoints.length < 2) return null;

    // Use the first two points to compute scale + origin
    const [p1, p2] = refPoints;
    const dpx = p2.px - p1.px;
    const dpy = p2.py - p1.py;
    const dwx = p2.wx - p1.wx;
    const dwy = p2.wy - p1.wy;

    if (Math.abs(dpx) < 1 || Math.abs(dpy) < 1) return null; // degenerate

    const scale_x  = dwx / dpx;
    const scale_y  = dwy / dpy;
    const invert_x = scale_x < 0;
    const invert_y = scale_y < 0;

    // Compute origin so p1 maps correctly
    // worldToPixel: px = (wx - origin_x) / scale_x  [then flip if invert]
    // We want: p1.px (pre-flip) = (p1.wx - origin_x) / scale_x
    // → origin_x = p1.wx - p1.px_pre_flip * scale_x
    let p1px_pre = p1.px;
    let p1py_pre = p1.py;
    if (invert_x) p1px_pre = img_w - p1.px;
    if (invert_y) p1py_pre = img_h - p1.py;

    const origin_x = p1.wx - p1px_pre * scale_x;
    const origin_y = p1.wy - p1py_pre * scale_y;

    return {
      origin_x,
      origin_y,
      scale_x:  Math.abs(scale_x),
      scale_y:  Math.abs(scale_y),
      invert_x,
      invert_y,
      axis_map: 'xy',
      img_w,
      img_h,
      ref_points: [...refPoints],
    };
  }

  function isValid(cal) {
    return cal && cal.scale_x > 0 && cal.scale_y > 0;
  }

  return { worldToPixel, pixelToWorld, buildFromInputs, solveFromRefPoints, isValid };
})();
