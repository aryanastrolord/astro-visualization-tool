// ============================================================
// playback.js — Timeline playback engine
// ============================================================
window.Playback = (() => {
  const state = {
    currentTs: 0,       // ms from match start
    minTs: 0,
    maxTs: 0,
    windowStart: 0,
    windowEnd: 0,
    speed: 1,           // 0.5 | 1 | 2 | 4 | 8
    autoSpeed: 1,       // auto-scale so animation ~25s; multiplied with speed
    playing: false,
    status: 'idle',     // 'idle' | 'playing' | 'paused' | 'ended'
  };

  let _rafId = null;
  let _lastRealTime = null;
  const _listeners = [];

  // ── Public State ──────────────────────────────────────────

  function getState() { return { ...state }; }

  function setRange(minTs, maxTs) {
    state.minTs = minTs;
    state.maxTs = maxTs;
    state.windowStart = minTs;
    state.windowEnd = maxTs;
    // Auto-scale: target ~25 seconds of real animation time regardless of data units.
    // e.g. if match spans 30 minutes (1800000ms), autoSpeed = 72 so animation = 25s.
    // This is the base; speed buttons multiply on top.
    const span = maxTs - minTs;
    state.autoSpeed = span > 0 ? Math.max(1, span / 25000) : 1;
    // Default: sit at the end so all data is visible
    state.currentTs = maxTs;
    state.status = 'idle';
    _emit('rangeSet');
  }

  function setWindow(startTs, endTs) {
    state.windowStart = Math.max(state.minTs, startTs);
    state.windowEnd = Math.min(state.maxTs, endTs);
    state.currentTs = Math.max(state.windowStart, Math.min(state.windowEnd, state.currentTs));
    _emit('windowSet');
  }

  function setSpeed(speed) {
    state.speed = speed;
    _emit('speedChanged');
  }

  function scrubTo(ts) {
    state.currentTs = Math.max(state.windowStart, Math.min(state.windowEnd, ts));
    _emit('scrub');
  }

  // ── Playback controls ─────────────────────────────────────

  function play() {
    console.log('[Playback] play() windowStart:', state.windowStart, 'windowEnd:', state.windowEnd, 'autoSpeed:', state.autoSpeed);
    if (state.windowEnd <= state.windowStart) {
      console.warn('[Playback] Cannot play: no time range set (windowEnd <= windowStart). durationMs may be 0 — check ETL logs above.');
      return;
    }
    // Resume from current position if paused; restart from beginning otherwise
    if (state.status !== 'paused') {
      state.currentTs = state.windowStart;
    }
    state.playing = true;
    state.status = 'playing';
    _lastRealTime = performance.now();
    _loop();
    _emit('play');
  }

  function pause() {
    state.playing = false;
    state.status = 'paused';
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
    _emit('pause');
  }

  function stop() {
    pause();
    state.currentTs = state.windowStart;
    state.status = 'idle';
    _emit('stop');
  }

  function toggle() {
    if (state.playing) pause(); else play();
  }

  function stepForward(ms = 500) {
    scrubTo(state.currentTs + ms);
    _emit('step');
  }

  function stepBackward(ms = 500) {
    scrubTo(state.currentTs - ms);
    _emit('step');
  }

  // ── Animation loop ────────────────────────────────────────

  function _loop() {
    if (!state.playing) return;
    const now = performance.now();
    const realElapsed = _lastRealTime ? now - _lastRealTime : 0;
    _lastRealTime = now;

    state.currentTs += realElapsed * (state.autoSpeed || 1) * state.speed;

    if (state.currentTs >= state.windowEnd) {
      state.currentTs = state.windowEnd;
      state.playing = false;
      state.status = 'ended';
      _emit('frame');
      _emit('ended');
      return;
    }

    _emit('frame');
    _rafId = requestAnimationFrame(_loop);
  }

  // ── Formatting helpers ────────────────────────────────────

  function formatMs(ms) {
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  function getProgress() {
    const range = state.windowEnd - state.windowStart;
    if (range === 0) return 0;
    return (state.currentTs - state.windowStart) / range;
  }

  // ── Event system ──────────────────────────────────────────

  function on(event, fn) {
    _listeners.push({ event, fn });
  }

  function _emit(event) {
    for (const l of _listeners) {
      if (l.event === event || l.event === '*') l.fn(state);
    }
  }

  return {
    getState, setRange, setWindow, setSpeed, scrubTo,
    play, pause, stop, toggle, stepForward, stepBackward,
    formatMs, getProgress, on,
  };
})();
