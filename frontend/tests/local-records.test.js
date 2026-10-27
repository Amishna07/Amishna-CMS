'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const {SQLiteRepository} = require('../../backend/src/repository');
const {createApp} = require('../../backend/src/app');
const {create, difference} = require('../public/local-records');

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

const empty = () => ({version: 1, works: [], projects: [], cues: [], clients: [], imports: [], exports: [], profiles: [], activity: []});
const memoryStorage = () => {
  const entries = new Map();
  return {entries, getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key)};
};

test('localhost record queue saves, pages, reopens, and replays an interrupted acknowledgement', async t => {
  const cleanup = cleanupAfter(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amishna-record-browser-'));
  cleanup(() => fs.rm(directory, {recursive: true, force: true}));
  const repository = new SQLiteRepository({file: path.join(directory, 'amishna.sqlite')});
  cleanup(() => repository.close());
  const server = http.createServer(createApp({repository,
    auth: {handle: async () => false, requireUser: async () => ({id: 'owner', role: 'admin'})},
    logger: {error() {}}}));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  const base = 'http://127.0.0.1:' + server.address().port;
  const fetcher = (url, options = {}) => fetch(base + url, {...options,
    headers: {Origin: base, ...options.headers}});
  const storage = memoryStorage();
  const first = create({key: 'records', storage, fetch: fetcher, pollMs: 0, debounceMs: 60000});
  cleanup(() => first.destroy());
  const workspace = await first.load(empty);
  workspace.projects.push({id: 'P1', title: 'Series', type: 'Series', episodes: [{number: 1, title: 'Pilot'}]});
  workspace.works.push({id: 'W1', title: 'Theme'});
  workspace.cues.push({id: 'C1', projectId: 'P1', episode: 1, workId: 'W1', duration: 30});
  assert.equal(first.save(workspace), true);
  assert.ok(storage.entries.get('records:record-queue').length < 2048);
  assert.equal(await first.sync(), true);
  assert.equal(first.getStatus().kind, 'synced');
  assert.equal(storage.entries.has('records:record-queue'), false);
  assert.equal((await repository.get()).workspace.cues[0].duration, 30);
  workspace.cues[0].duration = 45;
  assert.equal(first.save(workspace), true);
  first.destroy();
  const reopened = create({key: 'records', storage, fetch: fetcher, pollMs: 0, debounceMs: 60000});
  cleanup(() => reopened.destroy());
  const restored = await reopened.load(empty);
  assert.equal(restored.cues[0].duration, 45);
  assert.equal(await reopened.sync(), true);
  assert.equal((await repository.get()).workspace.cues[0].duration, 45);
  assert.equal((await repository.getPage('episodes', 0, 10)).records[0].value.title, 'Pilot');
  restored.clients.push({id: 'CLIENT-1', name: 'Studio'});
  restored.projects.push({id: 'MOVIE-1', title: 'Film', type: 'Movie', clientId: 'CLIENT-1', episodes: []});
  restored.cues.push({id: 'C2', projectId: 'MOVIE-1', episode: null, workId: 'W1', duration: 90});
  assert.equal(reopened.save(restored), true);
  assert.equal(await reopened.sync(), true);
  assert.equal((await repository.get()).workspace.cues.find(item => item.id === 'C2').episode, null);
  restored.projects[0].episodes.push({number: 2, title: 'Next episode'});
  restored.cues.push({id: 'C3', projectId: 'P1', episode: 2, workId: 'W1', duration: 15});
  assert.equal(reopened.save(restored), true);
  assert.equal(await reopened.sync(), true);
  assert.equal((await repository.get()).workspace.projects[0].episodes.length, 2);
  const dashboardSource = require('node:fs').readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');
  const codecBlock = dashboardSource.slice(dashboardSource.indexOf('/* persistence.js */'), dashboardSource.indexOf('/* catalog.js */'));
  const context = vm.createContext({TextEncoder, TextDecoder, Uint8Array, setTimeout, clearTimeout});
  vm.runInContext(codecBlock, context);
  const previousCodec = global.CuePersistence;
  global.CuePersistence = context.CuePersistence;
  cleanup(() => {global.CuePersistence = previousCodec;});
  for (let index = 0; index < 250; index++) restored.works.push({id: 'MORE-' + index,
    title: 'Additional work ' + index, notes: 'Repeated import metadata '.repeat(100)});
  assert.equal(reopened.save(restored), true);
  assert.match(storage.entries.get('records:record-queue'), /^AMISHNA-LZW2:/);
  reopened.destroy();
  const compressedReload = create({key: 'records', storage, fetch: fetcher, pollMs: 0, debounceMs: 60000});
  cleanup(() => compressedReload.destroy());
  assert.equal((await compressedReload.load(empty)).works.length, 251);
  assert.equal(await compressedReload.sync(), true);
  assert.equal((await repository.get()).workspace.works.length, 251);
  const bulk = await compressedReload.load(empty);
  bulk.projects.push({id: 'P2', title: 'Second series', type: 'Series', episodes:
    Array.from({length: 60}, (_, index) => ({number: index + 1, title: 'Episode ' + (index + 1)}))});
  for (let episode = 1; episode <= 60; episode++) for (let cue = 0; cue < 10; cue++)
    bulk.cues.push({id: 'B' + episode + '-' + cue, projectId: 'P2', episode, workId: 'W1', duration: 20});
  assert.equal(compressedReload.save(bulk), true);
  assert.equal(await compressedReload.sync(), true);
  assert.equal((await repository.get()).workspace.cues.length, 603);
  bulk.cues = bulk.cues.filter(cue => cue.projectId !== 'P2');
  bulk.projects = bulk.projects.filter(project => project.id !== 'P2');
  assert.equal(compressedReload.save(bulk), true);
  assert.equal(await compressedReload.sync(), true);
  assert.equal((await repository.get()).workspace.cues.length, 3);
});

test('a one-cue edit produces one cue record rather than a whole workspace request', () => {
  const before = empty();
  before.projects.push({id: 'P1', title: 'Series', type: 'Series', episodes: [{number: 1}]});
  before.works.push({id: 'W1', title: 'Theme'});
  before.cues.push({id: 'C1', projectId: 'P1', episode: 1, workId: 'W1', duration: 10});
  const after = structuredClone(before), positions = new Map([
    ['projects\0P1', 0], ['works\0W1', 0], ['cues\0C1', 0], ['episodes\0P1\0' + '1', 0]
  ]);
  after.cues[0].duration = 20;
  const delta = difference(before, after, positions);
  assert.deepEqual(delta.records.map(record => [record.kind, record.id]), [['cues', 'C1']]);
  assert.equal(delta.meta, undefined);
});
