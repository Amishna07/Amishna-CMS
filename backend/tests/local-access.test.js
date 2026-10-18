'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { ApiError } = require('../src/errors');
const { createApp } = require('../src/app');
const { createFrontendServer } = require('../../frontend/server');

const emptyWorkspace = () => ({ version: 1, works: [], projects: [], cues: [], clients: [], imports: [], exports: [], profiles: [], activity: [], artists: [] });
const jsonHeaders = { 'Content-Type': 'application/json' };

function rawRequest(base, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const request = http.request(base, { path, method, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(body);
  });
}

async function listen(t, server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return 'http://127.0.0.1:' + server.address().port;
}

async function fixture(t, options = {}) {
  let accesses = 0;
  let snapshot = { workspace: emptyWorkspace(), revision: 0 };
  // Exercise real request validation and serialization without a user database.
  const repository = {
    get: async () => { accesses++; return structuredClone(snapshot); },
    health: async () => { accesses++; return { status: 'ok', database: 'connected' }; },
    put: async (workspace, expectedRevision) => {
      accesses++;
      if (expectedRevision !== snapshot.revision) throw new ApiError(409, 'REVISION_CONFLICT', 'Reload the current workspace.');
      snapshot = { workspace: structuredClone(workspace), revision: snapshot.revision + 1 };
      return { revision: snapshot.revision };
    }
  };
  const base = await listen(t, http.createServer(createApp({ repository, auth: { handle: async () => false, requireUser: async () => ({ id: 'test-user', role: 'admin' }) }, logger: { error() {}, warn() {} }, ...options })));
  return { base, request: (path, options) => fetch(base + path, options), accesses: () => accesses };
}

test('authenticated workspace records can be created, read, updated and deleted', async t => {
  const app = await fixture(t);
  let snapshot = await (await app.request('/api/workspace')).json();
  assert.deepEqual(snapshot, { workspace: emptyWorkspace(), revision: 0 });
  const save = workspace => app.request('/api/workspace', { method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ workspace, expectedRevision: snapshot.revision }) });

  snapshot.workspace.works.push({ id: 'WRK-1', title: 'Local song' });
  let response = await save(snapshot.workspace);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(await response.json(), { revision: 1 });
  snapshot = await (await app.request('/api/workspace')).json();
  assert.equal(snapshot.workspace.works[0].title, 'Local song');
  snapshot.workspace.works[0].title = 'Updated local song';
  assert.equal((await save(snapshot.workspace)).status, 200);
  const stale = await save(snapshot.workspace);
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'REVISION_CONFLICT');
  snapshot = await (await app.request('/api/workspace')).json();
  assert.equal(snapshot.workspace.works[0].title, 'Updated local song');
  snapshot.workspace.works = [];
  assert.equal((await save(snapshot.workspace)).status, 200);
  snapshot = await (await app.request('/api/workspace')).json();
  assert.deepEqual(snapshot.workspace.works, []);
  assert.equal(snapshot.revision, 3);
  const health = await app.request('/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok', database: 'connected' });
});

test('legacy session cookies do not prevent local workspace access', async t => {
  const app = await fixture(t);
  for (const cookie of ['', 'amishna_session=expired', 'amishna_session=old; amishna_session=duplicate']) {
    const response = await app.request('/api/workspace', { headers: cookie ? { Cookie: cookie } : {} });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { workspace: emptyWorkspace(), revision: 0 });
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

test('unknown endpoints do not access the workspace', async t => {
  const app = await fixture(t);
  for (const path of ['/api/other']) {
    for (const method of ['GET', 'POST']) {
      const response = await app.request(path, { method });
      assert.equal(response.status, 404);
      assert.equal((await response.json()).error.code, 'NOT_FOUND');
      assert.equal(response.headers.get('set-cookie'), null);
    }
  }
  assert.equal(app.accesses(), 0);
});

test('unknown hosts and cross-site origins remain blocked before any workspace access', async t => {
  const app = await fixture(t);
  for (const headers of [{ Origin: 'https://example.com' }, { Origin: 'http://localhost:9999' }, { 'Sec-Fetch-Site': 'cross-site' }, { Host: 'example.com' }]) {
    for (const [path, method] of [['/api/workspace', 'GET'], ['/api/workspace', 'PUT'], ['/api/workspace/validate', 'POST'], ['/api/health', 'GET'], ['/api/auth/session', 'GET']]) {
      const response = await rawRequest(app.base, path, method, headers);
      assert.equal(response.status, 403);
      assert.equal(response.body.error.code, headers.Host ? 'HOST_NOT_ALLOWED' : 'ORIGIN_NOT_ALLOWED');
    }
  }
  assert.equal(app.accesses(), 0);
  for (const origin of [app.base, 'http://127.0.0.1:4175', 'http://localhost:4175']) {
    assert.equal((await app.request('/api/workspace', { headers: { Origin: origin } })).status, 200);
  }
});

test('Vercel API mode accepts only same-origin public writes', async t => {
  const app = await fixture(t, { allowPublicHost: true });
  const host = 'cms-example.vercel.app', own = 'https://' + host;
  const headers = { Host: host };
  assert.equal((await rawRequest(app.base, '/api/workspace', 'GET', headers)).status, 200);
  const body = JSON.stringify({ workspace: emptyWorkspace(), expectedRevision: 0 });
  for (const extra of [{}, { Origin: 'https://another.vercel.app' }, { Origin: own, 'Sec-Fetch-Site': 'cross-site' }]) {
    const result = await rawRequest(app.base, '/api/workspace', 'PUT', { ...headers, ...jsonHeaders, ...extra }, body);
    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, 'ORIGIN_NOT_ALLOWED');
  }
  assert.equal(app.accesses(), 1);
  assert.equal((await rawRequest(app.base, '/api/workspace', 'PUT', { ...headers, ...jsonHeaders, Origin: own, 'Sec-Fetch-Site': 'same-origin' }, body)).status, 200);
  assert.equal((await rawRequest(app.base, '/api/workspace', 'GET', { ...headers, Origin: own })).body.revision, 1);
  assert.equal((await rawRequest(app.base, '/api/workspace', 'GET', { Host: 'bad host' })).status, 403);
});

test('backup validation checks the full save schema without reading or writing the workspace', async t => {
  const app = await fixture(t);
  const validate = workspace => app.request('/api/workspace/validate', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ workspace }) });
  const workspace = emptyWorkspace();
  assert.equal((await validate(workspace)).status, 200);
  const broken = structuredClone(workspace);
  broken.cues.push({ id: 'CUE-1', projectId: 'MISSING', workId: 'MISSING', duration: 5 });
  const rejected = await validate(broken);
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error.code, 'INVALID_WORKSPACE');
  assert.equal((await validate({ ...workspace, works: [{ id: 'WRK-1', title: 'Test', parties: [{ name: 'Composer', role: 'Composer', share: 101 }] }] })).status, 400);
  assert.equal((await validate({ ...workspace, version: 2 })).status, 400);
  assert.equal(app.accesses(), 0);
});

test('workspace writes still require valid, bounded JSON and schema values', async t => {
  const app = await fixture(t, { maxBodyBytes: 1024 });
  const put = (body, headers = jsonHeaders) => app.request('/api/workspace', { method: 'PUT', headers, body });
  assert.equal((await put('plaintext', {})).status, 415);
  assert.equal((await put('{')).status, 400);
  assert.equal((await put(JSON.stringify({ large: 'a'.repeat(2000) }))).status, 413);
  assert.equal((await put(JSON.stringify({ workspace: emptyWorkspace(), expectedRevision: -1 }))).status, 400);
  assert.equal((await put(JSON.stringify({ workspace: { version: 2 }, expectedRevision: 0 }))).status, 400);
  assert.equal(app.accesses(), 0);
});

test('frontend proxy and downloadable workbooks work without login', async t => {
  const backend = await fixture(t);
  const base = await listen(t, createFrontendServer({ apiTarget: backend.base }));
  assert.equal((await fetch(base + '/api/workspace')).status, 200);
  const workbook = await fetch(base + '/IPRS-verification.xlsx');
  assert.equal(workbook.status, 200);
  assert.equal(workbook.headers.get('set-cookie'), null);
  assert.match(workbook.headers.get('content-type'), /spreadsheetml/);
  assert.equal((await fetch(base + '/api/workspace', { headers: { Origin: 'http://127.0.0.1:9999' } })).status, 403);
  assert.equal((await fetch(base + '/api/auth/logout', { method: 'POST' })).status, 404);
  assert.equal((await fetch(base + '/IPRS-verification.xlsx', { headers: { Cookie: 'amishna_session=expired' } })).status, 200);
});

test('downloadable workbooks do not depend on backend availability', async t => {
  const upstream = await listen(t, http.createServer(request => request.socket.destroy()));
  const base = await listen(t, createFrontendServer({ apiTarget: upstream }));
  const response = await fetch(base + '/IPRS-verification.xlsx');
  assert.equal(response.status, 200);
});
