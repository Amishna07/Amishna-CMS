'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { SQLiteRepository } = require('../src/repository');
const { SQLiteAuthStore, hashPassword } = require('../src/auth');
const { createApp } = require('../src/app');

test('local accounts, sessions and workspace survive restart without MongoDB', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amishna-local-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'amishna.sqlite');
  let repository = new SQLiteRepository({ file });
  let accounts = new SQLiteAuthStore(repository);
  assert.equal(await accounts.hasAdmin(), false);
  const administrator = await accounts.createUser({ name: 'Owner', email: 'owner@example.com', role: 'admin', active: true,
    passwordHash: await hashPassword('correct horse battery staple') }, true);
  await accounts.createSession({ _id: 'session', userId: administrator._id, expiresAt: new Date(Date.now() + 60000) });
  await repository.put({ version: 1, title: 'Offline workspace' }, 0);
  await repository.close();

  repository = new SQLiteRepository({ file });
  t.after(() => repository.close());
  accounts = new SQLiteAuthStore(repository);
  assert.equal(await accounts.hasAdmin(), true);
  assert.equal((await accounts.findUser('owner@example.com'))._id, administrator._id);
  assert.equal((await accounts.findSession('session')).userId, administrator._id);
  assert.equal((await repository.get()).workspace.title, 'Offline workspace');
  await accounts.updateUser(administrator._id, { passwordHash: await hashPassword('another correct horse battery') });
  assert.equal(await accounts.findSession('session'), undefined);
  assert.equal(await accounts.takeAttempt('owner@example.com'), true);
  await accounts.resetAttempts('owner@example.com');
});

test('SQLite keeps separate workspaces and rejects stale patches atomically', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amishna-local-workspaces-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'amishna.sqlite');
  const first = new SQLiteRepository({ file, workspaceId: 'series' });
  t.after(() => first.close());
  const original = { version: 1, works: [], projects: [], cues: [], clients: [], imports: [], exports: [], profiles: [], activity: [], preferences: { theme: 'light' } };
  await first.put(original, 0);
  await assert.rejects(first.patch([{ op: 'set', path: ['preferences'], value: { theme: 'dark' } }], 0), error => error.status === 409);
  assert.equal((await first.get()).workspace.preferences.theme, 'light');
  const second = new SQLiteRepository({ file, workspaceId: 'movie' });
  t.after(() => second.close());
  assert.deepEqual(await second.get(), { workspace: null, revision: 0 });
  assert.equal((await first.patch([{ op: 'set', path: ['preferences'], value: { theme: 'dark' } }], 1)).revision, 2);
  assert.equal((await first.get()).workspace.preferences.theme, 'dark');
});

test('local administrator setup and sign-in use SQLite through the API', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amishna-local-auth-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const repository = new SQLiteRepository({ file: path.join(directory, 'amishna.sqlite') });
  t.after(() => repository.close());
  const server = http.createServer(createApp({ repository, logger: { error() {} } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const body = JSON.stringify({ name: 'Owner', email: 'owner@example.com', password: 'correct horse battery staple' });
  const setup = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body });
  assert.equal(setup.status, 200);
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base + '/api/database/backup', { method: 'POST', headers: { Origin: base } })).status, 401);
  assert.equal((await (await fetch(base + '/api/auth/session', { headers: { Cookie: cookie } })).json()).user.role, 'admin');
  assert.equal((await fetch(base + '/api/workspace', { headers: { Cookie: cookie } })).status, 200);
  const logout = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(logout.status, 200);
  assert.equal((await fetch(base + '/api/workspace', { headers: { Cookie: cookie } })).status, 401);
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', password: 'correct horse battery staple' }) });
  assert.equal(login.status, 200);
});

test('database download creates an integrity-checked dated SQLite snapshot', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amishna-local-backup-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const backupDirectory = path.join(directory, 'Database');
  const repository = new SQLiteRepository({ file: path.join(directory, 'amishna.sqlite'), backupDirectory });
  t.after(() => repository.close());
  await fs.mkdir(backupDirectory);
  await fs.writeFile(path.join(backupDirectory, 'Amishna_Database_2020-01-01_00-00-00-000.sqlite'), 'old snapshot');
  const first = { version: 1, title: 'Before the backup' };
  await repository.put(first, 0);
  let actorRole = 'admin';
  const server = http.createServer(createApp({ repository,
    auth: { handle: async () => false, requireUser: async () => ({ id: 'local-owner', role: actorRole }) },
    logger: { error() {} } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(base + '/api/database/backup')).status, 405);
  const response = await fetch(base + '/api/database/backup', { method: 'POST', headers: { Origin: base } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/vnd\.sqlite3/);
  const filename = response.headers.get('x-database-backup-name');
  assert.match(filename, /^Amishna_Database_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}(?:_\d+)?\.sqlite$/);
  assert.equal(response.headers.get('x-database-revision'), '1');
  const downloaded = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(downloaded, await fs.readFile(path.join(backupDirectory, filename)));
  assert.deepEqual(await fs.readdir(backupDirectory), [filename]);
  await repository.put({ version: 1, title: 'After the backup' }, 1);
  const { DatabaseSync } = require('node:sqlite');
  const snapshot = new DatabaseSync(path.join(backupDirectory, filename), { readOnly: true });
  assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(JSON.parse(snapshot.prepare("SELECT data FROM workspaces WHERE workspace_id = 'main'").get().data).title, first.title);
  snapshot.close();
  actorRole = 'editor';
  assert.equal((await fetch(base + '/api/database/backup', { method: 'POST', headers: { Origin: base } })).status, 403);
  assert.equal((await fs.readdir(backupDirectory)).length, 1);
});

test('snapshot retention deletes files older than seven days but always keeps the newest', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amishna-backup-retention-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const backupDirectory = path.join(directory, 'Database');
  const repository = new SQLiteRepository({ file: path.join(directory, 'amishna.sqlite'), backupDirectory });
  t.after(() => repository.close());
  await fs.mkdir(backupDirectory);
  const old = 'Amishna_Database_2026-10-01_10-00-00-000.sqlite';
  const newestOld = 'Amishna_Database_2026-10-03_10-00-00-000.sqlite';
  const recent = 'Amishna_Database_2026-10-14_10-00-00-000.sqlite';
  const unrelated = 'manual-copy.sqlite';
  const partial = old + '.partial';
  for (const name of [old, newestOld, unrelated, partial]) await fs.writeFile(path.join(backupDirectory, name), name);
  const now = new Date(2026, 9, 18, 12).getTime();
  assert.deepEqual(repository.pruneBackups(now), { removed: 1, kept: 1, newest: newestOld });
  assert.deepEqual((await fs.readdir(backupDirectory)).sort(), [newestOld, partial, unrelated].sort());
  await fs.writeFile(path.join(backupDirectory, recent), recent);
  assert.deepEqual(repository.pruneBackups(now), { removed: 1, kept: 1, newest: recent });
  assert.deepEqual((await fs.readdir(backupDirectory)).sort(), [recent, partial, unrelated].sort());
});

test('legacy JSON migrates with a snapshot and record edits stay atomic', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amishna-record-migration-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const file = path.join(directory, 'amishna.sqlite'), backupDirectory = path.join(directory, 'Database');
  const original = {version: 1, works: [{id: 'W1', title: 'Theme'}],
    projects: [{id: 'P1', title: 'Series', type: 'Series', episodes: [{number: 1, title: 'Pilot'}]}],
    cues: [{id: 'C1', projectId: 'P1', episode: 1, workId: 'W1', duration: 30}],
    clients: [], imports: [], exports: [], profiles: [], activity: []};
  const {DatabaseSync} = require('node:sqlite');
  const legacy = new DatabaseSync(file);
  legacy.exec('CREATE TABLE workspaces(workspace_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL)');
  legacy.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?)').run('main', 4, '2026-10-18T10:00:00.000Z', JSON.stringify(original));
  legacy.close();
  const repository = new SQLiteRepository({file, backupDirectory});
  t.after(() => repository.close());
  assert.deepEqual((await repository.get()).workspace.projects, original.projects);
  assert.deepEqual((await repository.get()).workspace.cues, original.cues);
  assert.equal((await repository.getManifest()).counts.episodes, 1);
  const backups = await fs.readdir(backupDirectory);
  assert.equal(backups.length, 1);
  const before = new DatabaseSync(path.join(backupDirectory, backups[0]), {readOnly: true});
  assert.deepEqual(JSON.parse(before.prepare('SELECT data FROM workspaces WHERE workspace_id=?').get('main').data), original);
  before.close();
  const operation = {operationId: 'new-episode-0001', expectedRevision: 4, records: [
    {kind: 'episodes', id: 'P1|2', projectId: 'P1', number: 2, position: 1, value: {number: 2, title: 'Second'}},
    {kind: 'cues', id: 'C2', position: 1, value: {id: 'C2', projectId: 'P1', episode: 2, workId: 'W1', duration: 20}}
  ]};
  assert.equal((await repository.patchRecords(operation)).revision, 5);
  assert.equal((await repository.patchRecords(operation)).replayed, true);
  await assert.rejects(repository.patchRecords({...operation, records: []}), error => error.status === 400);
  assert.equal((await repository.get()).workspace.cues.length, 2);
  assert.equal((await repository.get()).workspace.projects[0].episodes.length, 2);
  assert.equal((await repository.getPage('cues', 0, 1)).records.length, 1);
  await assert.rejects(repository.patchRecords({...operation, operationId: 'stale-edit-0001'}), error => error.status === 409);
  await assert.rejects(repository.patchRecords({operationId: 'bad-delete-0001', expectedRevision: 5,
    records: [{kind: 'episodes', id: 'P1|2', projectId: 'P1', number: 2, value: null}]}), error => error.status === 400);
  assert.equal((await repository.get()).workspace.projects[0].episodes.length, 2);
  const snapshot = await repository.createBackup();
  assert.equal(snapshot.revision, 5);
});

test('local API saves 1,000 episodes and 10,000 cues above the old 12 MB limit', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amishna-local-scale-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const repository = new SQLiteRepository({ file: path.join(directory, 'amishna.sqlite') });
  t.after(() => repository.close());
  const workspace = { version: 1, works: [], projects: [], cues: [], clients: [], imports: [], exports: [], profiles: [], activity: [] };
  for (let projectIndex = 0; projectIndex < 10; projectIndex++) {
    const projectId = 'P' + projectIndex;
    workspace.projects.push({ id: projectId, title: 'Series ' + projectIndex, type: 'Series',
      episodes: Array.from({ length: 100 }, (_, index) => ({ number: index + 1, title: 'Episode ' + (index + 1) })) });
    for (let episode = 1; episode <= 100; episode++) for (let index = 0; index < 10; index++) {
      const id = `${projectId}-${episode}-${index}`;
      workspace.works.push({ id: 'W' + id, title: 'Instrumental ' + id, notes: 'Music reference '.repeat(100) });
      workspace.cues.push({ id: 'C' + id, projectId, workId: 'W' + id, episode, duration: 30 });
    }
  }
  const body = JSON.stringify({ workspace, expectedRevision: 0 });
  assert.ok(Buffer.byteLength(body) > 12 * 1024 * 1024);
  const server = http.createServer(createApp({ repository,
    auth: { handle: async () => false, requireUser: async () => ({ id: 'local-owner' }) },
    logger: { error() {} } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const saved = await fetch(base + '/api/workspace', { method: 'PUT', headers: { Origin: base, 'Content-Type': 'application/json' }, body });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).revision, 1);
  const reloaded = await (await fetch(base + '/api/workspace')).json();
  assert.equal(reloaded.workspace.projects.reduce((total, project) => total + project.episodes.length, 0), 1000);
  assert.equal(reloaded.workspace.cues.length, 10000);
  assert.equal(reloaded.workspace.works.length, 10000);
  const remoteSheet = await fetch(base + '/api/google-sheet/tabs', {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://docs.google.com/spreadsheets/d/example/edit' })
  });
  assert.equal(remoteSheet.status, 410);
  assert.equal((await remoteSheet.json()).error.code, 'LOCAL_ONLY');
});
