'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const XLSX = require('../public/vendor/xlsx.full.min.js');
const JSZip = require('../public/vendor/jszip.min.js');
const S = require('../public/societies.js');
const source = readFileSync(join(__dirname, '../public/dashboard.js'), 'utf8');
const context = { Buffer, Uint8Array, XLSX, JSZip, CueSocieties: S };
context.window = context;
vm.createContext(context);
vm.runInContext(source.slice(0, source.indexOf('/* iprs.js */')), context);
const recorded = { membershipPolicy: 'recorded-affiliations-v1' };

function fixture() {
  return {
    project: { id: 'p', title: 'Test Production', language: 'Hindi', type: 'Movie', periods: [], episodes: [] },
    cues: [{ id: 'c', workId: 'w', duration: 35 }],
    works: [{ id: 'w', title: 'Opening Title', societyUsage: { IPRS: 'CV', PRS: 'V', ASCAP: 'ET' }, parties: [
      { name: 'Writer', role: 'Composer', society: 'IPRS/PRS/ASCAP', ipi: '000123', share: 100 },
    ] }],
  };
}

async function sheetFor(society, input, artists = [], options = {}) {
  const bytes = await context.CueExports.buildFormatted(society, input.project, null, input.cues, input.works, artists, options);
  const book = XLSX.read(bytes, { type: 'array' });
  return book.Sheets[book.SheetNames[0]];
}

for (const [society, address, expected] of [['IPRS', 'B13', 'CV'], ['PRS', 'J19', 'V'], ['ASCAP', 'C10', 'ET']]) {
  test(society + ' export uses saved song usage defaults when the cue has no codes', async () => {
    const input = fixture(), before = JSON.stringify(input);
    assert.equal(context.CueDomain.validateExport(input.cues, input.works, society, input.project).length, 0);
    const sheet = await sheetFor(society, input);
    assert.equal(sheet[address].v, expected);
    assert.equal(JSON.stringify(input), before);
  });
  test(society + ' export rejects invalid explicit usage instead of silently substituting a title code', async () => {
    const input = fixture();
    delete input.works[0].societyUsage;
    input.cues[0].societyUsage = { [society]: 'INVALID' };
    await assert.rejects(sheetFor(society, input), /INVALID.*valid.*mapping/);
  });
  test(society + ' export uses the shared song code over an outdated cue code and rejects invalid song defaults', async () => {
    const input = fixture();
    input.cues[0].societyUsage = { [society]: 'INVALID' };
    assert.equal((await sheetFor(society, input))[address].v, expected);
    input.works[0].societyUsage[society] = 'INVALID';
    await assert.rejects(sheetFor(society, input), /INVALID.*valid.*mapping/);
  });
}

test('PRS format retains registry-only society affiliations, leading-zero IPI and exact ownership', async () => {
  const input = fixture();
  input.works[0].parties[0].society = '';
  input.works[0].parties[0].artistId = 'artist';
  const artists = [{ id: 'artist', name: 'Writer', societies: ['IPRS'] }];
  const sheet = await sheetFor('PRS', input, artists, recorded);
  assert.equal(sheet.I19.v, 'IPRS');
  assert.equal(sheet.G19.v, '000123');
  assert.equal(sheet.H19.v, 1);
});

test('legacy contributor validation requires shares while explicit zero shares remain valid', () => {
  const input = fixture();
  for (const share of [null, '', undefined, '   ']) {
    input.works[0].parties[1] = { name: 'Publisher', role: 'Publisher', society: 'Non Member', share };
    assert.ok(context.CueDomain.validateExport(input.cues, input.works, 'PRS', input.project).some(issue => issue.message.includes('every contributor')));
  }
  input.works[0].parties[1].share = 0;
  assert.equal(context.CueDomain.validateExport(input.cues, input.works, 'PRS', input.project).length, 0);
});

test('recorded affiliation exports reject orphan cues rather than creating blank cue rows', async () => {
  const input = fixture();
  input.cues.push({ id: 'orphan', workId: 'missing', duration: 60 });
  await assert.rejects(sheetFor('PRS', input, [], recorded), /linked Work/);
  await assert.rejects(sheetFor('ASCAP', input, [], recorded), /linked Work/);
});

test('ASCAP header keeps production and language without appending Cue Sheet', async () => {
  const sheet = await sheetFor('ASCAP', fixture());
  assert.equal(sheet.A1.v, 'Test Production (Hindi Movie)');
});

for (const type of ['Movie', 'Series']) for (const society of S.supported) {
  test(society + ' ' + type + ' preserves 81 repeated cues beyond template capacity without duplicate XML cells', async () => {
    const input = fixture();
    input.project.type = type;
    input.project.episodes = [{ number: 7, title: 'Episode Seven', duration: '00:30:00' }];
    input.works = Array.from({ length: 9 }, (_, index) => ({
      id: 'w' + index, title: '=Song <' + index + '> & संगीत',
      societyUsage: { IPRS: 'FV', PRS: 'F', ASCAP: 'VI' },
      parties: [
        { name: 'Writer ' + index, role: 'Composer', society: 'IPRS/PRS/ASCAP', ipi: '000123', share: 25 },
        { name: 'Author ' + index, role: 'Lyricist', society: 'IPRS/PRS/ASCAP', ipi: '000456', share: 25 },
        { name: 'Independent Publisher ' + index, role: 'Publisher', society: 'Non Member', ipi: '', share: 50 },
      ],
    }));
    input.cues = Array.from({ length: 81 }, (_, index) => ({ id: 'c' + index, workId: 'w' + index % 9, episode: type === 'Movie' ? null : 7, duration: 35 + index }));
    const before = JSON.stringify(input), options = society === 'IPRS' ? {} : recorded;
    const bytes = await context.CueExports.buildFormatted(society, input.project, type === 'Movie' ? null : 7, input.cues, input.works, [], options);
    const book = XLSX.read(bytes, { type: 'array' }), sheet = book.Sheets[book.SheetNames[0]];
    const values = Object.entries(sheet).filter(([address]) => !address.startsWith('!')).map(([, cell]) => cell);
    assert.equal(values.filter(cell => typeof cell.v === 'string' && cell.v.startsWith('=Song <')).length, 81);
    assert.equal(values.filter(cell => typeof cell.v === 'string' && cell.v.startsWith('Independent Publisher ')).length, 81);
    assert.ok(values.every(cell => !cell.f), 'Spreadsheet prefixes must remain text, never formulas');
    assert.equal(values.filter(cell => cell.v === '000123').length, society === 'ASCAP' ? 0 : 81);
    const zip = await JSZip.loadAsync(bytes), xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
    const cells = [...xml.matchAll(/<c\b[^>]*\br="([A-Z]+\d+)"/g)].map(match => match[1]);
    assert.equal(new Set(cells).size, cells.length, 'Every XML cell address is unique');
    const rows = [...xml.matchAll(/<row\b[^>]*\br="(\d+)"/g)].map(match => Number(match[1]));
    assert.equal(new Set(rows).size, rows.length, 'Every XML row is unique');
    assert.deepEqual(rows, [...rows].sort((a, b) => a - b), 'Rows stay in Excel order');
    assert.equal(JSON.stringify(input), before);
  });
}
