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
const context = { Buffer, Uint8Array, XLSX, JSZip, CueSocieties };
context.window = context;
vm.createContext(context);
vm.runInContext(source.slice(0, source.indexOf('/* iprs.js */')), context);

function fixture(type = 'Movie', count = 1) {
  const project = { id: 'p', title: 'Row height production', type, periods: [], episodes: [{ number: 1, title: 'Episode one' }] };
  const works = Array.from({ length: count }, (_, index) => ({
    id: 'w' + index, title: 'Title ' + index, societies: { ASCAP: '000' + index },
    parties: [{ name: 'Writer', role: 'Composer', society: 'IPRS', share: 50 }, { name: 'Publisher', role: 'Publisher', society: 'NS', share: 50 }],
  }));
  const cues = works.map(work => ({ id: 'c' + work.id, projectId: 'p', workId: work.id, episode: type === 'Series' ? 1 : null, duration: 60, societyUsage: { ASCAP: 'VI' } }));
  return { project, works, cues };
}

async function exported(data) {
  const bytes = await context.CueExports.buildFormatted('ASCAP', data.project, data.project.type === 'Series' ? 1 : null, data.cues, data.works, []);
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const book = XLSX.read(bytes, { type: 'array' });
  return { zip, xml, sheet: book.Sheets[book.SheetNames[0]] };
}

function height(xml, row) {
  const tag = xml.match(new RegExp(`<row\\b[^>]*\\br="${row}"[^>]*>`))[0];
  return Number(tag.match(/\bht="([\d.]+)"/)[1]);
}

for (const type of ['Movie', 'Series']) {
  test(`ASCAP ${type} retains reference height for short credits and grows three writer lines`, async () => {
    const data = fixture(type, 3);
    data.works[1].parties.unshift({ name: 'Second Writer', role: 'Lyricist', society: 'PRS', share: 0 });
    data.works[2].parties = [
      { name: 'Test Composer Alpha', role: 'Composer', society: 'IPRS', share: 12.5 },
      { name: 'Test Composer Bravo', role: 'Composer', society: 'IPRS', share: 12.5 },
      { name: 'Test Lyricist Gamma', role: 'Lyricist', society: 'NS', share: 25 },
      { name: 'Test Publisher', role: 'Publisher', society: 'NS', share: 50 },
    ];
    const { xml, sheet } = await exported(data);
    assert.equal(height(xml, 10), 34.5);
    assert.equal(height(xml, 11), 34.5);
    assert.ok(height(xml, 12) >= 50.25, 'Three 11pt credit lines have enough vertical space');
    assert.equal(sheet.E12.v, 'Test Composer Alpha (IPRS) 25%\nTest Composer Bravo (IPRS) 25%\nTest Lyricist Gamma (Non Member) 50%');
    assert.equal(sheet.F12.v, 'Test Publisher (Non Member) 100%');
  });
}

test('ASCAP grows for wrapped names, cue titles and work IDs while keeping the template styles and footer', async () => {
  const data = fixture('Series', 12);
  data.works[0].parties[1].name = 'International Music Publishing Rights Administration and Worldwide Licensing Company '.repeat(3).trim();
  data.works[1].title = 'A very long musical cue title with additional movement and instrumental descriptions '.repeat(2).trim();
  data.works[11].societies.ASCAP = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(3);
  const { zip, xml, sheet } = await exported(data);
  const template = await JSZip.loadAsync(Buffer.from(context.CueExportTemplateData.ASCAP, 'base64'));
  const originalXml = await template.file('xl/worksheets/sheet1.xml').async('string');
  assert.ok(height(xml, 10) > 34.5, 'Long publisher credit wraps');
  assert.ok(height(xml, 11) > 34.5, 'Long cue title wraps');
  assert.ok(height(xml, 21) > 34.5, 'Long identifier wraps in an expanded cue row');
  assert.equal(height(xml, 12), 34.5, 'Neighboring short rows retain their approved height');
  assert.equal(height(xml, 9), 20.25, 'Header height remains unchanged');
  assert.equal(await zip.file('xl/styles.xml').async('string'), await template.file('xl/styles.xml').async('string'));
  assert.equal(xml.match(/<cols>[\s\S]*?<\/cols>/)[0], originalXml.match(/<cols>[\s\S]*?<\/cols>/)[0]);
  assert.equal(sheet.F10.v, data.works[0].parties[1].name + ' (Non Member) 100%');
  assert.equal(sheet.B11.v, data.works[1].title);
  assert.equal(sheet.G21.v, data.works[11].societies.ASCAP);
  assert.equal(sheet.D21.v, 60 / 86400);
  assert.ok(xml.includes('ref="A27:F27"'), 'Footer merge stays after the expanded table');
  assert.ok(Object.values(sheet).some(cell => String(cell?.v || '').includes('Use Codes')), 'Usage legend remains present');
});

for (const type of ['Movie', 'Series']) {
  test(`ASCAP ${type} continues large credit lists within Excel row limits without repeating timings`, async () => {
    const data = fixture(type, 2);
    data.works[0].parties = Array.from({ length: 30 }, (_, index) => ({
      name: 'Writer ' + index, role: 'Composer', society: 'PRS', share: 1,
    })).concat(Array.from({ length: 30 }, (_, index) => ({
      name: 'Publisher ' + index, role: 'Publisher', society: 'NS', share: 1,
    })));
    const original = JSON.stringify(data);
    const expected = context.CueExports.build('ASCAP', data.project, type === 'Series' ? 1 : null, data.cues, data.works, []);
    const expectedSheet = expected.Sheets[expected.SheetNames[0]];
    const { xml, sheet } = await exported(data);
    const nextRow = Object.keys(sheet).find(address => /^A\d+$/.test(address) && sheet[address].v === 2).slice(1);
    const firstRows = Array.from({ length: Number(nextRow) - 10 }, (_, index) => 10 + index);
    assert.ok(firstRows.length > 1, 'Large credits continue on additional rows');
    for (const column of ['E', 'F']) {
      assert.equal(firstRows.map(row => sheet[column + row]?.v || '').join(''), expectedSheet[column + '10'].v, 'Every credit and separator is retained');
    }
    for (const row of firstRows) assert.ok(height(xml, row) <= 409, 'Rows stay within Excel limits');
    assert.equal(sheet.D10.v, 60 / 86400);
    for (const row of firstRows.slice(1)) {
      assert.equal(sheet['A' + row]?.v || '', '', 'Cue number is not duplicated');
      assert.equal(sheet['C' + row]?.v || '', '', 'Use code is not duplicated');
      assert.equal(sheet['D' + row]?.v || '', '', 'Duration is not duplicated');
    }
    assert.equal(sheet['B' + nextRow].v, 'Title 1', 'Following cues remain in order');
    assert.ok(Object.values(sheet).some(cell => String(cell?.v || '').includes('Use Codes')), 'Footer remains present');
    assert.equal(JSON.stringify(data), original, 'Saved data is unchanged');
  });
}

test('ASCAP continues oversized wrapped text without dropping Unicode characters', async () => {
  const data = fixture();
  data.works[0].title = 'संगीत 🎵 A long cue title '.repeat(100);
  data.works[0].societies.ASCAP = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(100);
  const { xml, sheet } = await exported(data);
  const footerRow = Math.min(...Object.entries(sheet).filter(([, cell]) => String(cell?.v || '').includes('Use Codes')).map(([address]) => Number(address.match(/\d+$/)[0])));
  const dataRows = [...xml.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*\bht="([\d.]+)"/g)]
    .filter(match => Number(match[1]) >= 10 && Number(match[1]) < footerRow);
  assert.ok(dataRows.length > 1);
  for (const match of dataRows) assert.ok(Number(match[2]) <= 409);
  for (const [column, expected] of [['B', data.works[0].title], ['G', data.works[0].societies.ASCAP]]) {
    assert.equal(dataRows.map(match => sheet[column + match[1]]?.v || '').join(''), expected);
  }
});
