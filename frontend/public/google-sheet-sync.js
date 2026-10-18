'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.GoogleSheetSync = api;
})(typeof globalThis === 'object' ? globalThis : this, function createGoogleSheetSync() {
  function parseUrl(input) {
    let parsed;
    try { parsed = new URL(String(input ?? '').trim()); }
    catch (_) { throw new Error('Enter a valid Google Sheets share link.'); }
    if (parsed.protocol !== 'https:' || parsed.host !== 'docs.google.com' || parsed.username || parsed.password) {
      throw new Error('Use an HTTPS link from docs.google.com.');
    }
    const match = parsed.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]{1,256})(?:\/(?:edit|view|preview))?\/?$/);
    if (!match) throw new Error('Use a Google Sheets share link in /spreadsheets/d/ format.');
    const keys = parsed.searchParams.getAll('resourcekey');
    if (keys.length > 1 || (keys.length && !/^[A-Za-z0-9_-]{1,256}$/.test(keys[0]))) {
      throw new Error('The Google Sheets resource key is invalid.');
    }
    const id = match[1];
    const url = `https://docs.google.com/spreadsheets/d/${id}/edit${keys.length ? `?resourcekey=${encodeURIComponent(keys[0])}` : ''}`;
    return { id, url };
  }

  function replaceManagedOccurrences(workspace, sheetId, { preserveTabs = new Set() } = {}) {
    if (!workspace || !Array.isArray(workspace.cues)) throw new TypeError('A workspace with cues is required.');
    if (typeof sheetId !== 'string' || !sheetId) throw new TypeError('A Google Sheet ID is required.');
    // A Set created inside the dashboard's VM test realm is still a valid Set.
    if (Object.prototype.toString.call(preserveTabs) !== '[object Set]') throw new TypeError('preserveTabs must be a Set.');

    let removedCount = 0;
    const keptCues = [];
    for (const cue of workspace.cues) {
      if (!Array.isArray(cue.occurrences) || !cue.occurrences.length) {
        keptCues.push(cue);
        continue;
      }
      const removed = [], kept = [];
      for (const occurrence of cue.occurrences) {
        if (occurrence?.googleSheetId === sheetId && !preserveTabs.has(occurrence.googleSheetTab)) removed.push(occurrence);
        else kept.push(occurrence);
      }
      if (!removed.length) {
        keptCues.push(cue);
        continue;
      }
      removedCount += removed.length;
      if (!kept.length) continue;

      cue.occurrences = kept;
      cue.duration = kept.reduce((sum, occurrence) => sum + (Number(occurrence.duration) || 0), 0);
      cue.usageCount = kept.length;
      cue.start = kept.length === 1 ? kept[0].start ?? null : null;
      cue.end = kept.length === 1 ? kept[0].end ?? null : null;

      // The importer also checks these cue-level keys for duplicates. Do not
      // leave a key pointing to a row that will be replaced on this refresh.
      for (const key of ['importSourceKey', 'importFingerprint']) {
        if (removed.some(occurrence => occurrence[key] != null && occurrence[key] === cue[key])) {
          const replacement = kept.find(occurrence => occurrence[key] != null)?.[key];
          if (replacement == null) delete cue[key];
          else cue[key] = replacement;
        }
      }
      keptCues.push(cue);
    }
    workspace.cues = keptCues;
    return removedCount;
  }

  return { parseUrl, replaceManagedOccurrences };
});
