(function (root) {
  'use strict';
  const DAYS = 7, RETENTION_MS = DAYS * 24 * 60 * 60 * 1000;

  // Expire history by the time it was imported/exported, never by an episode's
  // production date. Records without a usable timestamp are kept.
  function prune(workspace, now = Date.now()) {
    const removed = { imports: 0, exports: 0, total: 0 };
    if (!workspace || !Number.isFinite(now)) return removed;
    const cutoff = now - RETENTION_MS;
    for (const key of ['imports', 'exports']) {
      if (!Array.isArray(workspace[key])) continue;
      const records = workspace[key];
      const kept = records.filter(record => {
        const timestamp = typeof record?.date === 'string' && record.date.trim() ? Date.parse(record.date) : NaN;
        return !Number.isFinite(timestamp) || timestamp > cutoff;
      });
      removed[key] = records.length - kept.length;
      if (removed[key]) workspace[key] = kept;
      removed.total += removed[key];
    }
    return removed;
  }

  const api = { DAYS, RETENTION_MS, prune };
  root.CueHistoryRetention = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis === 'object' ? globalThis : this);
