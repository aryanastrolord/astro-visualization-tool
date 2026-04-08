// ============================================================
// filters.js — Universal filter state manager
// ============================================================
window.Filters = (() => {
  const state = {
    sessionIds:  [],        // [] = all sessions
    entityIds:   [],        // [] = all entities
    eventTypes:  new Set(), // empty = all event types visible
    dateFrom:    null,      // null = no lower bound (epoch ms, raw_timestamp space)
    dateTo:      null,      // null = no upper bound
  };

  function get() {
    return { ...state, eventTypes: new Set(state.eventTypes) };
  }

  function setSessions(ids) {
    state.sessionIds = Array.isArray(ids) ? [...ids] : [ids];
    _emit();
  }

  function setEntities(ids) {
    state.entityIds = Array.isArray(ids) ? [...ids] : [ids];
    _emit();
  }

  function toggleEventType(type, enabled) {
    if (enabled) state.eventTypes.add(type);
    else         state.eventTypes.delete(type);
    _emit();
  }

  function setEventTypes(types) {
    state.eventTypes = new Set(types);
    _emit();
  }

  /**
   * Set the real-world date/time range filter.
   * @param {number|null} fromMs - epoch ms, or null for no lower bound
   * @param {number|null} toMs   - epoch ms, or null for no upper bound
   */
  function setDateRange(fromMs, toMs) {
    state.dateFrom = (fromMs != null && isFinite(fromMs)) ? fromMs : null;
    state.dateTo   = (toMs   != null && isFinite(toMs))  ? toMs   : null;
    _emit();
  }

  function reset() {
    state.sessionIds = [];
    state.entityIds  = [];
    state.eventTypes = new Set();
    state.dateFrom   = null;
    state.dateTo     = null;
    _emit();
  }

  /**
   * Filter an event array. Filters stack with AND logic.
   * - dateFrom/dateTo: event.raw_timestamp must be within range (real calendar time)
   * - sessionIds: if set, event.session_id must be in the list
   * - entityIds:  if set, event.entity_id must be in the list
   * - eventTypes: if set, event.event_type must be in the set
   * - EventRules.visible = false hides events regardless
   */
  function applyToEvents(events) {
    const hasDateFrom = state.dateFrom != null;
    const hasDateTo   = state.dateTo   != null;
    return events.filter(ev => {
      if (hasDateFrom && ev.raw_timestamp < state.dateFrom)  return false;
      if (hasDateTo   && ev.raw_timestamp > state.dateTo)    return false;
      if (state.sessionIds.length > 0 && ev.session_id && !state.sessionIds.includes(ev.session_id)) return false;
      if (state.entityIds.length  > 0 && !state.entityIds.includes(ev.entity_id))  return false;
      if (state.eventTypes.size   > 0 && !state.eventTypes.has(ev.event_type))     return false;
      const rule = EventRules.getRule(ev.event_type);
      if (rule && !rule.visible) return false;
      return true;
    });
  }

  const _listeners = [];
  function onChange(fn) { _listeners.push(fn); }
  function _emit()      { _listeners.forEach(fn => fn(get())); }

  return { get, setSessions, setEntities, setDateRange, toggleEventType, setEventTypes, reset, applyToEvents, onChange };
})();
