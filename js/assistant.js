// ============================================================
// assistant.js — Astro AI assistant (NLP pattern matching)
// ============================================================
window.Assistant = (() => {
  const SUGGESTIONS = [
    'Show paths',
    'Show heatmap',
    'Hide points',
    'Play timeline',
    'Pause',
    'Reset view',
  ];

  const history = [];
  let _actionCallback = null;

  function init(callback) {
    _actionCallback = callback;
  }

  function getSuggestions() { return [...SUGGESTIONS]; }
  function getHistory() { return [...history]; }

  /**
   * Process user input and return an AI response + action.
   */
  function processInput(text) {
    const lower = text.toLowerCase().trim();
    const actions = [];
    let response = '';

    // ── Layer commands ─────────────────────────────────────

    if (_match(lower, ['show path', 'enable path', 'draw path', 'show route', 'show movement', 'show paths'])) {
      actions.push({ type: 'layer', key: 'paths', value: true });
      response = 'Paths enabled. Movement routes are now visible on the map.';
    }
    else if (_match(lower, ['hide path', 'disable path', 'remove path', 'hide paths'])) {
      actions.push({ type: 'layer', key: 'paths', value: false });
      response = 'Paths hidden.';
    }
    else if (_match(lower, ['show point', 'enable point', 'show marker', 'show markers', 'show events', 'show points'])) {
      actions.push({ type: 'layer', key: 'points', value: true });
      response = 'Event markers enabled.';
    }
    else if (_match(lower, ['hide point', 'disable point', 'hide marker', 'hide markers', 'hide points'])) {
      actions.push({ type: 'layer', key: 'points', value: false });
      response = 'Event markers hidden.';
    }

    // ── Heatmap commands ───────────────────────────────────

    else if (_match(lower, ['show heatmap', 'enable heatmap', 'heatmap on', 'show heat'])) {
      actions.push({ type: 'layer', key: 'heatmap', value: true });
      response = 'Heatmap enabled. Hot zones show spatial density of events.';
    }
    else if (_match(lower, ['hide heatmap', 'disable heatmap', 'clear heatmap', 'no heatmap', 'remove heatmap', 'heatmap off'])) {
      actions.push({ type: 'layer', key: 'heatmap', value: false });
      response = 'Heatmap hidden.';
    }

    // ── Playback commands ──────────────────────────────────

    else if (_match(lower, ['play', 'start playback', 'start timeline', 'begin'])) {
      actions.push({ type: 'playback', action: 'play' });
      response = '▶ Starting timeline playback...';
    }
    else if (_match(lower, ['pause', 'stop playback', 'freeze'])) {
      actions.push({ type: 'playback', action: 'pause' });
      response = '⏸ Playback paused.';
    }
    else if (_match(lower, ['reset', 'restart', 'go to start', 'beginning'])) {
      actions.push({ type: 'playback', action: 'stop' });
      response = '⏮ Reset to beginning.';
    }
    else if (_match(lower, ['speed 2', '2x', 'double speed'])) {
      actions.push({ type: 'speed', value: 2 });
      response = 'Playback speed set to 2×.';
    }
    else if (_match(lower, ['speed 4', '4x', 'quad'])) {
      actions.push({ type: 'speed', value: 4 });
      response = 'Playback speed set to 4×.';
    }
    else if (_match(lower, ['speed 1', '1x', 'normal speed', 'slow down'])) {
      actions.push({ type: 'speed', value: 1 });
      response = 'Normal playback speed (1×).';
    }

    // ── View commands ──────────────────────────────────────

    else if (_match(lower, ['reset view', 'fit map', 'zoom fit', 'zoom out', 'show full map'])) {
      actions.push({ type: 'resetView' });
      response = 'Map view reset to fit.';
    }
    else if (_match(lower, ['clear filter', 'reset filter', 'show everything', 'all filter'])) {
      actions.push({ type: 'clearFilters' });
      response = 'All filters cleared.';
    }

    // ── Combo commands ─────────────────────────────────────

    else if (_match(lower, ['show everything on', 'all layers', 'enable all', 'show all layer'])) {
      ['paths', 'points', 'heatmap'].forEach(k =>
        actions.push({ type: 'layer', key: k, value: true }));
      response = 'All layers enabled.';
    }
    else if (_match(lower, ['clear all', 'hide all', 'disable all layer', 'clean map'])) {
      ['paths', 'points', 'heatmap'].forEach(k =>
        actions.push({ type: 'layer', key: k, value: false }));
      response = 'All layers hidden. Clean map.';
    }

    // ── Help ───────────────────────────────────────────────

    else if (_match(lower, ['help', 'what can you do', 'commands', 'how to'])) {
      response = `I can help you with:\n• **Layers**: "show paths", "hide points", "show heatmap"\n• **Playback**: "play", "pause", "reset", "2x speed"\n• **View**: "reset view", "clear filters", "all layers", "clean map"`;
    }

    else {
      response = `I didn't quite get that. Try something like:\n"show kill heatmap", "play timeline", "humans only", or "type help" for all commands.`;
    }

    // Record in history
    const entry = { role: 'user', text, ts: Date.now() };
    const reply = { role: 'assistant', text: response, actions, ts: Date.now() };
    history.push(entry, reply);

    // Execute actions
    if (_actionCallback && actions.length > 0) {
      _actionCallback(actions);
    }

    return { response, actions };
  }

  function _match(input, patterns) {
    return patterns.some(p => input.includes(p));
  }

  return { init, processInput, getSuggestions, getHistory };
})();
