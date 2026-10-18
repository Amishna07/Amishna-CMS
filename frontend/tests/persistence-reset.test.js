'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../public/dashboard.js'), 'utf8');
const block = source.slice(source.indexOf('/* persistence.js */'), source.indexOf('/* catalog.js */'));
const key = 'test-workspace';
const resetId = 'requested-reset';
const workspace = () => ({ version: 1, works: [], projects: [], cues: [], clients: [], imports: [], exports: [], profiles: [], activity: [] });

function harness(cached, remote, marker) {
  const values = new Map([
    [key, JSON.stringify(cached)],
    [key + ':sync', JSON.stringify({ version: 1, baseRevision: 5, pending: false })],
    [key + ':backups', JSON.stringify([{ raw: JSON.stringify(cached) }])],
    ['unrelated-theme', 'dark'],
  ]);
  if (marker) values.set(key + ':reset-id', marker);
  const ctx = vm.createContext({
    AbortController, setTimeout, clearTimeout,
    location: { protocol: 'https:', hostname: 'cms.example' },
  });
  vm.runInContext(block, ctx);
  const store = ctx.CuePersistence.create({
    key, resetId, pollMs: 0, retryMs: 0,
    storage: {
      getItem: name => values.get(name) ?? null,
      setItem: (name, value) => values.set(name, value),
      removeItem: name => values.delete(name),
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ workspace: remote, revision: remote ? 5 : 0 }) }),
  });
  return { store, values };
}

test('a requested reset removes cached records, sync state and recovery backups before opening a blank database', async () => {
  const old = workspace();
  old.imports.push({ id: 'old-import', filename: 'Old.xlsx' });
  old.works.push({ id: 'old-song', title: 'Old song' });
  const { store, values } = harness(old, null);
  try {
    const loaded = await store.load(workspace);
    assert.equal(loaded.imports.length, 0);
    assert.equal(loaded.works.length, 0);
    assert.equal(JSON.parse(values.get(key + ':sync')).baseRevision, 0);
    assert.equal(values.has(key + ':backups'), false);
    assert.equal(values.get(key + ':reset-id'), resetId);
    assert.equal(values.get('unrelated-theme'), 'dark');
  } finally { store.destroy(); }
});

test('the same reset ID preserves new records and backups on later reloads', async () => {
  const current = workspace();
  current.works.push({ id: 'new-song', title: 'New song' });
  const { store, values } = harness(current, current, resetId);
  try {
    const loaded = await store.load(workspace);
    assert.equal(loaded.works[0].id, 'new-song');
    assert.equal(values.has(key + ':backups'), true);
    assert.equal(store.getStatus().kind, 'synced');
  } finally { store.destroy(); }
});
