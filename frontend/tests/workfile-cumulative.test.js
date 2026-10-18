'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const XLSX = require('../public/vendor/xlsx.full.min.js');

const source = readFileSync(join(__dirname, '../public/dashboard.js'), 'utf8');
const context = { structuredClone };
context.window = context;
vm.createContext(context);
vm.runInContext(source.slice(0, source.indexOf('/* file-safety.js')), context);
context.D = context.CueDomain;
let nextId = 0;
context.uid = prefix => prefix + '-' + ++nextId;
vm.runInContext(source.slice(source.indexOf('function bulkColumnField('), source.indexOf('function bulkQueueView()')), context);

function session(filename, episode = 1) {
  const raw = [
    ['00:24:06', '12 Sep 2022', 'Example Serial', '', episode],
    ['In Time', 'Out Time', 'Duration', 'Track Name'],
    ['00:01:02', '00:01:25', '00:00:23', 'Bhoomi music'],
    ['00:01:58', '00:02:58', '00:01:00', 'Kesariya'],
    ['00:03:58', '00:04:58', '00:01:00', 'Kesariya'],
    ['00:04:59', '00:05:58', '00:00:59', 'Kesariya'],
    ['00:06:30', '00:06:41', '00:00:11', 'Beharmi']
  ];
  return { filename, sheet: 'Workfile', raw, workfile: context.D.fixedWorkfile(raw), defaultProjectType: 'Series', inferenceWarnings: [] };
}

test('repeated track rows import as one cumulative cue and preserve each occurrence', () => {
  const workspace = { projects: [], works: [], cues: [], imports: [] };
  const first = context.bulkApplySession(session('episode-1.xlsx'), workspace, new Map(), new Set());
  assert.equal(first.cues, 3);
  assert.equal(first.usages, 5);
  assert.equal(workspace.cues.length, 3);
  const kesariya = workspace.cues.find(cue => workspace.works.find(work => work.id === cue.workId)?.title === 'Kesariya');
  assert.equal(kesariya.duration, 179);
  assert.equal(kesariya.usageCount, 3);
  assert.equal(kesariya.start, null);
  assert.equal(kesariya.end, null);
  assert.deepEqual(Array.from(kesariya.occurrences, use => [use.start, use.end, use.duration]), [[118, 178, 60], [238, 298, 60], [299, 358, 59]]);
  assert.equal(workspace.cues.reduce((sum, cue) => sum + cue.duration, 0), 213);

  const again = context.bulkApplySession(session('episode-1.xlsx'), workspace, new Map(), new Set());
  assert.equal(again.cues, 0);
  assert.equal(again.usages, 0);
  assert.equal(again.duplicates, 5);
  assert.equal(workspace.cues.length, 3);
  assert.equal(kesariya.duration, 179);

  const extra = session('episode-1-extra.xlsx');
  extra.raw = [...extra.raw.slice(0, 2), ['00:07:00', '00:07:10', '00:00:10', 'Kesariya']];
  extra.workfile = context.D.fixedWorkfile(extra.raw);
  const added = context.bulkApplySession(extra, workspace, new Map(), new Set());
  assert.equal(added.cues, 0);
  assert.equal(added.usages, 1);
  assert.equal(kesariya.duration, 189);
  assert.equal(kesariya.usageCount, 4);

  const second = context.bulkApplySession(session('episode-2.xlsx', 2), workspace, new Map(), new Set());
  assert.equal(second.cues, 3);
  assert.equal(second.usages, 5);
  assert.equal(workspace.cues.length, 6);
  assert.equal(workspace.cues.filter(cue => cue.episode === 2 && cue.workId === kesariya.workId).length, 1);
});

test('edited occurrences validate timing and allow different songs to be separated', () => {
  const rows = [
    { title: 'City Dreams', startText: '00:01:10', endText: '00:02:14' },
    { title: 'Different Song', startText: '00:06:58', endText: '00:07:17' }
  ];
  const valid = context.D.validateOccurrenceRows(rows, 1800);
  assert.equal(valid.errors.length, 0);
  assert.equal(valid.duration, 83);
  assert.equal(context.D.validateOccurrenceRows([{ ...rows[0], endText: '00:00:59' }], 1800).errors.length, 1);
  assert.equal(context.D.validateOccurrenceRows([rows[0], { ...rows[0] }], 1800).errors.length, 1);
});

test('workfile import rejects placeholders and invalid timing before changing the workspace', () => {
  const workspace = { projects: [], works: [], cues: [], imports: [] };
  const placeholder = session('blank-template.xlsx');
  placeholder.raw[0] = ['HH:MM:SS', 'DD MMM YYYY', 'Episode name', '', 1];
  placeholder.workfile = context.D.fixedWorkfile(placeholder.raw);
  const rejected = context.bulkApplySession(placeholder, workspace, new Map(), new Set());
  assert.equal(rejected.cues, 0);
  assert.equal(placeholder.queueState, 'error');
  assert.equal(workspace.projects.length, 0);
  assert.match(placeholder.setupError, /A1|B1|C1/);

  const invalid = session('bad-times.xlsx');
  invalid.raw[3][1] = '00:01:00';
  invalid.workfile = context.D.fixedWorkfile(invalid.raw);
  context.bulkApplySession(invalid, workspace, new Map(), new Set());
  assert.equal(invalid.queueState, 'error');
  assert.equal(workspace.cues.length, 0);
  assert.match(invalid.setupError, /Row 4/);
});

test('downloadable workfile has row 2 headers and no example cues to import', () => {
  const workbook = XLSX.read(readFileSync(join(__dirname, '../public/Fixed-Workfile-Template.xlsx')), { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets.Workfile, { header: 1, defval: '', raw: true, blankrows: true });
  assert.deepEqual(rows[0], ['Total duration', 'Date', 'Project name', '', 'Episode number']);
  assert.deepEqual(rows[1].slice(0, 4), ['In Time', 'Out Time', 'Duration', 'Track Name']);
  assert.equal(rows.slice(2).flat().filter(Boolean).length, 0);
  const workfile = context.D.fixedWorkfile(rows);
  assert.equal(workfile.dataStartIndex, 2);
  assert.ok(context.D.validateFixedWorkfile(workfile).length >= 3);
});

test('saved imported duplicates consolidate within an episode on load', () => {
  const workspace = { cues: [
    { id: 'old-1', projectId: 'series', episode: 3, workId: 'city-dreams', usage: 'FV', start: 120, end: 140, duration: 20, importSourceKey: 'old.xlsx|Workfile|3' },
    { id: 'old-2', projectId: 'series', episode: 3, workId: 'city-dreams', usage: 'FV', start: 418, end: 437, duration: 19, importSourceKey: 'old.xlsx|Workfile|5' },
    { id: 'other-episode', projectId: 'series', episode: 4, workId: 'city-dreams', usage: 'FV', start: 100, end: 130, duration: 30, importSourceKey: 'next.xlsx|Workfile|3' },
    { id: 'manual', projectId: 'series', episode: 3, workId: 'city-dreams', usage: 'FV', start: 500, end: 520, duration: 20 }
  ] };
  assert.equal(context.D.combineImportedOccurrences(workspace), true);
  assert.equal(workspace.cues.length, 3);
  const combined = workspace.cues.find(cue => cue.id === 'old-1');
  assert.equal(combined.duration, 39);
  assert.equal(combined.usageCount, 2);
  assert.deepEqual(Array.from(combined.occurrences, use => [use.start, use.end, use.duration]), [[120, 140, 20], [418, 437, 19]]);
  assert.equal(workspace.cues.find(cue => cue.id === 'other-episode').duration, 30);
  assert.equal(workspace.cues.find(cue => cue.id === 'manual').duration, 20);
  assert.equal(context.D.combineImportedOccurrences(workspace), false);
});

test('batch review does not save until valid worksheets are confirmed', async () => {
  const raw = session('review.xlsx').raw;
  const sheet = XLSX.utils.aoa_to_sheet(raw);
  const original = { projects: [], works: [], cues: [], imports: [], activity: [] };
  let saves = 0, next = 0;
  const ctx = vm.createContext({
    structuredClone, setTimeout, XLSX, D: context.D, state: original, dataRevision: 0,
    workspaceClosed: false, bulkImportActive: false, bulkImportPending: null, page: 'import',
    bulkImportSummary: null, importQueue: [], importReadProgress: null,
    importDefaultType: 'Series', importMovieFields: [], importMovieDetails: {},
    bulkMovieDetailsError: () => '', renderPage: () => {}, toast: () => {},
    uid: prefix => prefix + '-' + ++next,
    CueFileSafety: { read: async () => ({ SheetNames: ['Workfile'], Sheets: { Workfile: sheet } }) },
    save: () => { saves++;ctx.dataRevision++;return true; },
    persistence: { sync: async () => true, getStatus: () => ({ kind: 'synced', pending: false, message: 'Saved to MongoDB' }) }
  });
  vm.runInContext(source.slice(source.indexOf('function bulkColumnField('), source.indexOf('function bulkQueueView()')), ctx);
  vm.runInContext(source.slice(source.indexOf('async function bulkReadFiles('), source.indexOf('const importView=bulkImportView')), ctx);
  await ctx.bulkReadFiles([{ name: 'review.xlsx', size: 100, lastModified: 1 }]);
  assert.equal(saves, 0);
  assert.equal(ctx.state, original);
  assert.equal(ctx.bulkImportPending.total.cues, 3);
  assert.equal(ctx.bulkImportPending.total.usages, 5);
  assert.equal(ctx.importQueue[0].queueState, 'ready');
  await ctx.confirmBulkImport();
  assert.equal(saves, 1);
  assert.equal(ctx.state.cues.length, 3);
  assert.equal(ctx.importQueue[0].queueState, 'complete');
});
