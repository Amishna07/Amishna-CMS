'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createFrontendServer } = require('../../frontend/server');
const { SQLiteRepository } = require('../src/repository');

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

async function listen(cleanup, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return 'http://127.0.0.1:' + server.address().port;
}
function raw(base, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(base, { path: requestPath, headers }, response => {
      const parts = []; response.on('data', part => parts.push(part));
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(parts).toString() }));
    }); request.on('error', reject);
  });
}
test('invalid paths return a safe error and the frontend remains available', async t => {
  const cleanup = cleanupAfter(t);
  const base = await listen(cleanup, createFrontendServer());
  for (const url of ['/%00.js', '/%0a.js', '/%E0%A4%A']) assert.equal((await raw(base, url)).status, 400);
  assert.equal((await fetch(base)).status, 200);
});
test('private paths, public symlinks outside the root and unknown hosts are not served', async t => {
  const cleanup = cleanupAfter(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amishna-static-test-'));
  cleanup(() => fs.rm(directory, { recursive: true, force: true }));
  const publicDirectory = path.join(directory, 'public'); await fs.mkdir(publicDirectory);
  await fs.writeFile(path.join(publicDirectory, 'index.html'), '<!doctype html><title>Fixture</title>');
  await fs.writeFile(path.join(directory, 'private.js'), 'private fixture');
  let symlinkAvailable = true;
  try { await fs.symlink(path.join(directory, 'private.js'), path.join(publicDirectory, 'linked.js')); }
  catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    symlinkAvailable = false;
    t.diagnostic('File symlink check skipped: this Windows account cannot create symlinks.');
  }
  const base = await listen(cleanup, createFrontendServer({ publicDirectory }));
  for (const url of [...(symlinkAvailable ? ['/linked.js'] : []), '/%2e%2e/private.js', '/.env', '/../../private.js']) assert.equal((await raw(base, url)).status, 404);
  assert.equal((await raw(base, '/', { Host: 'example.com' })).status, 403);
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
  const head = await fetch(base, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
});
test('an interrupted upstream returns a recoverable error without stopping the frontend', async t => {
  const cleanup = cleanupAfter(t);
  const upstream = await listen(cleanup, http.createServer(request => request.socket.destroy()));
  const base = await listen(cleanup, createFrontendServer({ apiTarget: upstream }));
  const response = await fetch(base + '/api/workspace');
  assert.equal(response.status, 503);
  const body = await response.json(); assert.equal(body.error.code, 'BACKEND_UNAVAILABLE'); assert.equal('stack' in body.error, false);
  assert.equal((await fetch(base)).status, 200);
});
test('SQLite repository keeps revisions and data after reopening', async t => {
  const cleanup = cleanupAfter(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amishna-sqlite-test-'));
  cleanup(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'cms.sqlite');
  const repository = new SQLiteRepository({ file, workspaceId: 'fixture' });
  let closed = false;
  cleanup(() => closed ? undefined : repository.close());
  assert.equal((await repository.put({ version: 1, title: 'First' }, 0)).revision, 1);
  await assert.rejects(repository.put({ version: 1, title: 'Stale' }, 0), error => error.status === 409);
  await repository.close();
  closed = true;
  const reopened = new SQLiteRepository({ file, workspaceId: 'fixture' });
  cleanup(() => reopened.close());
  assert.equal((await reopened.get()).workspace.title, 'First');
  assert.equal((await reopened.put({ version: 1, title: 'Second' }, 1)).revision, 2);
  assert.equal((await reopened.get()).workspace.title, 'Second');
});
test('SQLite repository accepts workspaces larger than the old MongoDB document cap', async t => {
  const cleanup = cleanupAfter(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amishna-sqlite-large-'));
  cleanup(() => fs.rm(directory, { recursive: true, force: true }));
  const repository = new SQLiteRepository({ file: path.join(directory, 'cms.sqlite') });
  cleanup(() => repository.close());
  const workspace = { version: 1, text: 'x'.repeat(14 * 1024 * 1024) };
  assert.equal((await repository.put(workspace, 0)).revision, 1);
  assert.equal((await repository.get()).workspace.text.length, workspace.text.length);
});
