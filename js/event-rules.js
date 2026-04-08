// ============================================================
// event-rules.js — Per-event-type rendering rule registry
// ============================================================
window.EventRules = (() => {
  const _rules = new Map(); // event_type → EventRule
  const _listeners = [];

  // Ordered pattern matching for default color + render mode
  const _DEFAULTS = [
    { match: ['botposition'],                          color: '#f59e0b', modes: ['path'] },
    { match: ['position', 'move', 'walk', 'run', 'loc', 'coord'], color: '#06b6d4', modes: ['path'] },
    { match: ['botkill', 'botkilled'],                 color: '#f97316', modes: ['point'] },
    { match: ['killedbystorm', 'storm'],               color: '#3b82f6', modes: ['point'] },
    { match: ['kill'],                                 color: '#ef4444', modes: ['point'] },
    { match: ['killed', 'death', 'die', 'dead'],       color: '#991b1b', modes: ['point'] },
    { match: ['loot', 'item', 'pickup', 'collect'],    color: '#eab308', modes: ['point'] },
    { match: ['damage', 'hit', 'hurt'],                color: '#f97316', modes: ['point'] },
    { match: ['spawn', 'respawn', 'born'],             color: '#16a34a', modes: ['point'] },
    { match: ['interact', 'use', 'open'],              color: '#8b5cf6', modes: ['point'] },
    { match: ['chat', 'message', 'say'],               color: '#64748b', modes: ['point'] },
  ];

  function generateDefault(event_type) {
    const lower = event_type.toLowerCase().replace(/[^a-z]/g, '');
    for (const d of _DEFAULTS) {
      if (d.match.some(m => lower.includes(m))) {
        return _makeRule(event_type, d.color, [...d.modes]);
      }
    }
    return _makeRule(event_type, '#6b7280', ['point']);
  }

  function _makeRule(event_type, color, render_modes) {
    return { event_type, render_modes, color, icon: null, label: null, line_width: 2, visible: true };
  }

  // ── Public API ────────────────────────────────────────────

  /** Ensure a rule exists for event_type; create default if missing. */
  function ensureRule(event_type) {
    if (!_rules.has(event_type)) {
      _rules.set(event_type, generateDefault(event_type));
    }
    return _rules.get(event_type);
  }

  /** Ensure rules exist for all types in an iterable; emits once if any added. */
  function ensureRulesForTypes(eventTypes) {
    let added = false;
    for (const t of eventTypes) {
      if (!_rules.has(t)) { _rules.set(t, generateDefault(t)); added = true; }
    }
    if (added) _emit();
  }

  /** Persist a user-edited rule. */
  function setRule(rule) {
    _rules.set(rule.event_type, { ..._rules.get(rule.event_type), ...rule });
    _emit();
  }

  /** Get rule for a type (returns generated default if not registered). */
  function getRule(event_type) {
    return _rules.get(event_type) || generateDefault(event_type);
  }

  function getAllRules() { return Array.from(_rules.values()); }

  function clear() { _rules.clear(); _emit(); }

  function onChange(fn) { _listeners.push(fn); }
  function _emit()      { _listeners.forEach(fn => fn(getAllRules())); }

  return { ensureRule, ensureRulesForTypes, setRule, getRule, getAllRules, generateDefault, clear, onChange };
})();
