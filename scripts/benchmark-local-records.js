'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {performance} = require('node:perf_hooks');
const {SQLiteRepository} = require('../backend/src/repository');
const {createApp} = require('../backend/src/app');
const {create, difference} = require('../frontend/public/local-records');

async function main() {
  const episodes = Number(process.argv[2] || 10000), cuesPerEpisode = Number(process.argv[3] || 10);
  if (!Number.isInteger(episodes) || !Number.isInteger(cuesPerEpisode) || episodes < 1 || cuesPerEpisode < 1)
    throw new Error('Usage: node scripts/benchmark-local-records.js [episodes] [cues-per-episode]');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amishna-record-scale-'));
  const repository = new SQLiteRepository({file: path.join(directory, 'test.sqlite')});
  let workspace = {version: 1, clients: [], projects: [], works: [], cues: [],
    imports: [], exports: [], profiles: [], activity: []};
  const positions = new Map();
  let cueIndex = 0, episodeIndex = 0;
  for (let client = 0; client < 10; client++) {
    const id = 'CLIENT-' + client;
    workspace.clients.push({id, name: 'Client ' + client});
    positions.set('clients\0' + id, client);
  }
  for (let work = 0; work < 3; work++) {
    const id = 'WORK-' + work;
    workspace.works.push({id, title: 'Instrumental ' + work});
    positions.set('works\0' + id, work);
  }
  const projectCount = Math.ceil(episodes / 100);
  for (let project = 0; project < projectCount; project++) {
    const projectId = 'PROJECT-' + project, projectEpisodes = [];
    for (let number = 1; number <= 100 && episodeIndex < episodes; number++, episodeIndex++) {
      projectEpisodes.push({number, title: 'Episode ' + number, createdAt: '2026-10-18T00:00:00.000Z'});
      positions.set('episodes\0' + projectId + '\0' + number, number - 1);
      const importId = 'IMPORT-' + episodeIndex;
      workspace.imports.push({id: importId, projectId, filename: 'workbook.xlsx', sheet: String(number), count: cuesPerEpisode});
      positions.set('imports\0' + importId, episodeIndex);
      for (let cue = 0; cue < cuesPerEpisode; cue++, cueIndex++) {
        const id = 'CUE-' + cueIndex;
        workspace.cues.push({id, projectId, episode: number, workId: 'WORK-' + cue % 3,
          start: 12, end: 42, duration: 30, usage: 'Background', source: 'Library',
          importedFromWorkfile: true, notes: 'Imported music reference. '.repeat(25),
          occurrences: [{start: 12, end: 42, duration: 30, rowNumber: cue + 1,
            filename: 'workbook.xlsx', sheet: String(number), importedValues: {title: 'Instrumental', code: 'A'}}]});
        positions.set('cues\0' + id, cueIndex);
      }
    }
    workspace.projects.push({id: projectId, title: 'Series ' + project, type: 'Series', clientId: 'CLIENT-' + project % 10,
      episodes: projectEpisodes});
    positions.set('projects\0' + projectId, project);
  }
  const bytes = Buffer.byteLength(JSON.stringify(workspace));
  console.log(JSON.stringify({stage: 'generated', episodes, cues: cueIndex, jsonMiB: +(bytes / 1048576).toFixed(2)}));
  try {
    let start = performance.now();
    const saved = await repository.put(workspace, 0);
    console.log(JSON.stringify({stage: 'sqlite-save', ms: Math.round(performance.now() - start), revision: saved.revision}));
    start = performance.now();
    const manifest = await repository.getManifest();
    const firstPage = await repository.getPage('cues', 0, 1000);
    console.log(JSON.stringify({stage: 'paged-read', ms: Math.round(performance.now() - start),
      counts: manifest.counts, page: firstPage.records.length}));
    start = performance.now();
    const edited = structuredClone(workspace);
    edited.cues[0].duration = 31;
    const delta = difference(workspace, edited, positions);
    console.log(JSON.stringify({stage: 'browser-diff', ms: Math.round(performance.now() - start),
      changedRows: delta.records.length, patchBytes: Buffer.byteLength(JSON.stringify(delta))}));
    start = performance.now();
    const result = await repository.patchRecords({operationId: 'benchmark-edit-0001', expectedRevision: 1, records: delta.records});
    console.log(JSON.stringify({stage: 'sqlite-record-edit', ms: Math.round(performance.now() - start), revision: result.revision,
      integrity: repository.db.prepare('PRAGMA integrity_check').get().integrity_check}));
    workspace = null;
    positions.clear();
    global.gc?.();
    const server = http.createServer(createApp({repository,
      auth: {handle: async () => false, requireUser: async () => ({id: 'benchmark', role: 'admin'})},
      logger: {error() {}}}));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const storageValues = new Map(), storage = {getItem: key => storageValues.get(key) ?? null,
      setItem: (key, value) => storageValues.set(key, value), removeItem: key => storageValues.delete(key)};
    const client = create({key: 'benchmark', storage, pollMs: 0, debounceMs: 60000,
      fetch: (url, options = {}) => fetch(base + url, {...options, headers: {Origin: base, ...options.headers}})});
    try {
      start = performance.now();
      const opened = await client.load(() => {throw new Error('The benchmark database must exist.');});
      console.log(JSON.stringify({stage: 'browser-paged-open', ms: Math.round(performance.now() - start),
        episodes: opened.projects.reduce((sum, item) => sum + item.episodes.length, 0), cues: opened.cues.length,
        heapMiB: Math.round(process.memoryUsage().heapUsed / 1048576)}));
      opened.cues[0].duration = 32;
      start = performance.now();
      const accepted = client.save(opened);
      const savedAgain = accepted && await client.sync();
      console.log(JSON.stringify({stage: 'browser-one-cue-save', ms: Math.round(performance.now() - start),
        saved: savedAgain, queueBytes: Buffer.byteLength(storageValues.get('benchmark:record-queue') || '')}));
      let added = 0;
      for (let projectIndex = 0; projectIndex < 3; projectIndex++) {
        const projectId = 'PROJECT-NEW-' + projectIndex, projectEpisodes = [];
        for (let number = 1; number <= 100 && added < 250; number++, added++) {
          projectEpisodes.push({number, title: 'Added episode ' + number});
          opened.imports.unshift({id: 'IMPORT-NEW-' + added, projectId, filename: 'new-workbook.xlsx', sheet: String(number), count: 10});
          for (let cue = 0; cue < 10; cue++) opened.cues.push({id: 'CUE-NEW-' + added + '-' + cue,
            projectId, episode: number, workId: 'WORK-' + cue % 3, start: 12, end: 42, duration: 30,
            importedFromWorkfile: true, notes: 'Imported music reference. '.repeat(25),
            occurrences: [{start: 12, end: 42, duration: 30, rowNumber: cue + 1, filename: 'new-workbook.xlsx', sheet: String(number)}]});
        }
        opened.projects.push({id: projectId, title: 'Additional series ' + projectIndex, type: 'Series',
          clientId: 'CLIENT-0', episodes: projectEpisodes});
      }
      start = performance.now();
      const batchAccepted = client.save(opened);
      const queuedBytes = Buffer.byteLength(storageValues.get('benchmark:record-queue') || '');
      const batchSaved = batchAccepted && await client.sync();
      const counts = (await repository.getManifest()).counts;
      console.log(JSON.stringify({stage: 'browser-250-worksheet-import', ms: Math.round(performance.now() - start),
        accepted: batchAccepted, saved: batchSaved, status: client.getStatus().message,
        queuedMiB: +(queuedBytes / 1048576).toFixed(2), episodes: counts.episodes, cues: counts.cues}));
    } finally {
      client.destroy();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  } finally {
    await repository.close();
    fs.rmSync(directory, {recursive: true, force: true});
  }
}

main().catch(error => {console.error(error); process.exitCode = 1;});
