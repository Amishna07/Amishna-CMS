'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const source = readFileSync(join(__dirname, '../public/dashboard.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function harness({ saveResult = true } = {}) {
  const state = {
    clients: [{ id: 'client', name: 'Test client', files: [{ id: 'link', name: 'Source link', url: 'https://example.com/workbook' }] }],
    projects: [{ id: 'project', title: 'Test series', clientId: 'client' }],
    works: [{ id: 'song', title: 'City Dreams', artistIds: ['artist'] }],
    artists: [{ id: 'artist', name: 'Test artist' }],
    cues: [{ id: 'cue', projectId: 'project', workId: 'song', importId: 'IMP-first', duration: 20 }],
    deletedCues: [{ cue: { id: 'deleted-cue', importId: 'IMP-first', workId: 'song' } }],
    imports: [
      { id: 'IMP-first', filename: 'series.xlsx', sheet: 'Episode 1', clientId: 'client', projectId: 'project', count: 1, date: '2026-10-10T10:00:00Z' },
      { id: 'IMP-second', filename: 'series.xlsx', sheet: 'Episode 2', clientId: 'client', projectId: 'project', count: 2, date: '2026-10-10T11:00:00Z' },
    ],
    exports: [{ id: 'export', filename: 'delivery.xlsx', clientId: 'client', projectId: 'project' }],
    repositories: [],
    activity: [{ text: 'Existing activity', date: '2026-10-10T09:00:00Z' }],
    preferences: { googleSheets: [{ id: 'sheet', projectId: 'project', url: 'https://docs.google.com/spreadsheets/d/test/edit' }] },
  };
  const calls = { saves: 0, closes: 0, renders: 0, messages: [], modal: '' };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const ctx = {
    state: () => state, esc, icon: () => '', options: () => '', badge: value => esc(value),
    date: value => value, toast: value => calls.messages.push(value),
    save: () => { calls.saves++; return saveResult; },
    modal: value => { calls.modal = value; }, modalHead: value => `<h2>${esc(value)}</h2>`,
    close: () => { calls.closes++; }, render: () => { calls.renders++; },
  };
  const context = { structuredClone, URL, state, esc, icon: ctx.icon, badge: ctx.badge, date: ctx.date, importHistoryPage: 1,
    projectName: id => state.projects.find(project => project.id === id)?.title || 'Unlinked project', empty: () => '' };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('/* management.js */'), source.indexOf('/* discovery.js */')), context);
  vm.runInContext(source.slice(source.indexOf('function importHistory()'), source.indexOf('function exportScope()')), context);
  const api = context.createManagementUX(ctx);
  const click = (action, id) => {
    const button = { dataset: { mx: action, id } };
    const event = { target: { closest: () => button }, preventDefault() { this.prevented = true; } };
    assert.equal(api.click(event), true);
    assert.equal(event.prevented, true);
  };
  return { state, calls, api, click, importHistory: context.importHistory, context };
}

test('import history pages large batches without rendering every record', () => {
  const h = harness();
  h.state.imports = Array.from({ length: 225 }, (_, index) => ({ ...h.state.imports[0], id: 'IMP-' + index, sheet: 'Episode ' + index }));
  const first = h.importHistory();
  assert.equal((first.match(/data-mx="import-delete"/g) || []).length, 100);
  assert.match(first, /1–100 of 225 imports/);
  h.context.importHistoryPage = 3;
  const last = h.importHistory();
  assert.equal((last.match(/data-mx="import-delete"/g) || []).length, 25);
  assert.match(last, /201–225 of 225 imports/);
});

test('client references, repository imports and import history expose deletion by record ID', () => {
  const h = harness();
  for (const html of [h.api.clients(), h.api.repositories(), h.importHistory()]) {
    assert.equal((html.match(/data-mx="import-delete"/g) || []).length, 2);
    assert.match(html, /data-mx="import-delete" data-id="IMP-first"/);
    assert.match(html, /data-mx="import-delete" data-id="IMP-second"/);
    assert.match(html, /Episode 1/);
    assert.match(html, /Episode 2/);
  }
});

test('confirmed deletion removes only the selected history record and preserves imported content', () => {
  const h = harness(), before = structuredClone(h.state);
  h.click('import-delete', 'IMP-first');
  assert.deepEqual(h.state, before, 'opening confirmation must not change data');
  assert.equal(h.calls.saves, 0);
  assert.match(h.calls.modal, /Only this import history record will be removed/);
  assert.match(h.calls.modal, /Songs, music cues, projects and linked Google Sheets will stay unchanged/);
  assert.match(h.calls.modal, /data-mx="confirm-import-delete" data-id="IMP-first"/);
  h.click('confirm-import-delete', 'IMP-first');
  assert.deepEqual(plain(h.state.imports), [before.imports[1]], 'same-name records must be distinguished by ID');
  for (const key of Object.keys(before).filter(key => !['imports', 'activity'].includes(key))) {
    assert.deepEqual(plain(h.state[key]), before[key], `${key} must remain unchanged`);
  }
  assert.equal(h.calls.saves, 1);
  assert.equal(h.calls.closes, 1);
  assert.equal(h.calls.renders, 1);
  assert.equal(h.state.activity.length, before.activity.length + 1);
  assert.equal(h.api.repositoryRecords().find(item => item.id === 'system-imports').items.length, 1);
  assert.doesNotMatch(h.api.clients(), /data-mx="import-delete" data-id="IMP-first"/);
  assert.doesNotMatch(h.importHistory(), /data-mx="import-delete" data-id="IMP-first"/);
});

test('a failed save restores the import history and activity without closing the confirmation', () => {
  const h = harness({ saveResult: false }), before = structuredClone(h.state);
  h.click('import-delete', 'IMP-first');
  h.click('confirm-import-delete', 'IMP-first');
  assert.deepEqual(plain(h.state), before);
  assert.equal(h.calls.saves, 1);
  assert.equal(h.calls.closes, 0);
  assert.equal(h.calls.renders, 0);
  assert.match(h.calls.messages.at(-1), /could not be deleted.*history is unchanged/);
});
