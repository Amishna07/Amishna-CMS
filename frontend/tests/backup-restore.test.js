'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');
const block = source.slice(source.indexOf('function parseWorkspaceBackup('), source.indexOf('function openProjectExport('));
function workspace(title = 'Original song') {
  return { version: 1, works: [{ id: 'WRK-1', title }], projects: [], cues: [], clients: [], imports: [], exports: [], profiles: [], activity: [], artists: [], preferences: { customOption: true } };
}
function harness({ saveResult = true, storageFails = false, dirty = false, flushResult = true, syncResult = true } = {}) {
  const storage = new Map(), events = [];
  const context = vm.createContext({
    TextEncoder, structuredClone, state: workspace(), KEY: 'test-workspace', page: 'settings', modalDraft: false, bulkImportActive: false, databaseActionBusy: false,
    workspaceClosed: false,
    UI: { hasDraft: () => dirty, flush: () => { events.push('flush'); return flushResult; } },
    persistence: { sync: async () => syncResult, getStatus: () => ({ kind: 'synced' }) },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => { if (storageFails) throw new Error('full'); storage.set(key, value); } },
    document: { querySelectorAll: () => [], querySelector: () => null },
    save: () => { events.push('save'); return saveResult; },
    toast: text => events.push(text), closeModal: () => true,
    history: { replaceState: () => events.push('route-settings') },
    location: { reload: () => events.push('reload') },
    setTimeout: callback => { callback(); return 1; },
    renderPage: () => events.push('render'),
    downloadBlob: (content, filename, type) => events.push({ content, filename, type }),
  });
  vm.runInContext(block, context);
  const stage = backup => {
    context.backupFixture = backup;
    vm.runInContext("restoreBackupPlan={workspace:backupFixture,filename:'fixture.json',currentRaw:JSON.stringify(state)};", context);
  };
  return { context, storage, events, stage };
}
const plain = value => JSON.parse(JSON.stringify(value));

test('backup parser preserves full metadata and rejects malformed or unsupported files', () => {
  const { context } = harness();
  const original = workspace();
  original.works[0].customMetadata = { percentages: [25, 75], identifier: '000123' };
  assert.deepEqual(plain(context.parseWorkspaceBackup('\uFEFF' + JSON.stringify(original))), original);
  assert.throws(() => context.parseWorkspaceBackup('{broken'), /valid JSON/);
  assert.throws(() => context.parseWorkspaceBackup(JSON.stringify({ ...original, version: 99 })), /supported/);
  assert.throws(() => context.parseWorkspaceBackup(JSON.stringify({ ...original, works: [null] })), /works/);
  assert.throws(() => context.parseWorkspaceBackup(JSON.stringify({ ...original, preferences: [] })), /preferences/);
  const nested = JSON.stringify(original).replace('"customOption":true', '"__proto__":{"polluted":true}');
  assert.throws(() => context.parseWorkspaceBackup(nested), /unsupported data property/);
  assert.equal({}.polluted, undefined);
});

test('restore preserves current workspace and does not save if recovery storage is unavailable', async () => {
  const { context, events, stage } = harness({ storageFails: true });
  const before = plain(context.state);
  stage(workspace('Replacement'));
  await context.restoreWorkspaceBackup();
  assert.deepEqual(plain(context.state), before);
  assert.equal(events.includes('save'), false);
  assert.equal(events.includes('reload'), false);
});

test('restore rolls back memory when the local workspace save fails', async () => {
  const { context, storage, events, stage } = harness({ saveResult: false });
  const before = plain(context.state);
  stage(workspace('Replacement'));
  await context.restoreWorkspaceBackup();
  assert.deepEqual(plain(context.state), before);
  const recovery = JSON.parse(storage.get('test-workspace:backups'))[0];
  assert.deepEqual(JSON.parse(recovery.raw), before);
  assert.equal(events.includes('reload'), false);
});

test('successful restoration saves replacement, preserves recovery and reinitializes views', async () => {
  const { context, storage, events, stage } = harness();
  const before = plain(context.state);
  stage(workspace('Replacement'));
  await context.restoreWorkspaceBackup();
  assert.equal(context.state.works[0].title, 'Replacement');
  assert.ok(context.state.preferences.lastRestoreAt);
  assert.match(context.state.activity[0].text, /Restored workspace backup/);
  assert.deepEqual(JSON.parse(JSON.parse(storage.get('test-workspace:backups'))[0].raw), before);
  assert.equal(events.includes('reload'), true);
});

test('unresolved builder edits block backup restore before any storage writes', async () => {
  const { context, storage, events, stage } = harness({ dirty: true, flushResult: false });
  stage(workspace('Replacement'));
  await context.restoreWorkspaceBackup();
  assert.equal(context.state.works[0].title, 'Original song');
  assert.equal(storage.size, 0);
  assert.equal(events.includes('save'), false);
  assert.equal(events.includes('flush'), true);
});

test('full backup download records its timestamp and contains the same complete state', () => {
  const { context, events } = harness();
  context.downloadWorkspaceBackup();
  const download = events.find(item => item && typeof item === 'object');
  assert.ok(context.state.preferences.lastBackupAt);
  assert.deepEqual(JSON.parse(download.content), plain(context.state));
  assert.match(download.filename, /^Amishna_Music_Backup_\d{4}-\d{2}-\d{2}\.json$/);
});

test('full backup remains downloadable when device storage refuses a save', () => {
  const { context, events } = harness({saveResult: false});
  const before = plain(context.state);
  context.downloadWorkspaceBackup();
  const download = events.find(item => item && typeof item === 'object');
  assert.deepEqual(JSON.parse(download.content), before);
  assert.deepEqual(plain(context.state), before);
  assert.match(events.at(-1), /Storage still needs attention/);
});

test('database download syncs first and downloads the dated SQLite snapshot', async () => {
  const { context, events } = harness();
  const calls = [];
  context.persistence.sync = async () => { calls.push('sync'); return true; };
  context.persistence.checkForUpdates = async () => { calls.push('check'); return true; };
  context.fetch = async (url, options) => {
    calls.push(options.method + ' ' + url);
    return { ok: true, headers: { get: name => name === 'X-Database-Backup-Name'
      ? 'Amishna_Database_2026-10-18_20-50-12-345.sqlite' : null }, blob: async () => ({ size: 128 }) };
  };
  await context.downloadDatabaseSnapshot();
  assert.deepEqual(calls, ['sync', 'check', 'POST /api/database/backup']);
  const download = events.find(item => item && typeof item === 'object');
  assert.equal(download.filename, 'Amishna_Database_2026-10-18_20-50-12-345.sqlite');
  assert.ok(events.some(item => typeof item === 'string' && /Database\/Amishna_Database_/.test(item)));
});

test('sync button refreshes counts and does not download a file', async () => {
  const { context, events } = harness();
  const calls = [];
  context.state.projects.push({ id: 'P', title: 'Series', type: 'Series', episodes: [{ number: 1 }, { number: 2 }] });
  context.persistence.sync = async () => { calls.push('sync'); return true; };
  context.persistence.checkForUpdates = async () => { calls.push('check'); return true; };
  assert.equal(await context.syncDatabaseAndEpisodes(), true);
  assert.deepEqual(calls, ['sync', 'check']);
  assert.ok(events.some(item => typeof item === 'string' && /2 episodes across 1 project\./.test(item)));
  assert.equal(events.some(item => item && typeof item === 'object'), false);
});
