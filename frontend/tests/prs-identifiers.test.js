'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const XLSX = require('../public/vendor/xlsx.full.min.js');
const JSZip = require('../public/vendor/jszip.min.js');
const CueSocieties = require('../public/societies.js');
const source = readFileSync(join(__dirname, '../public/dashboard.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function harness() {
  const context = vm.createContext({ Buffer, Uint8Array, TextDecoder, XLSX, JSZip,
    CueSocieties, structuredClone, crypto: globalThis.crypto });
  context.window = context;
  vm.runInContext(source.slice(0, source.indexOf('/* iprs.js */')), context);
  vm.runInContext(source.slice(source.indexOf('/* catalog.js */'), source.indexOf('/* app.prototype.js */')), context);
  return context;
}

function song(values = {}) {
  return { id: 'song', title: 'Saved song', artist: 'Singer', societies: {}, parties: [], ...values };
}

test('PRS work identifiers read either legacy field without changing stored data or leading zeros', () => {
  const { CueDomain: D } = harness();
  for (const [work, expected] of [
    [song({ tuneCode: '  000TEST123AB  ' }), '000TEST123AB'],
    [song({ societies: { PRS: '  000TEST123AB  ' } }), '000TEST123AB'],
    [song({ tuneCode: ' ', societies: { PRS: '0007' } }), '0007'],
    [song({ tuneCode: 'TUNE-OLD', societies: { PRS: 'PRS-OLD' } }), 'TUNE-OLD'],
    [song(), ''],
  ]) {
    const before = structuredClone(work);
    assert.equal(D.prsWorkId(work), expected);
    assert.deepEqual(work, before);
  }
});

test('editing or clearing the shared PRS identifier keeps both saved aliases synchronized', () => {
  const { CueDomain: D } = harness();
  const work = song({ tuneCode: 'OLD-TUNE', societies: { PRS: 'OLD-PRS', IPRS: 'IPRS-1', ASCAP: 'ASCAP-1' } });
  D.setPrsWorkId(work, '  000928AB  ');
  assert.equal(work.tuneCode, '000928AB');
  assert.equal(work.societies.PRS, '000928AB');
  assert.equal(work.societies.IPRS, 'IPRS-1');
  assert.equal(work.societies.ASCAP, 'ASCAP-1');
  D.setPrsWorkId(work, '');
  assert.equal(work.tuneCode, '');
  assert.equal(work.societies.PRS, '');
  const withoutSocieties = song(); delete withoutSocieties.societies;
  D.setPrsWorkId(withoutSocieties, '00012');
  assert.equal(withoutSocieties.societies.PRS, '00012');
});

test('the song editor synchronizes an explicit PRS field and preserves it when another tab is saved', () => {
  const context = harness();
  let values = { PRS: '  000928AB  ' };
  const form = { elements: { namedItem: () => null }, querySelectorAll: () => [] };
  context.document = { querySelector: () => form };
  context.FormData = class {
    has(name) { return Object.hasOwn(values, name); }
    get(name) { return values[name] ?? null; }
    getAll(name) { return values[name] == null ? [] : [values[name]]; }
  };
  context.modalWork = song({ tuneCode: '000TEST123AB', societies: { IPRS: 'KEEP-IPRS' } });
  context.workTab = 'Society IDs';
  context.D = context.CueDomain;
  vm.runInContext(source.slice(source.indexOf('function collectWork(){'), source.indexOf('function performerField(')), context);
  context.collectWork();
  assert.equal(context.modalWork.tuneCode, '000928AB');
  assert.equal(context.modalWork.societies.PRS, '000928AB');
  assert.equal(context.modalWork.societies.IPRS, 'KEEP-IPRS');
  values = { notes: 'Updated from Overview' }; context.workTab = 'Overview';
  context.collectWork();
  assert.equal(context.modalWork.tuneCode, '000928AB');
  assert.equal(context.modalWork.societies.PRS, '000928AB');
  values = { PRS: '' }; context.workTab = 'Society IDs';
  context.collectWork();
  assert.equal(context.modalWork.tuneCode, '');
  assert.equal(context.modalWork.societies.PRS, '');
});

for (const header of ['Tune Code', 'PRS Work ID', 'PRS Work Code', 'PRS ID']) {
  test(`${header} uploads populate the shared PRS work identifier`, () => {
    const { CueDatabaseImport: importer } = harness();
    const state = { works: [] };
    const mapping = importer.mapping(['Song Name', header]);
    const preview = importer.preview([['New song', '000TEST123AB']], mapping, state.works);
    assert.equal(preview[0].issues.length, 0);
    const result = importer.execute(state, preview, 'songs.csv');
    assert.equal(result.added, 1);
    assert.equal(state.works[0].tuneCode, '000TEST123AB');
    assert.equal(state.works[0].societies.PRS, '000TEST123AB');
  });
}

test('equivalent Tune Code and PRS Work ID columns import one synchronized identifier', () => {
  const { CueDatabaseImport: importer } = harness();
  const state = { works: [] };
  const preview = importer.preview([['New song', '  000TEST123AB  ', '000test123ab']],
    importer.mapping(['Song Name', 'Tune Code', 'PRS Work ID']), state.works);
  assert.equal(preview[0].issues.length, 0);
  const result = importer.execute(state, preview, 'both-aliases.csv');
  assert.equal(result.added, 1);
  assert.equal(state.works.length, 1);
  assert.equal(state.works[0].tuneCode, '000TEST123AB');
  assert.equal(state.works[0].societies.PRS, '000TEST123AB');
});

test('blank alias columns do not erase the populated PRS work identifier', () => {
  const { CueDatabaseImport: importer } = harness();
  for (const identifiers of [['000TEST123AB', ''], ['', '000TEST123AB']]) {
    const state = { works: [] };
    const preview = importer.preview([['New song', ...identifiers]],
      importer.mapping(['Song Name', 'Tune Code', 'PRS Work ID']), state.works);
    assert.equal(preview[0].issues.length, 0);
    assert.equal(importer.execute(state, preview, 'blank-alias.csv').added, 1);
    assert.equal(state.works[0].tuneCode, '000TEST123AB');
    assert.equal(state.works[0].societies.PRS, '000TEST123AB');
  }
});

test('conflicting Tune Code and PRS Work ID columns block import without any workspace mutation', () => {
  const { CueDatabaseImport: importer } = harness();
  const state = { works: [song({ tuneCode: 'SAVED', societies: { PRS: 'SAVED' } })],
    activity: [{ text: 'Existing activity' }], imports: [{ filename: 'existing.csv' }] };
  const before = structuredClone(state);
  const preview = importer.preview([['New song', 'TUNE-VALUE', 'PRS-VALUE']],
    importer.mapping(['Song Name', 'Tune Code', 'PRS Work ID']), state.works);
  assert.ok(preview[0].issues.length > 0);
  assert.match(preview[0].errors.join(' '), /PRS|Tune/i);
  assert.throws(() => importer.execute(state, preview, 'conflicting-aliases.csv'));
  assert.deepEqual(state, before);
});

test('an extra PRS Work ID column on the standard template is checked against its Tune Code column', () => {
  const { CueDatabaseImport: importer } = harness();
  const headers = [...importer.templateHeaders, 'PRS Work ID'];
  const cells = importer.templateFields.map(field => field === 'title' ? 'Template song' : field === 'tuneCode' ? 'TEMPLATE-TUNE' : '');
  cells.push('EXTRA-PRS');
  const state = { works: [] }, before = structuredClone(state);
  const preview = importer.preview([cells], importer.mapping(headers), state.works);
  assert.ok(preview[0].issues.length > 0);
  assert.match(preview[0].errors.join(' '), /PRS|Tune/i);
  assert.throws(() => importer.execute(state, preview, 'template-with-extra-alias.xlsx'));
  assert.deepEqual(state, before);
});

test('song uploads find PRS-only legacy records and can fill the missing song name', () => {
  const { CueDatabaseImport: importer } = harness();
  const work = song({ societies: { PRS: '000TEST123AB' } }), before = structuredClone(work);
  const preview = importer.preview([['000TEST123AB']], importer.mapping(['Tune Code']), [work]);
  assert.equal(preview[0].issues.length, 0);
  assert.equal(preview[0].matchedExistingId, 'song');
  assert.equal(preview[0].record.title, 'Saved song');
  assert.deepEqual(work, before, 'preview must remain read-only');
});

test('updating a matched PRS-only song writes both aliases without creating another record', () => {
  const { CueDatabaseImport: importer } = harness();
  const state = { works: [song({ societies: { PRS: 'OLD-PRS', IPRS: 'KEEP-IPRS' } })] };
  const preview = importer.preview([['Saved song', '000928AB']], importer.mapping(['Song Name', 'PRS Work ID']), state.works);
  assert.equal(preview[0].matchedExistingId, 'song');
  const result = importer.execute(state, preview, 'songs.csv', { strategy: 'update' });
  assert.deepEqual(plain(result), { added: 0, updated: 1, skipped: 0, total: 1 });
  assert.equal(state.works.length, 1);
  assert.equal(state.works[0].tuneCode, '000928AB');
  assert.equal(state.works[0].societies.PRS, '000928AB');
  assert.equal(state.works[0].societies.IPRS, 'KEEP-IPRS');
});

test('both conflicting legacy aliases stay matchable and skipped imports preserve their original values', () => {
  const { CueDatabaseImport: importer } = harness();
  const state = { works: [song({ tuneCode: 'LEGACY-TUNE', societies: { PRS: 'LEGACY-PRS' } })] };
  const before = structuredClone(state);
  for (const identifier of ['LEGACY-TUNE', 'LEGACY-PRS']) {
    const preview = importer.preview([[identifier]], importer.mapping(['PRS ID']), state.works);
    assert.equal(preview[0].issues.length, 0);
    assert.equal(preview[0].matchedExistingId, 'song');
    const result = importer.execute(state, preview, 'songs.csv');
    assert.equal(result.skipped, 1);
    assert.deepEqual(state, before);
  }
});

test('merging a Tune-only source retains the target PRS identifier and records the source conflict', () => {
  const { CueCatalog: catalog, CueDomain: D } = harness();
  const target = song({ id: 'target', title: 'Keep this song', societies: { PRS: 'TARGET', IPRS: 'KEEP-IPRS' } });
  const sourceSong = song({ id: 'source', title: 'Duplicate song', tuneCode: 'SOURCE' });
  const other = song({ id: 'unrelated', title: 'Other song', tuneCode: 'UNCHANGED' });
  const state = { works: [target, sourceSong, other], artists: [],
    cues: [{ id: 'source-cue', workId: 'source', duration: 10 }, { id: 'other-cue', workId: 'unrelated', duration: 20 }],
    deletedCues: [], exports: [{ id: 'historical', snapshot: { works: [structuredClone(sourceSong)] } }] };
  const before = structuredClone(state);
  const result = catalog.mergeSong(state, 'source', 'target');
  assert.equal(D.prsWorkId(result.target), 'TARGET');
  assert.equal(result.target.tuneCode, 'TARGET');
  assert.equal(result.target.societies.PRS, 'TARGET');
  assert.equal(result.target.societies.IPRS, 'KEEP-IPRS');
  assert.ok(result.target.mergeConflicts.some(conflict => conflict.kept === 'TARGET' &&
    conflict.merged === 'SOURCE' && conflict.sourceId === 'source'));
  assert.equal(state.cues[0].workId, 'target');
  assert.deepEqual(state.works.find(work => work.id === 'unrelated'), before.works[2]);
  assert.deepEqual(state.cues[1], before.cues[1]);
  assert.deepEqual(state.exports, before.exports);
  assert.deepEqual(sourceSong, before.works[1]);
});

for (const stored of ['tuneCode', 'PRS']) test(`PRS exports use ${stored}-only legacy identifiers without mutating source records`, async () => {
  const { CueExports: exports } = harness();
  const identifier = '000TEST123AB';
  const work = song({ parties: [{ name: 'Writer', role: 'Composer', society: 'PRS', share: 100, ipi: '000123' }],
    ...(stored === 'tuneCode' ? { tuneCode: identifier } : { societies: { PRS: identifier } }) });
  const input = {
    project: { id: 'production', title: 'Local production', type: 'Movie', periods: [], episodes: [] },
    cues: [{ id: 'cue', workId: 'song', duration: 35, usage: 'FV', societyUsage: { PRS: 'F' } }],
    works: [work],
  };
  const before = structuredClone(input);
  const structural = exports.build('PRS', input.project, null, input.cues, input.works);
  assert.equal(structural.Sheets[structural.SheetNames[0]].L19.v, identifier);
  const bytes = await exports.buildFormatted('PRS', input.project, null, input.cues, input.works);
  const formatted = XLSX.read(bytes, { type: 'array' });
  assert.equal(formatted.Sheets[formatted.SheetNames[0]].L19.v, identifier);
  assert.deepEqual(input, before);
});
