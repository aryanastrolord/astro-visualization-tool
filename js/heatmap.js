// ============================================================
// heatmap.js — Canvas density heatmap renderer
// ============================================================
window.Heatmap = (() => {
  const GRID = 96; // grid cells per axis (over 1024×1024 virtual space)

  /** Build a density grid from {px, py} points (px/py in 0–1024 range). */
  function buildGrid(points) {
    const grid = new Float32Array(GRID * GRID);
    for (const pt of points) {
      const gx = Math.floor((pt.px / 1024) * GRID);
      const gy = Math.floor((pt.py / 1024) * GRID);
      if (gx >= 0 && gx < GRID && gy >= 0 && gy < GRID) {
        grid[gy * GRID + gx] += 1;
      }
    }
    return grid;
  }

  /** 2-pass 5×5 box blur on the grid. */
  function gaussianBlur(grid, passes = 2) {
    let src = new Float32Array(grid);
    let dst = new Float32Array(GRID * GRID);
    for (let pass = 0; pass < passes; pass++) {
      for (let y = 0; y < GRID; y++) {
        for (let x = 0; x < GRID; x++) {
          let sum = 0, count = 0;
          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              const nx = x + dx, ny = y + dy;
              if (nx >= 0 && nx < GRID && ny >= 0 && ny < GRID) {
                sum += src[ny * GRID + nx]; count++;
              }
            }
          }
          dst[y * GRID + x] = sum / count;
        }
      }
      src = new Float32Array(dst);
    }
    return src;
  }

  /** Map normalized value [0,1] → RGBA (blue → cyan → green → yellow → red). */
  function valueToColor(t, alpha) {
    t = Math.max(0, Math.min(1, t));
    let r, g, b;
    if      (t < 0.25) { const s = t / 0.25;        r = 0;            g = Math.round(s * 200);          b = 255; }
    else if (t < 0.50) { const s = (t - 0.25) / 0.25; r = 0;          g = Math.round(200 + s * 55);    b = Math.round(255 * (1 - s)); }
    else if (t < 0.75) { const s = (t - 0.50) / 0.25; r = Math.round(255 * s); g = 255;                b = 0; }
    else               { const s = (t - 0.75) / 0.25; r = 255;        g = Math.round(255 * (1 - s));   b = 0; }
    return [r, g, b, Math.round(alpha * 255)];
  }

  /** Render density grid into an ImageData (1024×1024). */
  function renderToImageData(grid, intensity = 0.7, imageData) {
    const blurred = gaussianBlur(grid);
    let maxVal = 0;
    for (let i = 0; i < blurred.length; i++) if (blurred[i] > maxVal) maxVal = blurred[i];
    if (maxVal === 0) return;

    const data   = imageData.data;
    const cellW  = 1024 / GRID;
    const cellH  = 1024 / GRID;

    for (let gy = 0; gy < GRID; gy++) {
      for (let gx = 0; gx < GRID; gx++) {
        const val = blurred[gy * GRID + gx] / maxVal;
        if (val < 0.02) continue;
        const [r, g, b, a] = valueToColor(val, val * intensity);
        const px0 = Math.floor(gx * cellW), py0 = Math.floor(gy * cellH);
        const px1 = Math.floor((gx + 1) * cellW), py1 = Math.floor((gy + 1) * cellH);
        for (let py = py0; py < py1; py++) {
          for (let px = px0; px < px1; px++) {
            const idx  = (py * 1024 + px) * 4;
            const srcA = a / 255, dstA = data[idx + 3] / 255;
            const outA = srcA + dstA * (1 - srcA);
            if (outA > 0) {
              data[idx]     = Math.round((r * srcA + data[idx]     * dstA * (1 - srcA)) / outA);
              data[idx + 1] = Math.round((g * srcA + data[idx + 1] * dstA * (1 - srcA)) / outA);
              data[idx + 2] = Math.round((b * srcA + data[idx + 2] * dstA * (1 - srcA)) / outA);
              data[idx + 3] = Math.round(outA * 255);
            }
          }
        }
      }
    }
  }

  /**
   * Full pipeline: take events (with px, py already in 0–1024 space),
   * build density grid, render to OffscreenCanvas, return ImageBitmap.
   *
   * @param {object[]} events  — must have .px, .py (0–1024) and .timestamp
   * @param {number}   intensity — 0.0–1.0
   * @param {number}   tsUpTo  — events with timestamp > tsUpTo are excluded
   */
  async function generate(events, intensity = 0.7, tsUpTo = Infinity) {
    const filtered = events.filter(e => e.timestamp <= tsUpTo && e.px != null && e.py != null);
    if (filtered.length === 0) return null;

    const grid      = buildGrid(filtered);
    const offscreen = new OffscreenCanvas(1024, 1024);
    const ctx       = offscreen.getContext('2d');
    const imgData   = ctx.createImageData(1024, 1024);
    renderToImageData(grid, intensity, imgData);
    ctx.putImageData(imgData, 0, 0);
    return offscreen.transferToImageBitmap();
  }

  return { generate, buildGrid, renderToImageData };
})();
