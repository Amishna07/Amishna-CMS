'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { gunzipSync } = require('node:zlib');
const { randomBytes } = require('node:crypto');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../public/dashboard.js'), 'utf8');
const block = source.slice(source.indexOf('/* persistence.js */'), source.indexOf('/* catalog.js */'));
const workspace = () => ({ version: 1, works: [], projects: [], cues: [], clients: [], imports: [], exports: [], profiles: [], activity: [] });
function context(extra = {}) {
  const ctx = vm.createContext({ Blob, Response, TextEncoder, TextDecoder, Uint8Array, CompressionStream,
    AbortController, setTimeout, clearTimeout, location: { hostname: 'cms.example', protocol: 'https:' }, ...extra });
  vm.runInContext(block, ctx);
  return ctx;
}

test('large imports fit in a compressed device cache and reopen as ordinary workspace JSON', async t => {
  const values = new Map(), limit = 100 * 1024;
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem(key, value) {
      const used = [...values].reduce((total, [name, stored]) => total + (name === key ? 0 : stored.length), 0);
      if (used + value.length > limit) throw Object.assign(new Error('quota'), {name: 'QuotaExceededError'});
      values.set(key, value);
    },
    removeItem: key => values.delete(key)
  };
  const fetch = async () => ({ok: true, status: 200, json: async () => ({workspace: null, revision: 0})});
  const makeStore = download => context().CuePersistence.create({key: 'workspace', storage, fetch, download,
    pollMs: 0, retryMs: 0, debounceMs: 60000});
  let backup;
  const first = makeStore(raw => { backup = raw; });
  t.after(() => first.destroy());
  const updated = await first.load(workspace);
  updated.works = Array.from({length: 250}, (_, index) => ({id: 'song-' + index,
    title: 'अमिश्ना 🎵 background instrumental cue ' + index, notes: 'Repeated music usage '.repeat(500)}));
  const raw = JSON.stringify(updated);
  assert.ok(raw.length > limit);
  assert.equal(first.save(updated), true);
  assert.ok(values.get('workspace').startsWith('AMISHNA-LZW2:'));
  assert.ok(values.get('workspace').length < limit);
  first.downloadBackup();
  assert.equal(backup, raw);
  first.destroy();
  const reopened = makeStore();
  t.after(() => reopened.destroy());
  assert.equal(JSON.stringify(await reopened.load(workspace)), raw);
  assert.equal(JSON.parse(values.get('workspace:sync')).pending, true);
});

test('1,000 episodes with 10,000 cues fit a typical 5 MB browser cache', async t => {
  const values = new Map(), quota = 5 * 1024 * 1024;
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem(key, value) {
      const used = [...values].reduce((total, [name, stored]) => total + (name === key ? 0 : stored.length * 2), 0);
      if (used + value.length * 2 > quota) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
      values.set(key, value);
    },
    removeItem: key => values.delete(key)
  };
  const fetch = async () => ({ ok: true, status: 200, json: async () => ({ workspace: null, revision: 0 }) });
  const create = () => context({ location: { hostname: '127.0.0.1', protocol: 'http:' } }).CuePersistence.create({
    key: 'workspace', storage, fetch, pollMs: 0, retryMs: 0, debounceMs: 60000
  });
  const first = create(); t.after(() => first.destroy());
  const updated = await first.load(workspace);
  updated.projects = Array.from({ length: 10 }, (_, project) => ({ id: 'P' + project, type: 'Series', title: 'Series ' + project,
    episodes: Array.from({ length: 100 }, (_, episode) => ({ number: episode + 1, title: 'Episode ' + (episode + 1) })) }));
  for (let index = 0; index < 10000; index++) {
    updated.works.push({ id: 'W' + index, title: 'Instrumental ' + index, notes: 'Music reference '.repeat(100) });
    updated.cues.push({ id: 'C' + index, projectId: 'P' + Math.floor(index / 1000), episode: Math.floor(index % 1000 / 10) + 1,
      workId: 'W' + index, duration: 30 });
  }
  const raw = JSON.stringify(updated);
  assert.ok(raw.length > 12 * 1024 * 1024);
  assert.equal(first.save(updated), true);
  assert.ok(values.get('workspace').length * 2 < quota);
  first.destroy();
  const reopened = create(); t.after(() => reopened.destroy());
  assert.equal((await reopened.load(workspace)).cues.length, 10000);
});

test('a compressed workspace above 32 MB reopens within the 64 MB local limit', async t => {
  const values = new Map(), storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key)
  };
  const fetch = async () => ({ ok: true, status: 200, json: async () => ({ workspace: null, revision: 0 }) });
  const create = () => context({ location: { hostname: '127.0.0.1', protocol: 'http:' } }).CuePersistence.create({
    key: 'large-local-workspace', storage, fetch, pollMs: 0, retryMs: 0, debounceMs: 60000
  });
  const first = create(); t.after(() => first.destroy());
  const updated = await first.load(workspace);
  updated.works.push({ id: 'large-work', title: 'Long notes', notes: 'x'.repeat(33 * 1024 * 1024) });
  assert.equal(first.save(updated), true);
  first.destroy();
  const reopened = create(); t.after(() => reopened.destroy());
  assert.equal((await reopened.load(workspace)).works[0].notes.length, 33 * 1024 * 1024);
});

test('a device quota failure preserves the previous cache and reports the cause', async t => {
  const values = new Map(), limit = 5000;
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem(key, value) {
      const used = [...values].reduce((total, [name, stored]) => total + (name === key ? 0 : stored.length), 0);
      if (used + value.length > limit) throw Object.assign(new Error('quota'), {name: 'QuotaExceededError'});
      values.set(key, value);
    },
    removeItem: key => values.delete(key)
  };
  const store = context().CuePersistence.create({key: 'workspace', storage, pollMs: 0, retryMs: 0,
    fetch: async () => ({ok: true, status: 200, json: async () => ({workspace: null, revision: 0})})});
  t.after(() => store.destroy());
  const updated = await store.load(workspace), before = values.get('workspace');
  updated.works.push({id: 'large', title: randomBytes(30000).toString('base64')});
  assert.equal(store.save(updated), false);
  assert.equal(values.get('workspace'), before);
  assert.equal(store.getStatus().kind, 'local-error');
  assert.match(store.getStatus().message, /Browser storage is full/);
});

test('compressed device copies remain readable after the cache dictionary fills', async t => {
  const values = new Map(), storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key)
  };
  const fetch = async () => ({ok: true, status: 200, json: async () => ({workspace: null, revision: 0})});
  const makeStore = () => context().CuePersistence.create({key: 'workspace', storage, fetch,
    pollMs: 0, retryMs: 0, debounceMs: 60000});
  const first = makeStore();
  t.after(() => first.destroy());
  const updated = await first.load(workspace);
  updated.works.push({id: 'varied', title: randomBytes(160000).toString('base64').repeat(10)});
  const raw = JSON.stringify(updated);
  assert.equal(first.save(updated), true);
  assert.ok(values.get('workspace').startsWith('AMISHNA-LZW2:'));
  first.destroy();
  const reopened = makeStore();
  t.after(() => reopened.destroy());
  assert.equal(JSON.stringify(await reopened.load(workspace)), raw);
});

test('small saves stay JSON, while large online saves preserve every byte through gzip', async () => {
  const api = context().CuePersistence;
  const small = { workspace: workspace(), expectedRevision: 7 };
  assert.equal((await api.prepareRequest(small, { online: true })).body, JSON.stringify(small));
  const large = { ...small, workspace: { ...workspace(), notes: 'अमिश्ना 🎵 metadata '.repeat(100000) } };
  const prepared = await api.prepareRequest(large, { online: true });
  assert.equal(prepared.headers['X-Workspace-Encoding'], 'gzip');
  assert.equal(gunzipSync(prepared.body).toString(), JSON.stringify(large));
  assert.equal((await api.prepareRequest(large, { online: false })).body, JSON.stringify(large));
});

test('unsupported compression and incompressible uploads give actionable errors', async () => {
  const body = { workspace: { ...workspace(), notes: 'x'.repeat(5 * 1024 * 1024) }, expectedRevision: 0 };
  const api = context({ CompressionStream: undefined }).CuePersistence;
  await assert.rejects(api.prepareRequest(body, { online: true }), error => error.status === 413 && /Update your browser/.test(error.message));
  body.workspace.notes = randomBytes(5 * 1024 * 1024).toString('base64');
  await assert.rejects(context().CuePersistence.prepareRequest(body, { online: true }), error => error.status === 413 && /compressed workspace/.test(error.message));
});

test('the uncompressed JSON limit is enforced before compression even for highly repetitive data', async () => {
  const body = { workspace: { ...workspace(), notes: 'x'.repeat(12 * 1024 * 1024) }, expectedRevision: 0 };
  await assert.rejects(context().CuePersistence.prepareRequest(body, { online: true }), error => error.status === 413 && /12 MB/.test(error.message));
  const local = await context().CuePersistence.prepareRequest(body, { online: false });
  assert.equal(local.headers['Content-Type'], 'application/json');
  assert.equal(local.body.length, JSON.stringify(body).length);
});

for (const failure of [
  { status: 503, message: 'The database is not configured. Set MONGODB_URI in the server environment and redeploy.', kind: 'offline' },
  { status: 409, message: 'Workspace changed.', kind: 'conflict' },
  { status: 413, message: 'The workspace is too large.', kind: 'error' }
]) {
  test('a failed save preserves the device copy and pending changes (HTTP ' + failure.status + ')', async t => {
    const current = workspace(); current.works = [{ id: 'song-1', title: 'Preserved local song' }];
    const values = new Map([['workspace', JSON.stringify(current)]]);
    const store = context().CuePersistence.create({ key: 'workspace', pollMs: 0, retryMs: 0, debounceMs: 60000,
      storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
      fetch: async (_url, options) => options.method === 'GET'
        ? { ok: true, status: 200, json: async () => ({ workspace: null, revision: 0 }) }
        : { ok: false, status: failure.status, json: async () => ({ error: { message: failure.message } }) }
    });
    t.after(() => store.destroy());
    await store.load(workspace);
    assert.equal(await store.sync(), false);
    assert.equal(store.getStatus().kind, failure.kind);
    assert.equal(store.getStatus().serverReachable, true);
    assert.deepEqual(JSON.parse(values.get('workspace')), current);
    assert.equal(JSON.parse(values.get('workspace:sync')).pending, true);
    if (failure.status !== 409) assert.ok(store.getStatus().message.includes(failure.message));
  });
}

test('a network failure reports the server as unreachable and preserves cached records', async t => {
  const current = workspace(), values = new Map([['workspace', JSON.stringify(current)]]);
  const store = context().CuePersistence.create({ key: 'workspace', pollMs: 0, retryMs: 0,
    storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    fetch: async () => { throw new Error('The database request timed out'); }
  });
  t.after(() => store.destroy());
  await store.load(workspace);
  assert.equal(store.getStatus().serverReachable, false);
  assert.match(store.getStatus().message, /timed out/);
  assert.deepEqual(JSON.parse(values.get('workspace')), current);
});

test('a failed change-only upload keeps the added episodes pending on the device', async t => {
  const remote = workspace();
  remote.projects = [{ id: 'series-1', title: 'Series', episodes: [{ number: 1, title: 'Saved episode' }] }];
  const values = new Map(), methods = [];
  const store = context().CuePersistence.create({ key: 'workspace', pollMs: 0, retryMs: 0, debounceMs: 60000,
    storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    fetch: async (_url, options) => {
      methods.push(options.method);
      return options.method === 'GET'
        ? { ok: true, status: 200, json: async () => ({ workspace: remote, revision: 3 }) }
        : { ok: false, status: 503, json: async () => ({ error: { message: 'MongoDB unavailable' } }) };
    }
  });
  t.after(() => store.destroy());
  const next = await store.load(workspace);
  next.projects[0].episodes.push({ number: 2, title: 'New episode' });
  assert.equal(store.save(next), true);
  assert.equal(await store.sync(), false);
  assert.deepEqual(methods, ['GET', 'PATCH']);
  assert.equal(JSON.parse(values.get('workspace')).projects[0].episodes.length, 2);
  assert.equal(JSON.parse(values.get('workspace:sync')).pending, true);
  assert.equal(store.getStatus().kind, 'offline');
});
