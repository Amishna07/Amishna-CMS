'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const XLSX = require('../public/vendor/xlsx.full.min.js');
const JSZip = require('../public/vendor/jszip.min.js');

const dashboard = readFileSync(join(__dirname, '../public/dashboard.js'), 'utf8');
const context = { Buffer, Uint8Array, XLSX, JSZip };
context.window = context;
vm.createContext(context);
vm.runInContext(readFileSync(join(__dirname, '../public/societies.js'), 'utf8'), context);
vm.runInContext(dashboard.slice(0, dashboard.indexOf('/* iprs.js */')), context);

// Measured independently from the supplied PRS reference, without importing its data.
const metadataMerges = [
  'A1:L1', 'A2:L2', 'A3:L3', 'A4:L4', 'A5:L6',
  'A7:B8', 'C7:E8', 'F7:F8', 'G7:H8', 'I7:I8', 'J7:J8', 'K7:K8', 'L7:L8',
  'A9:B10', 'C9:E10', 'F9:F10', 'G9:H10', 'I9:I10', 'J9:J10', 'K9:K10', 'L9:L10',
  'A11:B12', 'C11:E12', 'F11:F12', 'G11:H12', 'I11:I12', 'J11:J12', 'K11:L15',
  'A13:B14', 'C13:E14', 'F13:F14', 'G13:H14', 'I14:J15',
  'A15:B15', 'C15:E15', 'G15:H15', 'A16:L17', 'B18:C18', 'E18:F18',
];
const expectedWidths = [6.75, 12.63, 12.63, 8.63, 23.75, 12.88, 13, 13, 11.75, 11.63, 9.5, 12.63];
const attributes = xml => Object.fromEntries([...xml.matchAll(/([\w:]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]));
const children = (xml, parent, child) => [...xml.match(new RegExp(`<${parent}\\b[^>]*>([\\s\\S]*?)<\\/${parent}>`))[1]
  .matchAll(new RegExp(`<${child}\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/${child}>)`, 'g'))].map(match => match[0]);
const time = seconds => [Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), seconds % 60].map(value => String(value).padStart(2, '0')).join(':');

function fixture(type, counts) {
  const project = {
    id: 'prs-layout', type, title: '=Production & संगीत', productionNo: '000-345',
    country: 'India', duration: '01:45:23', year: 2026, airdate: '2026-09-25',
    filmItemNo: '00078', altTitle: '+Alternate Production', channel: 'Example Channel',
    periods: [{ from: 1, to: 20, company: 'Independent Studio', director: 'Director A', cast: 'Actor A, Actor B' }],
    episodes: [{ number: 7, title: '@Episode Seven', duration: '00:31:17', airdate: '2026-09-26' }],
  };
  const works = counts.map((count, index) => ({
    id: 'work-' + index, title: 'Repeated Song संगीत', societies: { PRS: '000' + index + 'QA' },
    parties: [
      { name: 'Excluded first ' + index, role: 'Composer', share: 0, society: 'IPRS' },
      ...Array.from({ length: count }, (_, partyIndex) => ({
        name: 'Rights holder ' + index + '/' + partyIndex,
        role: partyIndex === 0 ? 'Composer' : partyIndex === count - 1 ? 'Publisher' : 'Lyricist',
        share: count === 1 ? 100 : count === 2 ? 50 : partyIndex === 0 ? 24.5 : partyIndex === count - 1 ? 50 : 25.5 / (count - 2),
        ipi: '000' + index + partyIndex, society: 'IPRS/PRS',
      })),
      { name: 'Excluded last ' + index, role: 'Publisher', share: 0, society: 'ASCAP' },
    ],
  }));
  const cues = works.map((work, index) => ({ id: 'cue-' + index, workId: work.id, episode: 7, duration: 367 + index, societyUsage: { PRS: index % 2 ? 'V' : 'B' } }));
  works.splice(1, 0, { id: 'ineligible', title: 'Excluded Song', parties: [{ name: 'IPRS only', role: 'Composer', share: 100, society: 'IPRS' }] });
  cues.splice(1, 0, { id: 'ineligible-cue', workId: 'ineligible', episode: 7, duration: 999 });
  return { project, works, cues, artists: [] };
}

async function exported(input, exporter = context) {
  const bytes = await exporter.CueExports.buildFormatted('PRS', input.project, input.project.type === 'Movie' ? null : 7, input.cues, input.works, input.artists);
  const workbook = XLSX.read(bytes, { type: 'array', cellNF: true });
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const styles = await zip.file('xl/styles.xml').async('string');
  const xfs = children(styles, 'cellXfs', 'xf'), borders = children(styles, 'borders', 'border');
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return {
    sheet, xml, merges: sheet['!merges'].map(range => XLSX.utils.encode_range(range)),
    edge(address, name) {
      const cell = xml.match(new RegExp(`<c\\b(?=[^>]*\\br="${address}")[^>]*>`))?.[0];
      assert.ok(cell, address + ': styled cell exists');
      const xf = xfs[Number(attributes(cell).s || 0)];
      const border = borders[Number(attributes(xf).borderId || 0)];
      const edge = border.match(new RegExp(`<${name}\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/${name}>)`))?.[0] || '';
      return { style: attributes(edge).style, color: attributes(edge.match(/<color\b[^>]*/)?.[0] || '').rgb };
    },
  };
}

test('PRS preserves outside-table cells, formulas and merges when moving the singleton footer', async () => {
  const zip = await JSZip.loadAsync(Buffer.from(context.CueExportTemplateData.PRS, 'base64'));
  let xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const sentinels = {
    19: '<c r="N19" t="inlineStr"><is><t>000019</t></is></c>',
    20: '<c r="N20"><f>SUM(1,2)</f><v>3</v></c><c r="O20"/>',
    31: '<c r="N31" t="inlineStr"><is><t>Existing footer note</t></is></c>',
  };
  for (const [row, cells] of Object.entries(sentinels)) {
    const pattern = new RegExp(`(<row\\b(?=[^>]*\\br="${row}")[^>]*>[\\s\\S]*?)(<\\/row>)`);
    assert.match(xml, pattern, 'Sentinel source row ' + row + ' exists');
    xml = xml.replace(pattern, (_, body, end) => body + cells + end);
  }
  xml = xml.replace(/(<mergeCells\b[^>]*\bcount=")(\d+)(")/, (_, before, count, after) => before + (Number(count) + 1) + after)
    .replace('</mergeCells>', '<mergeCell ref="N20:O20"/></mergeCells>')
    .replace(/(<dimension\b[^>]*\bref=")([^"]+)(")/, (_, before, ref, after) => {
      const range = XLSX.utils.decode_range(ref);
      range.e.c = Math.max(range.e.c, 14);
      range.e.r = Math.max(range.e.r, 30);
      return before + XLSX.utils.encode_range(range) + after;
    });
  zip.file('xl/worksheets/sheet1.xml', xml);
  const isolated = { Buffer, Uint8Array, XLSX, JSZip };
  isolated.window = isolated;
  vm.createContext(isolated);
  vm.runInContext(readFileSync(join(__dirname, '../public/societies.js'), 'utf8'), isolated);
  vm.runInContext(dashboard.slice(0, dashboard.indexOf('/* iprs.js */')), isolated);
  isolated.CueExportTemplateData.PRS = await zip.generateAsync({ type: 'base64' });
  const output = await exported(fixture('Movie', [1]), isolated);
  assert.equal(output.sheet.N19.v, '000019', 'Data-row note retains its address and leading zeros');
  assert.equal(output.sheet.N20.f, 'SUM(1,2)', 'Formula survives on the otherwise blank footer spacer');
  assert.equal(output.sheet.N20.v, 3, 'Formula cached value is unchanged');
  assert.equal(output.sheet.N31.v, 'Existing footer note', 'Outside-table footer note stays at its original address');
  assert.equal(output.sheet.N21, undefined, 'Moving the table footer does not move unrelated notes');
  assert.equal(output.sheet.A21.v, 'AMISHNA MUSIC');
  assert.ok(output.merges.includes('N20:O20'), 'Outside-table merged range is preserved');
  for (const cells of Object.values(sentinels)) assert.ok(output.xml.includes(cells), 'Sentinel XML is preserved exactly');
  assertMergeIntegrity(output);
});

function assertMergeIntegrity(output) {
  const covered = new Set();
  for (const ref of output.merges) {
    const { s, e } = XLSX.utils.decode_range(ref);
    for (let row = s.r; row <= e.r; row++) {
      for (let column = s.c; column <= e.c; column++) {
        const address = XLSX.utils.encode_cell({ r: row, c: column });
        assert.ok(!covered.has(address), ref + ': no overlapping merges at ' + address);
        covered.add(address);
        if (row !== s.r || column !== s.c) {
          assert.ok(output.sheet[address]?.v == null || output.sheet[address].v === '', address + ': no value obscured by merging');
          assert.equal(output.sheet[address]?.f, undefined, address + ': no formula obscured by merging');
        }
      }
    }
  }
}

function assertMetadata(output, input, counts) {
  const { project } = input, isMovie = project.type === 'Movie';
  const expected = {
    C7: project.title, G7: 'Independent Studio', J7: 'India', L7: isMovie ? project.duration : '00:31:17',
    C9: isMovie ? project.title : '@Episode Seven', G9: '000-345', J9: '2026',
    L9: time(counts.reduce((sum, _, index) => sum + 367 + index, 0)),
    G11: 'Director A', J11: isMovie ? '2026-09-25' : '2026-09-26', C13: '00078',
    G13: 'Actor A, Actor B', J13: isMovie ? 'Movie' : 'Episode', C15: '+Alternate Production', G15: 'Example Channel',
  };
  for (const [address, value] of Object.entries(expected)) {
    assert.equal(output.sheet[address]?.v, value, address + ': metadata retains its exact value');
    assert.equal(output.sheet[address]?.t, 's', address + ': text values retain their type');
    assert.equal(output.sheet[address]?.f, undefined, address + ': text is never interpreted as a formula');
  }
  if (isMovie) assert.ok(output.sheet.C11?.v == null);
  else assert.equal(output.sheet.C11?.v, '7');
  assert.equal(output.sheet.A18?.v, 'Seq');
  assert.equal(output.sheet.B18?.v, 'Title');
  assert.equal(output.sheet.D18?.v, 'Role');
  assert.equal(output.sheet.L18?.v, 'Work Number');
}

const cases = [
  ['one contributor', [1]],
  ['variable song lengths including singletons', [2, 3, 1, 5, 1]],
  ['24 songs beyond the reference capacity', Array.from({ length: 24 }, (_, index) => index % 5 + 1)],
];

for (const type of ['Movie', 'Series']) {
  for (const [description, counts] of cases) {
    test(`PRS ${type} uses reference merges and preserves values for ${description}`, async () => {
      const input = fixture(type, counts), snapshot = structuredClone(input);
      const output = await exported(input);
      assert.deepEqual(input, snapshot, 'Layout formatting does not mutate source records');
      assertMetadata(output, input, counts);
      assert.deepEqual(output.merges.filter(ref => XLSX.utils.decode_range(ref).s.r < 18).sort(), [...metadataMerges].sort());
      const expectedMerges = [], expectedData = {};
      let row = 19;
      for (const [songIndex, count] of counts.entries()) {
        const first = row, last = first + count - 1;
        expectedMerges.push(`B${first}:C${last}`);
        if (count > 1) for (const column of 'AJKL') expectedMerges.push(`${column}${first}:${column}${last}`);
        Object.assign(expectedData, { ['A' + first]: songIndex + 1, ['B' + first]: 'Repeated Song संगीत', ['J' + first]: songIndex % 2 ? 'V' : 'B', ['K' + first]: time(367 + songIndex), ['L' + first]: '000' + songIndex + 'QA' });
        const parties = input.works.find(work => work.id === 'work-' + songIndex).parties.slice(1, -1);
        for (const [partyIndex, party] of parties.entries()) {
          expectedMerges.push(`E${row}:F${row}`);
          Object.assign(expectedData, { ['D' + row]: party.role === 'Lyricist' ? 'Author' : party.role, ['E' + row]: party.name, ['G' + row]: party.ipi, ['H' + row]: party.share / 100, ['I' + row]: 'PRS' });
          assert.equal(output.sheet['H' + row]?.t, 'n', 'Shares remain numeric');
          assert.match(output.sheet['H' + row]?.z || '', /%/, 'Share display remains percentage');
          assert.equal(output.sheet['G' + row]?.t, 's', 'CAE leading zeros remain text');
          for (const column of 'ABCDEFGHIJKL') {
            if (partyIndex === 0) assert.deepEqual(output.edge(column + row, 'top'), { style: 'medium', color: 'FF000000' }, column + row + ': medium black group top');
            if (row === last) assert.deepEqual(output.edge(column + row, 'bottom'), { style: 'medium', color: 'FF000000' }, column + row + ': medium black group bottom');
          }
          for (const column of 'DEFGHI') {
            if (partyIndex > 0) assert.equal(output.edge(column + row, 'top').style, 'thin', column + row + ': thin internal contributor line');
            if (row < last) assert.equal(output.edge(column + row, 'bottom').style, 'thin', column + row + ': thin internal contributor line');
          }
          row++;
        }
      }
      for (const column of 'ABCDEFGHIJKL') assert.ok(output.sheet[column + row]?.v == null, 'One blank row precedes the footer');
      const footer = row + 1;
      expectedMerges.push(`A${footer}:D${footer}`);
      expectedData['A' + footer] = 'AMISHNA MUSIC';
      const actualData = Object.fromEntries(Object.entries(output.sheet)
        .filter(([address, cell]) => /^[A-L]\d+$/.test(address) && Number(address.match(/\d+$/)[0]) >= 19 && cell.v != null && cell.v !== '')
        .map(([address, cell]) => [address, cell.v]));
      assert.deepEqual(actualData, expectedData, 'Every contributor, role, share, time, identifier and footer survives without sample data');
      assert.deepEqual(output.merges.filter(ref => XLSX.utils.decode_range(ref).s.r >= 18).sort(), expectedMerges.sort(), 'Songs use complete blocks of merged cells at their actual contributor counts');
      assertMergeIntegrity(output);
      const columns = [...output.xml.matchAll(/<col\b[^>]*\/>/g)].map(match => attributes(match[0]));
      const defaultWidth = Number(attributes(output.xml.match(/<sheetFormatPr\b[^>]*/)?.[0] || '').defaultColWidth);
      expectedWidths.forEach((width, index) => {
        const definition = columns.find(column => Number(column.min) <= index + 1 && Number(column.max) >= index + 1);
        assert.equal(definition ? Number(definition.width) : defaultWidth, width, 'Reference width for column ' + (index + 1));
      });
    });
  }

  test(`PRS ${type} keeps missing metadata blank inside the reference merges`, async () => {
    const input = fixture(type, [1]);
    input.project = { id: 'empty-metadata', type, title: 'Blank production', periods: [], episodes: [{ number: 7, title: '' }] };
    const snapshot = structuredClone(input), output = await exported(input);
    for (const address of ['G7', 'J7', 'L7', 'G9', 'J9', 'G11', 'J11', 'C13', 'G13', 'C15', 'G15', 'K11', 'I14']) {
      assert.ok(output.sheet[address]?.v == null || output.sheet[address].v === '', address + ': absent metadata remains blank');
    }
    assert.equal(output.sheet.C7.v, 'Blank production');
    assert.equal(output.sheet.C9.v, 'Blank production');
    assertMergeIntegrity(output);
    assert.deepEqual(input, snapshot);
  });
}
