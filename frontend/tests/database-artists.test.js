'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const XLSX = require('../public/vendor/xlsx.full.min.js');
const JSZip = require('../public/vendor/jszip.min.js');
const source = readFileSync(join(__dirname, '../public/dashboard.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function harness() {
  const context = { Uint8Array, TextDecoder, XLSX, JSZip, structuredClone, crypto: { randomUUID } };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('/* file-safety.js'), source.indexOf('/* data.js */')), context);
  vm.runInContext(readFileSync(join(__dirname, '../public/societies.js'), 'utf8'), context);
  vm.runInContext(source.slice(source.indexOf('/* catalog.js */'), source.indexOf('/* app.prototype.js */')), context);
  return context;
}

function upload(rows, extension = 'xlsx') {
  let bytes;
  if (extension === 'csv') {
    bytes = Buffer.from(rows.map(row => row.map(value => '"' + String(value).replace(/"/g, '""') + '"').join(',')).join('\r\n'));
  } else {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Songs');
    bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true });
  }
  return { name: 'songs.' + extension, size: bytes.length, arrayBuffer: async () => Uint8Array.from(bytes).buffer };
}

async function reviewUpload(context, state, rows, extension = 'xlsx') {
  const workbook = await context.CueFileSafety.read(upload(rows, extension), { extensions: ['xlsx', 'csv'], raw: true });
  const cells = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: '', raw: false, blankrows: true });
  const review = context.CueDatabaseImport.preview(cells.slice(1), context.CueDatabaseImport.mapping(cells[0]), state.works);
  assert.equal(review.some(row => row.issues.length), false);
  return review;
}

async function importRows(context, state, rows, { extension = 'xlsx', strategy = 'skip' } = {}) {
  const review = await reviewUpload(context, state, rows, extension);
  const result = context.CueDatabaseImport.execute(state, review, 'songs.' + extension, { strategy });
  // The production save path normalizes artist links after applying the import.
  context.CueCatalog.ensure(state);
  return result;
}

function singerNames(state, work = state.works[0]) {
  return Array.from(work.artistIds, id => state.artists.find(artist => artist.id === id)?.name);
}

for (const extension of ['xlsx', 'csv']) test(`${extension} singer uploads split commas, trim names and deduplicate repeated artists`, async () => {
  const context = harness(), state = { works: [], artists: [] };
  const rows = [['Song Name', 'Singer'], ['Duet', '  Asha Rao, , Dev Mehta, asha rao, DEV MEHTA,  ']];
  const before = plain(state);
  await reviewUpload(context, state, rows, extension);
  assert.deepEqual(state, before, 'preview must not create artist profiles');
  const result = await importRows(context, state, rows, { extension });
  assert.equal(result.added, 1);
  assert.deepEqual(singerNames(state), ['Asha Rao', 'Dev Mehta']);
  assert.equal(state.artists.length, 2);
  assert.ok(state.artists.every(artist => artist.roles.includes('Performer')));
  assert.equal(context.CueCatalog.ensure(state), false, 'repeated normalization is idempotent');
});

test('singers reuse canonical names, aliases and an identified rights holder without duplicate profiles', async () => {
  const context = harness(), state = {
    works: [],
    artists: [{ id: 'asha', name: 'Asha Rao', aliases: ['Asha Stage Name'], ipi: '000123', roles: [] }],
  };
  await importRows(context, state, [
    ['Song Name', 'Singer', 'Composer 1', 'Composer 1 · CAE'],
    ['Duet', 'asha rao, Asha Stage Name, Dev Mehta', 'Dev Mehta', '000456'],
  ]);
  const work = state.works[0], composer = state.artists.find(artist => artist.ipi === '000456');
  assert.deepEqual(singerNames(state), ['Asha Rao', 'Dev Mehta']);
  assert.equal(work.artistIds[0], 'asha');
  assert.equal(work.parties[0].artistId, composer.id);
  assert.ok(work.artistIds.includes(composer.id));
  assert.deepEqual(plain(composer.roles).sort(), ['Composer', 'Performer']);
  assert.equal(state.artists.length, 2);
});

test('multiple songs share individual singer profiles regardless of list order or letter case', async () => {
  const context = harness(), state = { works: [], artists: [] };
  await importRows(context, state, [
    ['Song Name', 'Singer'],
    ['First Song', 'Asha Rao, Dev Mehta'],
    ['Second Song', 'dev mehta, ASHA RAO'],
  ]);
  assert.equal(state.artists.length, 2);
  assert.deepEqual(singerNames(state, state.works[1]), ['Dev Mehta', 'Asha Rao']);
  assert.deepEqual(plain(state.works[1].artistIds).sort(), plain(state.works[0].artistIds).sort());
});

test('syncing a changed Singer replaces stale links with each newly uploaded singer', async () => {
  const context = harness(), state = { works: [], artists: [] };
  await importRows(context, state, [['Song Name', 'Singer', 'ISRC'], ['Duet', 'Old Singer', 'IN1234567890']]);
  const oldId = state.works[0].artistIds[0], workId = state.works[0].id;
  const result = await importRows(context, state, [['Song Name', 'Singer', 'ISRC'], ['Duet', 'Asha Rao, Dev Mehta', 'IN1234567890']], { strategy: 'update' });
  assert.equal(result.updated, 1);
  assert.equal(state.works.length, 1);
  assert.equal(state.works[0].id, workId);
  assert.deepEqual(singerNames(state), ['Asha Rao', 'Dev Mehta']);
  assert.equal(state.works[0].artistIds.includes(oldId), false);
});

test('syncing the same comma-separated Singer preserves the existing artist mapping', async () => {
  const context = harness(), state = {
    works: [{ id: 'song', title: 'Duet', artist: 'Asha Rao, Dev Mehta', artistIds: ['combined'], parties: [] }],
    artists: [{ id: 'combined', name: 'Asha Rao, Dev Mehta', roles: ['Performer'] }],
  };
  context.CueCatalog.ensure(state);
  const result = await importRows(context, state, [['Song Name', 'Singer'], ['Duet', 'Asha Rao, Dev Mehta']], { strategy: 'update' });
  assert.equal(result.updated, 1);
  assert.deepEqual(singerNames(state), ['Asha Rao, Dev Mehta']);
  assert.deepEqual(state.works[0].artistIds, ['combined']);
  assert.equal(state.artists.length, 1);
});

test('skip strategy leaves the existing Singer text and artist links unchanged', async () => {
  const context = harness(), state = { works: [], artists: [] };
  await importRows(context, state, [['Song Name', 'Singer'], ['Duet', 'Old Singer']]);
  const before = plain(state);
  const result = await importRows(context, state, [['Song Name', 'Singer'], ['Duet', 'Asha Rao, Dev Mehta']]);
  assert.equal(result.skipped, 1);
  assert.deepEqual(plain(state), before);
});

test('normalizing preserves explicitly selected artist IDs, including an empty selection', () => {
  const context = harness(), state = {
    works: [
      { id: 'selected', artist: 'Asha Rao, Dev Mehta', artistIds: ['chosen'], parties: [] },
      { id: 'empty', artist: 'Asha Rao, Dev Mehta', artistIds: [], parties: [] },
    ],
    artists: [{ id: 'chosen', name: 'Chosen Artist', roles: ['Performer'] }],
  };
  context.CueCatalog.ensure(state);
  assert.deepEqual(state.works[0].artistIds, ['chosen']);
  assert.deepEqual(state.works[1].artistIds, []);
  assert.equal(state.artists.length, 1);
});

for (const suppliedSinger of ['Asha Rao, Dev Mehta', '']) test(`sync preserves intentional singer selections when Singer is ${suppliedSinger ? 'unchanged' : 'auto-filled'}`, async () => {
  const context = harness(), state = {
    works: [
      { id: 'selected', title: 'Selected Song', artist: 'Asha Rao, Dev Mehta', artistIds: ['chosen'], parties: [] },
      { id: 'empty', title: 'Unlinked Song', artist: 'Asha Rao, Dev Mehta', artistIds: [], parties: [] },
    ],
    artists: [{ id: 'chosen', name: 'Chosen Artist', roles: ['Performer'] }],
  };
  context.CueCatalog.ensure(state);
  const result = await importRows(context, state, [
    ['Song Name', 'Singer'],
    ['Selected Song', suppliedSinger],
    ['Unlinked Song', suppliedSinger],
  ], { strategy: 'update' });
  assert.equal(result.updated, 2);
  assert.deepEqual(state.works[0].artistIds, ['chosen']);
  assert.deepEqual(state.works[1].artistIds, []);
  assert.equal(state.artists.length, 1);
});

test('an ambiguous singer name does not merge rights holders with different IPIs', async () => {
  const context = harness(), state = {
    works: [],
    artists: [
      { id: 'first', name: 'Same Name', ipi: '000111', roles: ['Composer'] },
      { id: 'second', name: 'Same Name', ipi: '000222', roles: ['Composer'] },
    ],
  };
  await importRows(context, state, [['Song Name', 'Singer'], ['Duet', 'Same Name, Guest Singer, SAME NAME']]);
  const sameName = state.artists.filter(artist => artist.name === 'Same Name');
  assert.equal(sameName.length, 3);
  assert.equal(state.artists.find(artist => artist.id === 'first').ipi, '000111');
  assert.equal(state.artists.find(artist => artist.id === 'second').ipi, '000222');
  assert.equal(state.works[0].artistIds.some(id => ['first', 'second'].includes(id)), false);
  assert.deepEqual(singerNames(state), ['Same Name', 'Guest Singer']);
});

test('empty Singer tokens create no artists and non-comma punctuation remains part of the name', async () => {
  const context = harness(), state = { works: [], artists: [] };
  await importRows(context, state, [
    ['Song Name', 'Singer'],
    ['Instrumental', ', , ,'],
    ['Band Recording', 'Simon & Garfunkel / Live'],
  ]);
  assert.deepEqual(plain(state.works[0].artistIds), []);
  assert.deepEqual(singerNames(state, state.works[1]), ['Simon & Garfunkel / Live']);
  assert.equal(state.artists.length, 1);
});

test('registered comma names and aliases stay intact at the start, middle and end of singer lists', async () => {
  const context = harness(), state = {
    works: [],
    artists: [{ id: 'band', name: 'Earth, Wind & Fire', aliases: ['EWF, Live'], roles: ['Performer'] }],
  };
  await importRows(context, state, [
    ['Song Name', 'Singer'],
    ['First', 'Earth, Wind & Fire, Guest Singer'],
    ['Middle', 'Guest Singer, EWF, Live, Third Singer'],
    ['Last', 'Guest Singer, earth, wind & fire'],
    ['Solo', 'EARTH, WIND & FIRE'],
  ]);
  assert.deepEqual(singerNames(state, state.works[0]), ['Earth, Wind & Fire', 'Guest Singer']);
  assert.deepEqual(singerNames(state, state.works[1]), ['Guest Singer', 'Earth, Wind & Fire', 'Third Singer']);
  assert.deepEqual(singerNames(state, state.works[2]), ['Guest Singer', 'Earth, Wind & Fire']);
  assert.deepEqual(singerNames(state, state.works[3]), ['Earth, Wind & Fire']);
  assert.equal(state.artists.length, 3);
});

for (const extension of ['xlsx', 'csv']) test(`${extension} singer mapping respects quoted commas and escaped quotes without rewriting the Singer text`, async () => {
  const context = harness(), state = { works: [], artists: [] };
  const singer = '"Doe, Jane",   Artist A, "Smith, ""The Voice"""';
  await importRows(context, state, [['Song Name', 'Singer'], ['Quoted Artists', singer]], { extension });
  assert.deepEqual(singerNames(state), ['Doe, Jane', 'Artist A', 'Smith, "The Voice"']);
  assert.equal(state.works[0].artist, singer);
  assert.equal(context.CueCatalog.ensure(state), false);
});

test('explicitly quoted singers remain separate when their combined text matches a registered name', async () => {
  const context = harness(), state = {
    works: [],
    artists: [{ id: 'combined', name: 'Artist A, Artist B', roles: ['Performer'] }],
  };
  await importRows(context, state, [['Song Name', 'Singer'], ['Separate Artists', '"Artist A", "Artist B"']]);
  assert.deepEqual(singerNames(state), ['Artist A', 'Artist B']);
  assert.equal(state.works[0].artistIds.includes('combined'), false);
});

test('quotes embedded in an unquoted artist name remain part of that name', async () => {
  const context = harness(), state = { works: [], artists: [] };
  const singer = 'Nick "The Voice" Smith, Guest Singer';
  await importRows(context, state, [['Song Name', 'Singer'], ['Nick and Guest', singer]]);
  assert.deepEqual(singerNames(state), ['Nick "The Voice" Smith', 'Guest Singer']);
  assert.equal(state.works[0].artist, singer);
});

test('malformed quoted names are preserved unsplit without failing catalog normalization', async () => {
  const context = harness(), state = { works: [], artists: [] };
  const singers = ['Guest Singer, "Doe, Jane', '"Doe, Jane" extra, Guest Singer'];
  await importRows(context, state, [['Song Name', 'Singer'], ...singers.map((singer, index) => ['Malformed ' + index, singer])]);
  for (const [index, singer] of singers.entries()) {
    assert.deepEqual(singerNames(state, state.works[index]), [singer]);
    assert.equal(state.works[index].artist, singer);
  }
  assert.equal(context.CueCatalog.ensure(state), false);
});

test('artist mapping preserves the source workbook, formulas, sheet order and existing records', async () => {
  const context = harness(), singer = 'Artist A,   "Doe, Jane", Artist C';
  const sourceWorkbook = XLSX.utils.book_new();
  const songs = XLSX.utils.aoa_to_sheet([
    ['Song Name', 'Singer', 'ISRC', 'Notes', 'Formula'],
    ['Preserved Song', singer, 'IN1234567890', 'Keep notes, commas and "quotes"', 6],
  ]);
  songs.E2.f = 'SUM(1,2,3)';
  songs['!cols'] = [{ wch: 24 }, { wch: 48 }];
  XLSX.utils.book_append_sheet(sourceWorkbook, songs, 'Songs');
  const notes = XLSX.utils.aoa_to_sheet([['Original label', 2]]);
  notes.B1.f = '1+1';
  XLSX.utils.book_append_sheet(sourceWorkbook, notes, 'Notes & formulas');
  const bytes = XLSX.write(sourceWorkbook, { type: 'buffer', bookType: 'xlsx', compression: true });
  const originalBytes = Buffer.from(bytes);
  const file = { name: 'preserved.xlsx', size: bytes.length, arrayBuffer: async () => Uint8Array.from(bytes).buffer };
  const workbook = await context.CueFileSafety.read(file, { extensions: ['xlsx'], raw: true });
  const beforeWorkbook = plain(workbook);
  const state = {
    works: [{ id: 'existing', title: 'Existing Song', artist: 'Existing Artist', artistIds: ['existing-artist'], parties: [], notes: 'Unchanged' }],
    artists: [{ id: 'existing-artist', name: 'Existing Artist', roles: ['Performer'] }],
  };
  context.CueCatalog.ensure(state);
  const beforeExisting = plain(state);
  const cells = XLSX.utils.sheet_to_json(workbook.Sheets.Songs, { header: 1, defval: '', raw: false, blankrows: true });
  const beforeCells = plain(cells);
  const review = context.CueDatabaseImport.preview(cells.slice(1), context.CueDatabaseImport.mapping(cells[0]), state.works);
  const beforeReview = plain(review);
  const result = context.CueDatabaseImport.execute(state, review, file.name);
  context.CueCatalog.ensure(state);
  assert.equal(result.added, 1);
  assert.deepEqual(singerNames(state, state.works[1]), ['Artist A', 'Doe, Jane', 'Artist C']);
  assert.equal(state.works[1].artist, singer);
  assert.equal(state.works[1].isrc, 'IN1234567890');
  assert.deepEqual(plain(state.works[0]), beforeExisting.works[0]);
  assert.deepEqual(plain(state.artists[0]), beforeExisting.artists[0]);
  assert.deepEqual(plain(review), beforeReview);
  assert.deepEqual(plain(cells), beforeCells);
  assert.deepEqual(plain(workbook), beforeWorkbook);
  assert.deepEqual(plain(workbook.SheetNames), ['Songs', 'Notes & formulas']);
  const preservedBytes = Buffer.from(await file.arrayBuffer());
  assert.deepEqual(preservedBytes, originalBytes);
  // The import reader omits formulas; verify they remain in the source file.
  const preservedWorkbook = XLSX.read(preservedBytes, { type: 'buffer', cellFormula: true });
  assert.equal(preservedWorkbook.Sheets.Songs.E2.f, 'SUM(1,2,3)');
  assert.equal(preservedWorkbook.Sheets['Notes & formulas'].B1.f, '1+1');
});
