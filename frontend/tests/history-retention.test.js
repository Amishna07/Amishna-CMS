'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const retention = require('../public/history-retention');
const { applyChanges } = require('../../backend/src/workspace-changes');
const source = readFileSync(join(__dirname, '../public/dashboard.js'), 'utf8');
const NOW = Date.parse('2026-10-17T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const date = daysAgo => new Date(NOW - daysAgo * DAY).toISOString();
const plain = value => JSON.parse(JSON.stringify(value));

function workspace() {
  const song = { id: 'song', title: 'Keep song', parties: [{ name: 'Composer', role: 'Composer', share: 100 }] };
  return { version: 1,
    works: [song], artists: [{ id: 'artist', name: 'Keep artist' }],
    projects: [{ id: 'project', title: 'Keep series', type: 'Series', episodes: [{ number: 1 }] }],
    cues: [{ id: 'cue', projectId: 'project', episode: 1, workId: 'song', importId: 'old-import', duration: 10,
      occurrences: [{ googleSheetId: 'linked-sheet', googleSheetTab: 'Episode 1', duration: 10 }] }],
    clients: [], profiles: [], activity: [{ text: 'Keep activity', date: date(30) }],
    imports: [{ id: 'old-import', date: date(8) }, { id: 'recent-import', date: date(1), workfileMetadata: { date: '2 Jan 2023' } }],
    exports: [{ id: 'old-export', date: date(8), snapshot: { works: [song], padding: 'x'.repeat(100000) } },
      { id: 'recent-export', date: date(1), snapshot: { works: [song] } }],
    preferences: { googleSheets: [{ id: 'linked-sheet', projectId: 'project', tabBaselines: [{ tab: 'Episode 1' }] }] }
  };
}

test('history expires at exactly seven elapsed days, with recent, future and undated records kept', () => {
  const value = { imports: [
    { id: 'before', date: new Date(NOW - 7 * DAY + 1).toISOString() },
    { id: 'boundary', date: date(7) }, { id: 'older', date: date(20) },
    { id: 'future', date: date(-1) }, { id: 'unknown' }, { id: 'invalid', date: 'not-a-date' },
    { id: 'blank', date: '' }, { id: 'numeric', date: 1 }
  ], exports: [{ id: 'timezone-boundary', date: '2026-10-10T17:30:00+05:30', snapshot: { notes: 'expired' } }] };
  assert.deepEqual(retention.prune(value, NOW), { imports: 2, exports: 1, total: 3 });
  assert.deepEqual(value.imports.map(item => item.id), ['before', 'future', 'unknown', 'invalid', 'blank', 'numeric']);
  assert.deepEqual(value.exports, []);
});

test('cleanup releases expired snapshots while preserving all production data and linked-sheet metadata', () => {
  const value = workspace(), before = structuredClone(value), size = JSON.stringify(value).length;
  const song = value.works[0], recentSnapshot = value.exports[1].snapshot;
  assert.deepEqual(retention.prune(value, NOW), { imports: 1, exports: 1, total: 2 });
  assert.deepEqual(value.imports.map(item => item.id), ['recent-import']);
  assert.deepEqual(value.exports.map(item => item.id), ['recent-export']);
  assert.ok(JSON.stringify(value).length < size - 100000);
  assert.equal(value.works[0], song);
  assert.equal(value.exports[0].snapshot, recentSnapshot);
  for (const key of Object.keys(before).filter(key => !['imports', 'exports'].includes(key))) assert.deepEqual(value[key], before[key], key);
  const imports = value.imports, exports = value.exports;
  assert.deepEqual(retention.prune(value, NOW), { imports: 0, exports: 0, total: 0 });
  assert.equal(value.imports, imports);
  assert.equal(value.exports, exports);
});

function cleanupHarness({ saveResult = true, ...flags } = {}) {
  let saves = 0, renders = 0, saved = null;
  const ctx = vm.createContext({ state: workspace(), workspaceClosed: false, modalDraft: false,
    bulkImportActive: false, bulkImportPending: null, googleSheetBusy: false, restoreBackupBusy: false,
    UI: { hasDraft: () => false }, ExportDialog: { isBusy: () => false },
    persistence: { getStatus: () => ({ kind: 'synced', draft: false }) },
    CueHistoryRetention: { prune: value => retention.prune(value, NOW) },
    document: { querySelector: () => null, activeElement: { matches: () => false } },
    save: () => { saves++; if (saveResult) saved = plain(ctx.state); return saveResult; },
    renderPage: () => { renders++; }, ...flags });
  const start = source.indexOf('function cleanupExpiredHistory(');
  vm.runInContext(source.slice(start, source.indexOf('function commit(', start)), ctx);
  return { ctx, saves: () => saves, renders: () => renders, saved: () => saved };
}

test('automatic cleanup persists the smaller workspace once and does no work when nothing has expired', () => {
  const h = cleanupHarness();
  assert.equal(h.ctx.cleanupExpiredHistory(), true);
  assert.equal(h.saves(), 1);
  assert.equal(h.renders(), 1);
  assert.deepEqual(h.saved().imports.map(item => item.id), ['recent-import']);
  assert.deepEqual(h.saved().exports.map(item => item.id), ['recent-export']);
  assert.equal(h.ctx.cleanupExpiredHistory(), false);
  assert.equal(h.saves(), 1);
});

test('failed device storage keeps the original history and snapshots for a later retry', () => {
  const h = cleanupHarness({ saveResult: false }), before = plain(h.ctx.state);
  assert.equal(h.ctx.cleanupExpiredHistory(), false);
  assert.equal(h.saves(), 1);
  assert.equal(h.renders(), 0);
  assert.deepEqual(plain(h.ctx.state), before);
});

test('normal saves also prune expired history, including records restored from an old backup', () => {
  let saved;
  const ctx = vm.createContext({ state: workspace(), workspaceClosed: false, dataRevision: 0, lookupState: null,
    storageError: false, modalDraft: false, UI: { hasDraft: () => false }, queueMicrotask: () => {},
    CueHistoryRetention: { prune: value => retention.prune(value, NOW) },
    CueCatalog: { ensure() {} }, D: { applyTitleUsage() {} },
    persistence: { save: value => { saved = plain(value); return true; } } });
  const start = source.indexOf('function save(){if(workspaceClosed');
  vm.runInContext(source.slice(start, source.indexOf('function cleanupExpiredHistory(', start)), ctx);
  assert.equal(ctx.save(), true);
  assert.deepEqual(saved.imports.map(item => item.id), ['recent-import']);
  assert.deepEqual(saved.exports.map(item => item.id), ['recent-export']);
  assert.equal(saved.cues.length, 1);
  assert.equal(saved.works.length, 1);
});

test('background cleanup waits for forms, batch reviews, restores and active exports', () => {
  for (const flags of [
    { workspaceClosed: true }, { modalDraft: true }, { UI: { hasDraft: () => true } },
    { bulkImportActive: true }, { bulkImportPending: {} }, { googleSheetBusy: true }, { restoreBackupBusy: true },
    { ExportDialog: { isBusy: () => true } },
    { persistence: { getStatus: () => ({ draft: true }) } },
    { persistence: { getStatus: () => ({ kind: 'conflict' }) } },
    { persistence: { getStatus: () => ({ kind: 'update-available' }) } },
    { document: { querySelector: () => ({}) } },
    { document: { querySelector: () => null, activeElement: { matches: () => true } } }
  ]) {
    const h = cleanupHarness(flags), before = plain(h.ctx.state);
    assert.equal(h.ctx.cleanupExpiredHistory(), false);
    assert.equal(h.saves(), 0);
    assert.deepEqual(plain(h.ctx.state), before);
  }
});

test('cleanup follows normal revision-checked sync, preserves recovery copies and reloads cleanly', async t => {
  let remote = { workspace: workspace(), revision: 5 }, writes = 0;
  const values = new Map([['history:backups', JSON.stringify([{ source: 'recovery', raw: JSON.stringify(remote.workspace) }])]]);
  const recovery = values.get('history:backups');
  const ctx = vm.createContext({ TextEncoder, AbortController, setTimeout, clearTimeout,
    location: { protocol: 'https:', hostname: 'cms.example' } });
  vm.runInContext(source.slice(source.indexOf('/* persistence.js */'), source.indexOf('/* catalog.js */')), ctx);
  const options = { key: 'history', pollMs: 0, retryMs: 0, debounceMs: 60000,
    storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    fetch: async (_url, request) => {
      if (request.method === 'PUT' || request.method === 'PATCH') {
        const body = JSON.parse(request.body);
        assert.equal(body.expectedRevision, remote.revision);
        remote = { workspace: request.method === 'PATCH' ? applyChanges(remote.workspace, body.changes) : body.workspace,
          revision: remote.revision + 1 };
        writes++;
      }
      return { ok: true, status: 200, json: async () => structuredClone(remote) };
    }
  };
  const store = ctx.CuePersistence.create(options);
  t.after(() => store.destroy());
  const current = await store.load(workspace);
  assert.equal(store.getStatus().kind, 'synced');
  retention.prune(current, NOW);
  assert.equal(store.save(current), true);
  assert.equal(await store.sync(), true);
  assert.equal(writes, 1);
  assert.equal(remote.revision, 6);
  assert.deepEqual(remote.workspace.imports.map(item => item.id), ['recent-import']);
  assert.deepEqual(remote.workspace.exports.map(item => item.id), ['recent-export']);
  assert.equal(remote.workspace.cues[0].importId, 'old-import');
  assert.equal(values.get('history:backups'), recovery);
  const reopened = ctx.CuePersistence.create(options);
  t.after(() => reopened.destroy());
  await reopened.load(workspace);
  assert.equal(reopened.getStatus().kind, 'synced');
  assert.equal(reopened.getStatus().pending, false);
});

test('the standalone browser module is available without a module loader', () => {
  const ctx = vm.createContext({});
  vm.runInContext(readFileSync(join(__dirname, '../public/history-retention.js'), 'utf8'), ctx);
  assert.equal(ctx.CueHistoryRetention.DAYS, 7);
  assert.equal(typeof ctx.CueHistoryRetention.prune, 'function');
});
