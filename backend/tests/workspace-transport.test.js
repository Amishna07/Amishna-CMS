'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { gzipSync } = require('node:zlib');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const vm = require('node:vm');
const { createApp } = require('../src/app');
const { ApiError } = require('../src/errors');
const { MAX_JSON_BYTES, MAX_ONLINE_BYTES } = require('../src/workspace-transport');
const { applyChanges } = require('../src/workspace-changes');
const { SQLiteRepository } = require('../src/repository');
const { replayParsedBody } = require('../../vercel/adapter');

function cleanupAfter(t) {
  const callbacks = [];
  t.after(async () => {
    const errors = [];
    for (const callback of callbacks.reverse()) {
      try { await callback(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Test cleanup failed');
  });
  return callback => callbacks.push(callback);
}

const compressedHeaders = { 'Content-Type': 'application/octet-stream', 'X-Workspace-Encoding': 'gzip' };
const emptyWorkspace = () => ({ version: 1, works: [], projects: [], cues: [], clients: [], imports: [], exports: [], profiles: [], activity: [] });

async function fixture(t, options = {}) {
  let saved = { workspace: null, revision: 0 }, writes = 0;
  const repository = {
    get: async () => structuredClone(saved),
    put: async (workspace, expectedRevision) => {
      if (expectedRevision !== saved.revision) throw new ApiError(409, 'REVISION_CONFLICT', 'Workspace changed.');
      writes++;
      saved = { workspace: structuredClone(workspace), revision: saved.revision + 1, updatedAt: new Date().toISOString() };
      return saved;
    },
    patch: async (changes, expectedRevision) => {
      if (expectedRevision !== saved.revision) throw new ApiError(409, 'REVISION_CONFLICT', 'Workspace changed.');
      writes++;
      saved = { workspace: applyChanges(saved.workspace, changes), revision: saved.revision + 1, updatedAt: new Date().toISOString() };
      return { revision: saved.revision, updatedAt: saved.updatedAt };
    }
  };
  const app = createApp({ repository, allowPublicHost: true,
    auth: { handle: async () => false, requireUser: async () => ({ id: 'test-user' }) },
    logger: { error() {} }, ...options });
  const chunks = [];
  const server = http.createServer((request, response) => {
    const write = response.write;
    response.write = function (chunk, ...args) { chunks.push(chunk.length); return write.call(this, chunk, ...args); };
    return app(request, response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  return { base, chunks, saved: () => saved, writes: () => writes,
    send: (path, body, headers = compressedHeaders, method = 'PUT') => fetch(base + path, { method, headers, body }) };
}

test('a 4.86 MB device workspace syncs, reloads and retains all history and Unicode metadata', async t => {
  const api = await fixture(t), original = emptyWorkspace();
  original.works = [{ id: 'song-1', title: 'अमिश्ना 🎵', isrc: '00001234', custom: { shares: [25, 75] } }];
  original.imports = Array.from({ length: 1333 }, (_, id) => ({ id: 'import-' + id, filename: 'Episode_' + id + '.xlsx' }));
  original.exports = Array.from({ length: 330 }, (_, id) => ({ id: 'export-' + id, snapshot: { works: original.works, source: 'preserved' } }));
  original.padding = '';
  original.padding = 'x'.repeat(Math.round(4.86 * 1024 * 1024) - Buffer.byteLength(JSON.stringify(original)));
  const values = new Map([['workspace', JSON.stringify(original)]]), uploads = [];
  const source = readFileSync(join(__dirname, '../../frontend/public/dashboard.js'), 'utf8');
  const context = vm.createContext({ Blob, Response, CompressionStream, TextEncoder, Uint8Array,
    AbortController, setTimeout, clearTimeout, location: { hostname: 'cms.example', protocol: 'https:' } });
  vm.runInContext(source.slice(source.indexOf('/* persistence.js */'), source.indexOf('/* catalog.js */')), context);
  const persistence = context.CuePersistence.create({ key: 'workspace', pollMs: 0, retryMs: 0, debounceMs: 60000,
    storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    fetch: (endpoint, options) => {
      if (options.method === 'PUT') uploads.push(options);
      return fetch(api.base + endpoint, options);
    } });
  t.after(() => persistence.destroy());
  await persistence.load(emptyWorkspace);
  assert.equal(await persistence.sync(), true);
  assert.equal(persistence.getStatus().kind, 'synced');
  assert.equal(JSON.parse(values.get('workspace:sync')).pending, false);
  assert.equal(uploads[0].headers['X-Workspace-Encoding'], 'gzip');
  assert.ok(uploads[0].body.byteLength < MAX_ONLINE_BYTES);
  assert.deepEqual(api.saved().workspace, original);
  assert.equal(api.saved().revision, 1);
  const response = await fetch(api.base + '/api/workspace');
  assert.equal(response.headers.get('content-length'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await response.json()).workspace, original);
  assert.ok(api.chunks.length > 2);
  assert.ok(api.chunks.every(size => size <= 64 * 1024));
  t.diagnostic('4.86 MB workspace uploaded as ' + (uploads[0].body.byteLength / 1024).toFixed(1) + ' KB; 1,333 imports and 330 export snapshots preserved.');
});

test('adding 250 episodes to 100 saved episodes uploads only the changes', async t => {
  const api = await fixture(t), original = emptyWorkspace();
  original.projects = [{ id: 'SERIES-1', title: 'Existing series', type: 'Series',
    episodes: Array.from({ length: 100 }, (_, index) => ({ number: index + 1, title: 'Existing episode ' + (index + 1) })) }];
  const first = await api.send('/api/workspace', JSON.stringify({ workspace: original, expectedRevision: 0 }),
    { 'Content-Type': 'application/json' }, 'PUT');
  assert.equal(first.status, 200);
  const source = readFileSync(join(__dirname, '../../frontend/public/dashboard.js'), 'utf8');
  const context = vm.createContext({ Blob, Response, CompressionStream, TextEncoder, Uint8Array,
    AbortController, setTimeout, clearTimeout, location: { hostname: 'cms.example', protocol: 'https:' } });
  vm.runInContext(source.slice(source.indexOf('/* persistence.js */'), source.indexOf('/* catalog.js */')), context);
  const values = new Map(), uploads = [];
  const persistence = context.CuePersistence.create({ key: 'workspace', pollMs: 0, retryMs: 0, debounceMs: 60000,
    storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    fetch: (endpoint, options) => {
      if (options.method === 'PATCH' || options.method === 'PUT') uploads.push(options);
      return fetch(api.base + endpoint, options);
    } });
  t.after(() => persistence.destroy());
  const loaded = await persistence.load(emptyWorkspace);
  assert.equal(loaded.projects[0].episodes.length, 100);
  const next = structuredClone(loaded);
  next.projects[0].episodes.push(...Array.from({ length: 250 }, (_, index) => ({ number: index + 101, title: 'New episode ' + (index + 101) })));
  next.projects[0].updatedAt = new Date().toISOString();
  assert.equal(persistence.save(next), true);
  assert.equal(await persistence.sync(), true);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].method, 'PATCH');
  const sent = JSON.parse(uploads[0].body);
  assert.equal(sent.expectedRevision, 1);
  assert.ok(sent.changes.some(change => change.op === 'splice' && change.path.join('.') === 'projects.0.episodes' &&
    change.index === 100 && change.deleteCount === 0 && change.items.length === 250));
  assert.ok(!uploads[0].body.includes('Existing episode 1'));
  assert.ok(Buffer.byteLength(uploads[0].body) < Buffer.byteLength(JSON.stringify({ workspace: next, expectedRevision: 1 })));
  assert.deepEqual(api.saved().workspace, next);
  assert.equal(api.saved().revision, 2);
  assert.equal(persistence.getStatus().kind, 'synced');
});

test('change-only saves reject stale revisions and unsafe paths without changing records', async t => {
  const api = await fixture(t), original = emptyWorkspace();
  assert.equal((await api.send('/api/workspace', JSON.stringify({ workspace: original, expectedRevision: 0 }),
    { 'Content-Type': 'application/json' }, 'PUT')).status, 200);
  const headers = { 'Content-Type': 'application/json' };
  assert.equal((await api.send('/api/workspace', JSON.stringify({ expectedRevision: 0,
    changes: [{ op: 'set', path: ['preferences'], value: { theme: 'dark' } }] }), headers, 'PATCH')).status, 409);
  assert.equal((await api.send('/api/workspace', JSON.stringify({ expectedRevision: 1,
    changes: [{ op: 'set', path: ['__proto__'], value: { hacked: true } }] }), headers, 'PATCH')).status, 400);
  assert.deepEqual(api.saved().workspace, original);
  assert.equal(api.writes(), 1);
});

test('SQLite change-only writes use a revision-checked update and retain untouched records', async t => {
  const cleanup = cleanupAfter(t);
  const directory = await mkdtemp(join(tmpdir(), 'amishna-sqlite-patch-'));
  cleanup(() => rm(directory, { recursive: true, force: true }));
  const repository = new SQLiteRepository({ file: join(directory, 'cms.sqlite'), workspaceId: 'fixture' });
  cleanup(() => repository.close());
  const original = emptyWorkspace();
  original.projects = [{ id: 'SERIES-1', title: 'Series', type: 'Series', episodes: [{ number: 1, title: 'Saved episode' }] }];
  await repository.put(original, 0);
  const changes = [{ op: 'splice', path: ['projects', 0, 'episodes'], index: 1, deleteCount: 0,
    items: [{ number: 2, title: 'New episode' }] }];
  assert.equal((await repository.patch(changes, 1)).revision, 2);
  assert.deepEqual((await repository.get()).workspace.projects[0].episodes, [{ number: 1, title: 'Saved episode' }, { number: 2, title: 'New episode' }]);
  await assert.rejects(repository.patch(changes, 1), error => error.status === 409);
  assert.equal((await repository.get()).revision, 2);
});

test('compressed saves retain revision conflict checks and backup validation never writes', async t => {
  const app = await fixture(t), workspace = emptyWorkspace();
  const body = gzipSync(JSON.stringify({ workspace, expectedRevision: 0 }));
  assert.equal((await app.send('/api/workspace/validate', body, compressedHeaders, 'POST')).status, 200);
  assert.equal(app.writes(), 0);
  assert.equal((await app.send('/api/workspace', body)).status, 200);
  assert.equal((await app.send('/api/workspace', body)).status, 409);
  assert.equal(app.writes(), 1);
});

test('malformed gzip, invalid JSON and invalid workspace schemas are rejected without writing', async t => {
  const app = await fixture(t);
  for (const [body, code] of [
    [Buffer.from('not gzip'), 'INVALID_COMPRESSION'],
    [gzipSync('{'), 'INVALID_JSON'],
    [gzipSync(JSON.stringify({ workspace: { version: 2 }, expectedRevision: 0 })), 'INVALID_WORKSPACE']
  ]) {
    const response = await app.send('/api/workspace', body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, code);
  }
  assert.equal(app.writes(), 0);
});

test('inflated bodies above the JSON limit and wire bodies above the upload limit never write', async t => {
  const app = await fixture(t);
  const huge = gzipSync(JSON.stringify({ workspace: { ...emptyWorkspace(), padding: 'x'.repeat(MAX_JSON_BYTES) }, expectedRevision: 0 }));
  assert.ok(huge.length < MAX_ONLINE_BYTES);
  assert.equal((await app.send('/api/workspace', huge)).status, 413);
  const wire = Buffer.alloc(MAX_ONLINE_BYTES + 1, 120);
  assert.equal((await app.send('/api/workspace', wire)).status, 413);
  const ordinary = JSON.stringify({ workspace: { ...emptyWorkspace(), padding: 'x'.repeat(MAX_ONLINE_BYTES) }, expectedRevision: 0 });
  assert.equal((await app.send('/api/workspace', ordinary, { 'Content-Type': 'application/json' })).status, 413);
  assert.equal(app.writes(), 0);
});

test('compressed requests still require authentication and same-origin access', async t => {
  let authorizations = 0;
  const app = await fixture(t, { auth: { handle: async () => false, requireUser: async () => {
    authorizations++;
    throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in.');
  } } });
  const body = gzipSync(JSON.stringify({ workspace: emptyWorkspace(), expectedRevision: 0 }));
  assert.equal((await app.send('/api/workspace', body, { ...compressedHeaders, Origin: 'https://other.example' })).status, 403);
  assert.equal(authorizations, 0);
  assert.equal((await app.send('/api/workspace', body)).status, 401);
  assert.equal(app.writes(), 0);
});

test('Vercel binary body replay preserves gzip bytes, origin and session headers', async () => {
  const body = gzipSync(JSON.stringify({ workspace: emptyWorkspace(), expectedRevision: 0 }));
  const headers = { 'content-type': 'application/octet-stream', 'x-workspace-encoding': 'gzip',
    cookie: 'amishna_session=test', origin: 'https://cms.example' };
  const request = { method: 'PUT', url: '/api/workspace', socket: {}, headers, body };
  const replay = replayParsedBody(request), chunks = [];
  for await (const chunk of replay) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), body);
  assert.equal(replay.headers, headers);
  assert.throws(() => replayParsedBody({ ...request, body: '{}' }), /binary workspace/);
});
