'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const XLSX = require('../public/vendor/xlsx.full.min.js');

const dashboard = readFileSync(join(__dirname, '../public/dashboard.js'), 'utf8');
const googleSheetSync = readFileSync(join(__dirname, '../public/google-sheet-sync.js'), 'utf8');
const sheetId = 'test_sheet_id_123';
const shareUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit?usp=sharing`;

function cue(start, end, duration, title) {
  return [start, end, duration, title];
}

function episode(number, rows, { valid = true, name = `Episode ${number}`, duration = '00:24:06', date = '12 Sep 2022' } = {}) {
  return [
    [valid ? duration : 'invalid duration', date, name, '', number],
    ['In Time', 'Out Time', 'Duration', 'Track Name'],
    ...rows
  ];
}

function workbook(sheets) {
  const book = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx', compression: true });
}

function fetchedWorkbook(bytes) {
  return {
    ok: true,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  };
}

function uploadWorkbook(bytes, name = 'Incoming Workfile.xlsx') {
  return {
    name,
    size: bytes.byteLength,
    lastModified: 1,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  };
}

function savedProject() {
  return {
    id: 'PRJ-existing', title: 'Already Created', type: 'Series', clientId: '', language: '',
    episodes: [], periods: [{ from: 1, to: 1, director: '', producer: '', company: '', cast: '' }],
    totalEpisodes: 0, status: 'Draft'
  };
}

function harness({ saveResult = true, syncResult = true } = {}) {
  const requests = [];
  const responses = [];
  const notices = [];
  let saves = 0;
  let syncs = 0;
  let nextId = 0;
  const original = { projects: [], works: [], cues: [], imports: [], activity: [], preferences: {} };
  const ctx = vm.createContext({
    URL, XLSX, structuredClone, setTimeout,
    state: original, dataRevision: 0, workspaceClosed: false, page: 'import',
    bulkImportActive: false, bulkImportPending: null, bulkImportSummary: null,
    importQueue: [], importReadProgress: null, importDefaultType: 'Series',
    importSourceMode: 'excel', importTargetProjectId: null,
    excelSelection: [], excelInspectBusy: false, excelSelectionError: '',
    importModalSource: 'excel', importModalProjectId: null,
    importMovieFields: [], importMovieDetails: {}, googleSheetBusy: false,
    googleSheetError: '', googleSheetSelection: null,
    bulkMovieDetailsError: () => '', renderPage: () => {},
    toast: message => notices.push(message),
    icon: () => '', badge: label => label, esc: value => String(value),
    heading: () => '', options: () => '',
    bulkMovieDetailsView: () => '', simpleWorkfileGuide: () => '', importHistory: () => '',
    modalHead: title => `<h2>${title}</h2>`,
    showModal: (markup, className) => { ctx.lastModal = { markup, className }; },
    go: () => true,
    uid: prefix => `${prefix}-${++nextId}`,
    CueFileSafety: {
      inspect: async file => ({ sheetNames: XLSX.read(await file.arrayBuffer(), { type: 'array', bookSheets: true }).SheetNames, size: file.size }),
      read: async (file, options = {}) => {
        const book = XLSX.read(await file.arrayBuffer(), { type: 'array', ...(options.sheetNames ? { sheets: options.sheetNames } : {}) });
        if (options.sheetNames) book.SheetNames = options.sheetNames;
        return book;
      }
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      const response = responses.shift();
      if (!response) throw new Error('No mocked Google Sheets response');
      return response;
    },
    save: () => { saves++; ctx.dataRevision++; return saveResult; },
    persistence: {
      sync: async () => { syncs++; return syncResult; },
      getStatus: () => syncResult ? { kind: 'synced', pending: false, message: 'Saved to MongoDB' }
        : { kind: 'offline', pending: true, message: 'Saved on this device · MongoDB unavailable' }
    }
  });
  ctx.window = ctx;
  vm.runInContext(dashboard.slice(0, dashboard.indexOf('/* file-safety.js')), ctx);
  ctx.D = ctx.CueDomain;
  vm.runInContext(googleSheetSync, ctx);
  vm.runInContext(dashboard.slice(dashboard.indexOf('function workfileSourceChoices('), dashboard.indexOf('function updateProjectTypeFields(')), ctx);
  vm.runInContext(dashboard.slice(dashboard.indexOf('function bulkColumnField('), dashboard.indexOf('function bulkQueueView()')), ctx);
  vm.runInContext(dashboard.slice(dashboard.indexOf('function bulkQueueView()'), dashboard.indexOf('async function syncGoogleSheet(')), ctx);
  vm.runInContext(dashboard.slice(dashboard.indexOf('async function syncGoogleSheet('), dashboard.indexOf('const importView=bulkImportView')), ctx);
  return { ctx, original, requests, responses, notices, saves: () => saves, syncs: () => syncs };
}

function googleOccurrences(state, id = sheetId) {
  return state.cues.flatMap(cueRecord => cueRecord.occurrences || []).filter(use => use.googleSheetId === id);
}

test('700-plus tab link loads a range picker before fetching selected workfiles', async () => {
  const h = harness();
  h.ctx.state.projects.push(savedProject());
  const tabs = Array.from({ length: 745 }, (_, index) => ({ number: index + 1, name: 'Episode ' + (index + 1) }));
  h.responses.push({ ok: true, json: async () => ({ tabs, maxSelected: 250 }) });
  await h.ctx.loadGoogleSheetTabs({ url: shareUrl, projectId: 'PRJ-existing' });
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, '/api/google-sheet/tabs');
  assert.equal(h.ctx.bulkImportPending, null);
  assert.equal(h.saves(), 0);
  assert.match(h.ctx.googleSheetRangeView(), /745 tabs found/);
  assert.match(h.ctx.googleSheetRangeView(), /From tab/);
  h.ctx.googleSheetSelection.from = 700;
  h.ctx.googleSheetSelection.to = 702;
  h.responses.push(fetchedWorkbook(workbook(Object.fromEntries([700, 701, 702].map(number => ['Episode ' + number, episode(number, [cue('00:01:00', '00:01:20', '00:00:20', 'Alpha')])])))));
  await h.ctx.importGoogleSheetRange();
  const request = JSON.parse(h.requests[1].options.body);
  assert.deepEqual(request.range, { from: 700, to: 702, expectedTabs: ['Episode 700', 'Episode 701', 'Episode 702'] });
  assert.equal(h.ctx.bulkImportPending.total.files, 3);
  assert.equal(h.saves(), 0);
  h.ctx.confirmBulkImport();
  assert.deepEqual(Array.from(h.ctx.state.projects[0].episodes, item => item.number), [700, 701, 702]);
});

test('range sync preserves previously imported tabs and baselines outside the chosen range', async () => {
  const h = harness();
  h.ctx.state.projects.push(savedProject());
  h.responses.push(fetchedWorkbook(workbook({
    'Episode 1': episode(1, [cue('00:01:00', '00:01:20', '00:00:20', 'First')]),
    'Episode 2': episode(2, [cue('00:01:00', '00:01:30', '00:00:30', 'Second')])
  })));
  await h.ctx.syncGoogleSheet({ url: shareUrl, projectId: 'PRJ-existing' });
  h.ctx.confirmBulkImport();
  h.responses.push(fetchedWorkbook(workbook({ 'Episode 2': episode(2, [cue('00:01:00', '00:01:45', '00:00:45', 'Second')]) })));
  await h.ctx.syncGoogleSheet({ ...h.ctx.state.preferences.googleSheets[0], range: { from: 2, to: 2, expectedTabs: ['Episode 2'] } });
  assert.equal(h.ctx.bulkImportPending.total.removedTabs, 0);
  assert.equal(h.ctx.bulkImportPending.total.replacedGooglePlays, 1);
  h.ctx.confirmBulkImport();
  assert.deepEqual(Array.from(googleOccurrences(h.ctx.state), use => use.duration).sort((a,b)=>a-b), [20, 45]);
  assert.deepEqual(Array.from(h.ctx.state.preferences.googleSheets[0].tabBaselines, item => item.tab), ['Episode 1', 'Episode 2']);
});

test('range picker rejects reversed or oversized selections without downloading', async () => {
  const h = harness();
  h.ctx.googleSheetSelection = { from: 1, to: 251, tabs: [] };
  await h.ctx.importGoogleSheetRange();
  h.ctx.googleSheetSelection = { from: 3, to: 2, tabs: [] };
  await h.ctx.importGoogleSheetRange();
  assert.equal(h.requests.length, 0);
  assert.equal(h.saves(), 0);
});

test('Google Sheets fetch uses Excel workfile review and replaces changed, deleted and reordered cue rows on sync', async () => {
  const h = harness();
  h.responses.push(fetchedWorkbook(workbook({
    'Episode 1': episode(1, [
      cue('00:01:00', '00:01:20', '00:00:20', 'Alpha'),
      cue('00:02:00', '00:02:30', '00:00:30', 'Beta'),
      cue('00:03:00', '00:03:40', '00:00:40', 'Gamma')
    ], { name: 'Test Series' }),
    'Episode 2': episode(2, [cue('00:04:00', '00:04:25', '00:00:25', 'Delta')], { name: 'Test Series' })
  })));
  await h.ctx.syncGoogleSheet({ url: shareUrl, projectName: 'Test Series' });
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, '/api/google-sheet/export');
  assert.equal(JSON.parse(h.requests[0].options.body).url, `https://docs.google.com/spreadsheets/d/${sheetId}/edit`);
  assert.equal(h.saves(), 0);
  assert.equal(h.ctx.state, h.original);
  assert.equal(h.ctx.bulkImportPending.total.files, 2);
  assert.equal(h.ctx.bulkImportPending.total.cues, 4);
  assert.equal(h.ctx.importQueue.every(item => item.queueState === 'ready'), true);
  h.ctx.confirmBulkImport();
  assert.equal(h.saves(), 1);
  assert.equal(h.ctx.state.preferences.googleSheets[0].id, sheetId);
  assert.equal(h.ctx.state.projects[0].title, 'Test Series');
  assert.equal(h.ctx.state.preferences.googleSheets[0].projectId, h.ctx.state.projects[0].id);
  assert.deepEqual(Array.from(h.ctx.state.preferences.googleSheets[0].tabBaselines, item => item.tab), ['Episode 1', 'Episode 2']);
  assert.deepEqual(Array.from(h.ctx.state.projects[0].episodes, item => item.title), ['Episode 1', 'Episode 2']);
  assert.equal(googleOccurrences(h.ctx.state).length, 4);
  assert.equal(h.ctx.state.imports.every(item => item.sourceType === 'Google Sheet'), true);

  const betaWork = h.ctx.state.works.find(item => item.title === 'Beta');
  betaWork.notes = 'Reviewed in CMS';
  h.ctx.state.projects[0].title = 'Renamed Series';
  h.ctx.state.projects[0].episodes[0].duration = '00:30:00';
  h.ctx.state.projects[0].episodes[0].airdate = '13 Sep 2022';
  h.ctx.state.cues.push({ id: 'manual-cue', projectId: 'manual-project', workId: 'manual-work', duration: 11 });
  const beforeSecondReview = h.ctx.state;
  h.responses.push(fetchedWorkbook(workbook({
    'Episode 1': episode(1, [
      cue('00:02:00', '00:02:35', '00:00:35', 'Beta'),
      cue('00:01:00', '00:01:20', '00:00:20', 'Alpha')
    ], { name: 'Test Series' }),
    'Episode 2': episode(2, [cue('00:04:00', '00:04:25', '00:00:25', 'Delta')], { name: 'Test Series' })
  })));
  await h.ctx.syncGoogleSheet(h.ctx.state.preferences.googleSheets[0]);
  assert.equal(h.saves(), 1);
  assert.equal(h.ctx.state, beforeSecondReview);
  assert.equal(googleOccurrences(h.ctx.state).length, 4);
  assert.equal(h.ctx.bulkImportPending.total.replacedGooglePlays, 4);
  assert.equal(googleOccurrences(h.ctx.bulkImportPending.candidate).length, 3);
  h.ctx.confirmBulkImport();
  assert.equal(h.saves(), 2);
  assert.equal(googleOccurrences(h.ctx.state).length, 3);
  assert.equal(h.ctx.state.projects.length, 1);
  assert.equal(h.ctx.state.projects[0].title, 'Renamed Series');
  assert.equal(h.ctx.state.preferences.googleSheets[0].projectName, 'Renamed Series');
  assert.equal(h.ctx.state.preferences.googleSheets[0].originalProjectName, 'Test Series');
  assert.equal(h.ctx.state.projects[0].episodes[0].title, 'Episode 1');
  assert.equal(h.ctx.state.projects[0].episodes[0].duration, '00:30:00');
  assert.equal(h.ctx.state.projects[0].episodes[0].airdate, '13 Sep 2022');
  assert.equal(h.ctx.state.cues.some(item => item.id === 'manual-cue'), true);
  assert.equal(h.ctx.state.works.find(item => item.id === betaWork.id).notes, 'Reviewed in CMS');
  assert.equal(h.ctx.state.cues.some(item => h.ctx.state.works.find(work => work.id === item.workId)?.title === 'Gamma'), false);
  const currentBeta = h.ctx.state.cues.find(item => h.ctx.state.works.find(work => work.id === item.workId)?.title === 'Beta');
  assert.equal(currentBeta.duration, 35);
  assert.equal(currentBeta.occurrences[0].rowNumber, 3);
  assert.equal(currentBeta.occurrences[0].googleSheetTab, 'Episode 1');

  h.responses.push(fetchedWorkbook(workbook({
    'Episode 1': episode(1, [cue('00:02:00', '00:02:35', '00:00:35', 'Beta')], { name: 'Test Series' })
  })));
  await h.ctx.syncGoogleSheet({ url: shareUrl, projectName: 'Accidental New Name' });
  assert.equal(h.ctx.bulkImportPending.candidate.projects.length, 1);
  assert.equal(h.ctx.bulkImportPending.candidate.preferences.googleSheets[0].projectName, 'Renamed Series');
  h.ctx.confirmBulkImport();
  assert.equal(h.ctx.state.projects.length, 1);
});

test('Google Sheets fetch failure leaves saved cues and link unchanged', async () => {
  const h = harness();
  h.responses.push({ ok: false, json: async () => ({ error: { message: 'This sheet is not shared for viewing.' } }) });
  await h.ctx.syncGoogleSheet({ url: shareUrl, projectName: 'Test Series' });
  assert.equal(h.saves(), 0);
  assert.equal(h.ctx.state, h.original);
  assert.equal(h.ctx.bulkImportPending, null);
  assert.equal(h.ctx.state.preferences.googleSheets, undefined);
  assert.match(h.ctx.googleSheetError, /not shared/);
});

test('a previously imported tab with invalid workfile data is retained while valid tabs refresh', async () => {
  const h = harness();
  h.responses.push(fetchedWorkbook(workbook({
    'Episode 1': episode(1, [cue('00:01:00', '00:01:20', '00:00:20', 'Alpha')]),
    'Episode 2': episode(2, [cue('00:02:00', '00:02:30', '00:00:30', 'Beta')]),
    'Episode 3': episode(3, [cue('00:03:00', '00:03:40', '00:00:40', 'Gamma')])
  })));
  await h.ctx.syncGoogleSheet({ url: shareUrl, projectName: 'Test Series' });
  h.ctx.confirmBulkImport();
  assert.equal(googleOccurrences(h.ctx.state).length, 3);

  h.responses.push(fetchedWorkbook(workbook({
    'Episode 1': episode(1, [cue('00:01:00', '00:01:25', '00:00:25', 'Alpha')]),
    'Episode 2': episode(2, [cue('00:02:00', '00:02:30', '00:00:30', 'Beta')], { valid: false })
  })));
  await h.ctx.syncGoogleSheet(h.ctx.state.preferences.googleSheets[0]);
  assert.equal(h.ctx.bulkImportPending.total.files, 1);
  assert.equal(h.ctx.bulkImportPending.total.errors, 1);
  assert.equal(h.ctx.bulkImportPending.total.removedTabs, 1);
  assert.equal(h.ctx.importQueue.find(item => item.sheet === 'Episode 2').queueState, 'error');
  assert.equal(h.ctx.importQueue.find(item => item.sheet === 'Episode 3').queueState, 'removed');
  assert.match(h.ctx.bulkImportReviewView(), /1 previously linked tab is missing/);
  assert.match(h.ctx.bulkQueueView(), /Episode 3[\s\S]*Will remove/);
  assert.equal(googleOccurrences(h.ctx.state).length, 3);
  h.ctx.confirmBulkImport();
  const current = googleOccurrences(h.ctx.state);
  assert.equal(current.length, 2);
  assert.equal(current.find(use => use.googleSheetTab === 'Episode 1').duration, 25);
  assert.equal(current.find(use => use.googleSheetTab === 'Episode 2').duration, 30);
  assert.equal(current.some(use => use.googleSheetTab === 'Episode 3'), false);
  assert.equal(h.ctx.importQueue.find(item => item.sheet === 'Episode 3').queueState, 'removed-complete');
  assert.deepEqual(Array.from(h.ctx.state.preferences.googleSheets[0].tabBaselines, item => item.tab), ['Episode 1', 'Episode 2']);
  assert.match(h.ctx.bulkQueueView(), /Episode 3[\s\S]*Removed/);
});

test('a worksheet that fails final validation keeps its previously imported cues', async () => {
  const h = harness();
  h.responses.push(fetchedWorkbook(workbook({
    'Episode 1': episode(1, [cue('00:01:00', '00:01:20', '00:00:20', 'Alpha')]),
    'Episode 2': episode(2, [cue('00:02:00', '00:02:30', '00:00:30', 'Beta')])
  })));
  await h.ctx.syncGoogleSheet({ url: shareUrl, projectName: 'Test Series' });
  h.ctx.confirmBulkImport();

  const validate = h.ctx.bulkValidateSession;
  let episodeTwoChecks = 0;
  h.ctx.bulkValidateSession = session => {
    if (session.sheet === 'Episode 2' && ++episodeTwoChecks === 2) return ['Final validation failed'];
    return validate(session);
  };
  h.responses.push(fetchedWorkbook(workbook({
    'Episode 1': episode(1, [cue('00:01:00', '00:01:25', '00:00:25', 'Alpha')]),
    'Episode 2': episode(2, [cue('00:02:00', '00:02:35', '00:00:35', 'Beta')])
  })));
  await h.ctx.syncGoogleSheet(h.ctx.state.preferences.googleSheets[0]);

  assert.equal(h.ctx.bulkImportPending.total.files, 1);
  assert.equal(h.ctx.bulkImportPending.total.errors, 1);
  assert.equal(h.ctx.bulkImportPending.total.replacedGooglePlays, 1);
  const candidateUses = googleOccurrences(h.ctx.bulkImportPending.candidate);
  assert.equal(candidateUses.find(use => use.googleSheetTab === 'Episode 1').duration, 25);
  assert.equal(candidateUses.find(use => use.googleSheetTab === 'Episode 2').duration, 30);
  h.ctx.confirmBulkImport();
  assert.equal(googleOccurrences(h.ctx.state).length, 2);
});

test('a removal-only sync still opens review and requires confirmation', async () => {
  const h = harness();
  h.responses.push(fetchedWorkbook(workbook({
    'Episode 1': episode(1, [cue('00:01:00', '00:01:20', '00:00:20', 'Alpha')])
  })));
  await h.ctx.syncGoogleSheet({ url: shareUrl, projectName: 'Test Series' });
  h.ctx.confirmBulkImport();

  h.responses.push(fetchedWorkbook(workbook({ Notes: [['No workfile tabs remain']] })));
  await h.ctx.syncGoogleSheet(h.ctx.state.preferences.googleSheets[0]);
  assert.equal(h.ctx.bulkImportPending.total.files, 0);
  assert.equal(h.ctx.bulkImportPending.total.removedTabs, 1);
  assert.equal(googleOccurrences(h.ctx.state).length, 1);
  assert.equal(googleOccurrences(h.ctx.bulkImportPending.candidate).length, 0);
  h.ctx.confirmBulkImport();
  assert.equal(googleOccurrences(h.ctx.state).length, 0);
  assert.equal(h.ctx.bulkImportSummary.removedTabs, 1);
  assert.equal(h.ctx.state.preferences.googleSheets[0].tabBaselines.length, 0);
});

test('episode metadata follows Sheet changes until independently edited in CMS', async () => {
  const h = harness();
  const row = cue('00:01:00', '00:01:20', '00:00:20', 'Alpha');
  h.responses.push(fetchedWorkbook(workbook({ 'Episode 1': episode(1, [row], { name: 'First title' }) })));
  await h.ctx.syncGoogleSheet({ url: shareUrl, projectName: 'Test Series' });
  h.ctx.confirmBulkImport();
  const firstEpisode = h.ctx.state.projects[0].episodes[0];
  assert.equal(firstEpisode.title, 'First title');
  assert.equal(firstEpisode.duration, '00:24:06');
  assert.equal(firstEpisode.airdate, '12 Sep 2022');

  h.responses.push(fetchedWorkbook(workbook({
    'Episode 1': episode(1, [row], { name: 'Second title', duration: '00:25:00', date: '13 Sep 2022' })
  })));
  await h.ctx.syncGoogleSheet(h.ctx.state.preferences.googleSheets[0]);
  assert.equal(h.ctx.state.projects[0].episodes[0].title, 'First title');
  h.ctx.confirmBulkImport();
  const updatedEpisode = h.ctx.state.projects[0].episodes[0];
  assert.equal(updatedEpisode.title, 'Second title');
  assert.equal(updatedEpisode.duration, '00:25:00');
  assert.equal(updatedEpisode.airdate, '13 Sep 2022');

  updatedEpisode.title = 'My CMS title';
  updatedEpisode.duration = '00:45:00';
  updatedEpisode.airdate = '20 Sep 2022';
  h.responses.push(fetchedWorkbook(workbook({
    'Episode 1': episode(1, [row], { name: 'Third title', duration: '00:26:00', date: '14 Sep 2022' })
  })));
  await h.ctx.syncGoogleSheet(h.ctx.state.preferences.googleSheets[0]);
  h.ctx.confirmBulkImport();
  const preservedEpisode = h.ctx.state.projects[0].episodes[0];
  assert.equal(preservedEpisode.title, 'My CMS title');
  assert.equal(preservedEpisode.duration, '00:45:00');
  assert.equal(preservedEpisode.airdate, '20 Sep 2022');
  const baseline = h.ctx.state.preferences.googleSheets[0].tabBaselines[0];
  assert.equal(baseline.title, 'Third title');
  assert.equal(baseline.duration, '00:26:00');
  assert.equal(baseline.airdate, '14 Sep 2022');
});

test('Excel import launched from a project uses its ID even when C1 and filename have another name', async () => {
  const h = harness();
  h.ctx.state.projects.push(savedProject());
  h.ctx.state.projects.push({ ...savedProject(), id: 'PRJ-title-collision', title: 'A Different Title' });
  const bytes = workbook({
    'Episode 7': episode(7, [cue('00:01:00', '00:01:20', '00:00:20', 'Bound Excel Cue')], {
      name: 'A Different Title'
    })
  });

  await h.ctx.bulkReadFiles([uploadWorkbook(bytes, 'Unrelated Filename.xlsx')], {
    projectId: 'PRJ-existing', projectName: 'Already Created'
  });

  assert.equal(h.saves(), 0, 'the usual review is still required');
  assert.equal(h.ctx.bulkImportPending.total.files, 1);
  assert.equal(h.ctx.bulkImportPending.candidate.projects.length, 2);
  assert.equal(h.ctx.bulkImportPending.candidate.projects[0].title, 'Already Created');
  assert.equal(h.ctx.bulkImportPending.candidate.cues[0].projectId, 'PRJ-existing');
  h.ctx.confirmBulkImport();
  assert.equal(h.ctx.state.projects.length, 2);
  assert.equal(h.ctx.state.projects[0].episodes[0].number, 7);
  assert.equal(h.ctx.state.projects[1].episodes.length, 0);
  assert.equal(h.ctx.state.imports[0].projectId, 'PRJ-existing');
});

test('Google link needs no repeated project name and stays bound to its project after rename', async () => {
  const h = harness();
  h.ctx.state.projects.push(savedProject());
  h.responses.push(fetchedWorkbook(workbook({
    'Episode 7': episode(7, [cue('00:01:00', '00:01:20', '00:00:20', 'Bound Google Cue')], {
      name: 'Unrelated Sheet Title'
    })
  })));

  await h.ctx.syncGoogleSheet({ url: shareUrl, projectId: 'PRJ-existing' });
  assert.equal(h.ctx.bulkImportPending.total.files, 1);
  assert.equal(h.ctx.bulkImportPending.candidate.projects.length, 1);
  assert.equal(h.ctx.bulkImportPending.candidate.cues[0].projectId, 'PRJ-existing');
  h.ctx.confirmBulkImport();
  const link = h.ctx.state.preferences.googleSheets[0];
  assert.equal(link.projectId, 'PRJ-existing');
  assert.equal(link.projectName, 'Already Created');

  h.ctx.state.projects[0].title = 'Renamed in CMS';
  h.responses.push(fetchedWorkbook(workbook({
    'Episode 7': episode(7, [cue('00:01:00', '00:01:25', '00:00:25', 'Bound Google Cue')], {
      name: 'Another Sheet Title'
    })
  })));
  await h.ctx.syncGoogleSheet({ url: shareUrl, projectId: 'PRJ-existing' });
  assert.equal(h.ctx.bulkImportPending.candidate.projects.length, 1);
  assert.equal(h.ctx.bulkImportPending.candidate.projects[0].title, 'Renamed in CMS');
  h.ctx.confirmBulkImport();
  assert.equal(h.ctx.state.preferences.googleSheets[0].projectId, 'PRJ-existing');
  assert.equal(h.ctx.state.preferences.googleSheets[0].projectName, 'Renamed in CMS');
  assert.equal(googleOccurrences(h.ctx.state).length, 1);
  assert.equal(googleOccurrences(h.ctx.state)[0].duration, 25);
});

test('offline Import workfiles view offers local Excel files only', () => {
  const h = harness();
  const markup = h.ctx.bulkImportView();
  assert.match(markup, /class="[^"]*wi-import-source/);
  assert.match(markup, /id="file-input"/);
  assert.match(markup, /Upload XLSX, XLS, or CSV workfiles from this computer/);
  assert.doesNotMatch(markup, /data-import-source="google"|googleSheetUrl/);
});

test('project Import button opens the local Excel chooser', () => {
  const h = harness();
  h.ctx.state.projects.push(savedProject());

  h.ctx.openWorkfileImportModal('PRJ-existing');
  assert.equal(h.ctx.lastModal.className, 'wi-import-modal');
  assert.match(h.ctx.lastModal.markup, /Already Created/);
  assert.match(h.ctx.lastModal.markup, /id="project-import-file"/);
  assert.doesNotMatch(h.ctx.lastModal.markup, /id="project-google-sheet-form"/);

  h.ctx.importModalSource = 'google';
  h.ctx.renderWorkfileImportModal();
  assert.match(h.ctx.lastModal.markup, /id="project-import-file"/);
  assert.doesNotMatch(h.ctx.lastModal.markup, /googleSheetUrl/);
});

test('a Movie project blocks multi-worksheet preview and points to Series import', () => {
  const h = harness();
  h.ctx.state.projects.push({ ...savedProject(), title: 'trail', type: 'Movie' });
  h.ctx.importTargetProjectId = 'PRJ-existing';
  h.ctx.excelSelection = [{ sheetNames: ['Episode 1', 'Episode 2'], from: 1, to: 2 }];
  assert.match(h.ctx.excelSelectionPlan().error, /trail is a Movie project.*Series project.*Import workfiles/);
  h.ctx.importTargetProjectId = null;
  assert.equal(h.ctx.excelSelectionPlan().error, '');
});

for (const count of [200, 250]) test(count + ' Excel workfiles reuse saved song details, retain every episode and sync after one review', async () => {
  const h = harness();
  h.ctx.state.projects.push(savedProject());
  const song = { id: 'WRK-known', title: 'Known Song', isrc: '000123456789',
    societies: { IPRS: '000123', PRS: '000456', ASCAP: '000789' },
    parties: [{ name: 'Saved Composer', role: 'Composer', share: 100, society: 'IPRS/PRS/ASCAP', ipi: '00012345' }] };
  h.ctx.state.works.push(song);
  const files = Array.from({ length: count }, (_, index) => uploadWorkbook(workbook({
    Workfile: episode(index + 1, [cue('00:00:00', '00:00:10', '00:00:10', 'Known Song')])
  }), 'Episode_' + (index + 1) + '.xlsx'));
  await h.ctx.bulkReadFiles(files, { projectId: 'PRJ-existing' });
  assert.equal(h.saves(), 0);
  assert.equal(h.syncs(), 0);
  assert.equal(h.ctx.bulkImportPending.total.files, count);
  assert.equal(h.ctx.bulkImportPending.total.errors, 0);
  assert.equal(h.ctx.importQueue.length, count);
  assert.equal(h.ctx.bulkImportPending.candidate.works.length, 1);
  await h.ctx.confirmBulkImport();
  assert.equal(h.saves(), 1);
  assert.equal(h.syncs(), 1);
  assert.equal(h.ctx.bulkImportSummary.syncKind, 'synced');
  assert.equal(h.ctx.state.imports.length, count);
  assert.equal(h.ctx.state.cues.length, count);
  assert.equal(h.ctx.state.projects[0].episodes.length, count);
  assert.equal(new Set(h.ctx.state.cues.map(item => item.episode)).size, count);
  assert.ok(h.ctx.state.cues.every(item => item.workId === song.id && item.duration === 10));
  assert.equal(h.ctx.state.works[0].isrc, song.isrc);
  assert.deepEqual(JSON.parse(JSON.stringify(h.ctx.state.works[0].parties)), song.parties);
  assert.match(h.ctx.bulkImportView(), /Saved to database/);
});

test('251 files are rejected before any read or change, with a clear message', async () => {
  const h = harness();
  let reads = 0;
  h.ctx.CueFileSafety.read = async () => { reads++; };
  const before = JSON.stringify(h.ctx.state);
  await h.ctx.bulkReadFiles(Array.from({ length: 251 }, (_, index) => ({ name: index + '.xlsx', size: 100 })));
  assert.equal(reads, 0);
  assert.equal(h.saves(), 0);
  assert.equal(h.syncs(), 0);
  assert.equal(JSON.stringify(h.ctx.state), before);
  assert.match(h.notices.at(-1), /250.*251.*no files were processed/);
});

test('Excel range is selected before a compact review and leaves unselected episodes out', async () => {
  const h = harness();
  h.ctx.state.projects.push(savedProject());
  h.ctx.importTargetProjectId = 'PRJ-existing';
  const sheets = Object.fromEntries(Array.from({ length: 5 }, (_, index) => ['Episode ' + (index + 1), episode(index + 1, [cue('00:01:00', '00:01:20', '00:00:20', 'Song ' + (index + 1))]) ]));
  await h.ctx.chooseExcelFiles([uploadWorkbook(workbook(sheets))]);
  assert.equal(h.ctx.excelSelection.length, 1);
  assert.equal(h.ctx.excelSelection[0].to, 5);
  assert.equal(h.saves(), 0);
  h.ctx.excelSelection[0].from = 3;
  h.ctx.excelSelection[0].to = 4;
  assert.match(h.ctx.excelRangeView(), /2 \/ 250 episodes selected/);
  await h.ctx.previewExcelSelection();
  assert.equal(h.ctx.bulkImportPending.total.files, 2);
  assert.equal(h.saves(), 0);
  const preview = h.ctx.bulkImportReviewView();
  assert.match(preview, /Song 3/);
  assert.match(preview, /Song 4/);
  assert.doesNotMatch(preview, /Song 1/);
  h.ctx.confirmBulkImport();
  assert.deepEqual(Array.from(h.ctx.state.projects[0].episodes, item => item.number), [3, 4]);
});

test('Excel selection rejects more than 250 episodes before reading cue rows', async () => {
  const h = harness();
  let reads = 0;
  h.ctx.CueFileSafety.read = async () => { reads++; };
  h.ctx.excelSelection = [{ file: { name: 'big.xlsx' }, sheetNames: Array.from({ length: 251 }, (_, index) => 'Episode ' + (index + 1)), from: 1, to: 251 }];
  await h.ctx.previewExcelSelection();
  assert.equal(reads, 0);
  assert.equal(h.saves(), 0);
  assert.match(h.ctx.excelSelectionError, /250 episodes/);
});

test('batch completion waits for database acknowledgement and later retries update the status', async () => {
  const h = harness({ syncResult: false });
  const file = uploadWorkbook(workbook({ Workfile: episode(1, [cue('00:00:00', '00:00:10', '00:00:10', 'Song')]) }));
  await h.ctx.bulkReadFiles([file]);
  let finish;
  h.ctx.persistence.sync = () => new Promise(resolve => { finish = resolve; });
  const pending = h.ctx.confirmBulkImport();
  assert.equal(h.ctx.bulkImportSummary.syncKind, 'syncing');
  assert.match(h.ctx.bulkImportView(), /SAVING TO DATABASE/);
  assert.doesNotMatch(h.ctx.bulkImportView(), /BATCH COMPLETE/);
  finish(false);
  await pending;
  assert.equal(h.ctx.bulkImportSummary.syncKind, 'pending');
  assert.match(h.ctx.bulkImportView(), /SAVED ON THIS DEVICE/);
  assert.equal(h.ctx.state.cues.length, 1);
  h.ctx.updateBulkImportSyncStatus({ kind: 'synced', pending: false, message: 'Saved to MongoDB' });
  assert.equal(h.ctx.bulkImportSummary.syncKind, 'synced');
  assert.match(h.ctx.bulkImportView(), /Saved to database/);
});

test('a device save failure restores the previous workspace and never starts database sync', async () => {
  const h = harness({ saveResult: false });
  const before = JSON.stringify(h.ctx.state);
  await h.ctx.bulkReadFiles([uploadWorkbook(workbook({ Workfile: episode(1, [cue('00:00:00', '00:00:10', '00:00:10', 'Song')]) }))]);
  await h.ctx.confirmBulkImport();
  assert.equal(JSON.stringify(h.ctx.state), before);
  assert.equal(h.syncs(), 0);
  assert.equal(h.ctx.bulkImportSummary.files, 0);
  assert.equal(h.ctx.importQueue[0].queueState, 'error');
});
