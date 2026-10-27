'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const XLSX = require('../public/vendor/xlsx.full.min.js');
const JSZip = require('../public/vendor/jszip.min.js');

const societies = ['IPRS', 'PRS', 'ASCAP'];
const dashboard = readFileSync(join(__dirname, '../public/dashboard.js'), 'utf8');
const exportSource = dashboard.slice(0, dashboard.indexOf('/* iprs.js */'));
const societySource = readFileSync(join(__dirname, '../public/societies.js'), 'utf8');
const originalMovieSource = readFileSync(join(__dirname, 'fixtures/export-formatting/iprs-movie-before.js'), 'utf8');
const originalPrsSource = readFileSync(join(__dirname, 'fixtures/export-formatting/prs-export-before.js'), 'utf8');
// These fixed baselines are the sanitized embedded templates captured before the
// format change, not the user's uploaded workbooks. Do not regenerate from code.
const originalTemplates = Object.fromEntries(societies.map(society => [
  society, readFileSync(join(__dirname, 'fixtures/export-formatting', society + '-before.xlsx')).toString('base64'),
]));

function exportContext(templates, originalMovie = false) {
  const context = { Buffer, Uint8Array, XLSX, JSZip };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(societySource, context);
  const source = originalMovie
    ? exportSource.replace(/ function iprsMovieTemplate\(xml\)\{[\s\S]*?(?= (?:function transformPrsSheet|async function buildFormatted)\()/, originalMovieSource)
    : exportSource;
  vm.runInContext(source, context);
  if (templates) context.CueExportTemplateData = { ...templates };
  if (originalMovie) {
    // The frozen PRS renderer predates export-policy options. Feed its unchanged
    // layout renderer the same as-entered records as the current renderer so
    // these checks continue to isolate formatting, formulas and cell payloads.
    const scope = context.CueSocieties.scope;
    context.CueSocieties = { ...context.CueSocieties, scope: (cues, works, society, artists, options) =>
      scope(cues, works, society, artists, society === 'PRS' ? { membershipPolicy: 'as-entered-v1' } : options) };
    vm.runInContext(originalPrsSource, context);
    const currentBuild = context.CueExports.buildFormatted;
    context.CueExports.buildFormatted = (society, ...args) => society === 'PRS'
      ? context.CuePrsBefore.buildFormatted(society, ...args)
      : currentBuild(society, ...args);
  }
  return context;
}

const original = exportContext(originalTemplates, true);
const formatted = exportContext();

function fixture(type, count) {
  const project = {
    id: 'format-project', type, title: '=Film & संगीत <2026>',
    genre: 'Drama / संगीत', serialType: 'Documentary', language: 'मराठी',
    productionNo: '00000123', year: 2026, duration: '01:02:03', airdate: '2026-09-25',
    totalEpisodes: 20, season: 3, submittedBy: '@Studio & Co.', bgComposer: 'Composer संगीत',
    country: 'India', filmItemNo: '0000456', altTitle: '+Alternative <Title>', channel: 'Channel & TV',
    ascap: { companyName: 'Company & Co.', address: '12, Studio Road\nMumbai', phone: '+91 0000123456', contact: 'Contact संगीत', network: 'Network <TV>' },
    periods: [{ from: 1, to: 20, director: '=Director', producer: 'Producer & Co.', company: 'Studio <One>', cast: 'Actor A, Actor B' }],
    episodes: [{ number: 7, title: '=Episode संगीत', duration: '00:32:17', airdate: '2026-10-02' }],
  };
  const works = Array.from({ length: count }, (_, index) => ({
    id: 'work-' + index,
    title: ['=SUM(1,2)', 'संगीत & 雨 <Song>', '+Opening\nTitle', '@Song - Finale'][index % 4] + ' ' + index,
    artist: 'Singer A, Singer B', isrc: 'INX000000' + String(index).padStart(3, '0'),
    societies: { IPRS: '000-IPRS-' + index, PRS: '000-PRS-' + index, ASCAP: '000-ASCAP-' + index },
    research: { url: 'https://example.test/?song=' + index + '&language=मराठी' },
    parties: [
      { name: '=Composer संगीत ' + index, role: 'Composer', share: 24.5, ipi: '00000123', society: 'IPRS/PRS/ASCAP' },
      { name: 'Lyricist & Author ' + index, role: 'Lyricist', share: 25.5, ipi: '00000456', society: 'IPRS/PRS/ASCAP' },
      { name: 'Publisher <Music> ' + index, role: 'Publisher', share: 50, ipi: '00000789', society: 'IPRS/PRS/ASCAP' },
    ],
  }));
  const cues = works.map((work, index) => ({
    id: 'cue-' + index, projectId: project.id, workId: work.id, episode: 7,
    duration: index === 0 ? 367 : index * 61, usageCount: index + 1, usagePercent: 17.875,
    usage: 'BI', societyUsage: { IPRS: 'BV', PRS: 'V', ASCAP: 'ET' },
  }));
  const artists = ['Singer A', 'Singer B'].map((name, index) => ({ id: 'artist-' + index, name, societies: [...societies] }));
  return { project, episode: type === 'Movie' ? null : 7, cues, works, artists };
}

async function generate(context, society, input) {
  const { project, episode, cues, works, artists } = input;
  const options = { membershipPolicy: society === 'IPRS' ? 'confirmed-members-v1' : 'as-entered-v1' };
  return context.CueExports.buildFormatted(society, project, episode, cues, works, artists, options);
}

function cellsWithContent(sheet) {
  return Object.fromEntries(Object.entries(sheet)
    .filter(([address, cell]) => !address.startsWith('!') && (cell.v !== undefined || cell.f !== undefined))
    .map(([address, cell]) => [address, { type: cell.t, value: cell.v, formula: cell.f, arrayFormula: cell.F, numberFormat: cell.z }])
    .sort(([left], [right]) => left.localeCompare(right)));
}

// Font attributes inside rich-text runs are formatting; their text is content.
const withoutRichTextFormatting = xml => xml.replace(/<rPr\b[^>]*?(?:\/>|>[\s\S]*?<\/rPr>)/g, '');

function xmlCellPayloads(xml) {
  const cells = [];
  for (const match of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const [, attributes, payload = ''] = match;
    if (!/<(?:v|is|f)\b/.test(payload)) continue;
    const address = attributes.match(/\br="([^"]+)"/)?.[1];
    const dataAttributes = [...attributes.matchAll(/([\w:]+)="([^"]*)"/g)]
      .filter(([, name]) => name !== 's').map(([, name, value]) => [name, value])
      .sort(([left], [right]) => left.localeCompare(right));
    cells.push([address, dataAttributes, withoutRichTextFormatting(payload)]);
  }
  assert.equal(new Set(cells.map(([address]) => address)).size, cells.length, 'No duplicate populated cell addresses');
  return cells.sort(([left], [right]) => left.localeCompare(right));
}

// PRS now follows the reference's paired metadata rows and contributor merges.
// This explicit semantic map is independent of the new export implementation.
function prsContentMapping(sheet, contributorCount) {
  const metadataRows = { 1: 1, 2: 2, 3: 3, 4: 5, 5: 6, 6: 7, 7: 9, 8: 11, 9: 13, 10: 15, 11: 16, 12: 17, 13: 18 };
  const footer = Object.entries(sheet).find(([address, cell]) => /^A\d+$/.test(address) && cell.v === 'AMISHNA MUSIC')?.[0];
  assert.ok(footer, 'Original PRS footer exists');
  const footerRow = Number(footer.slice(1)), newFooter = contributorCount == null ? 31 : 20 + contributorCount;
  return address => {
    const [, column, digits] = address.match(/^([A-Z]+)(\d+)$/);
    const row = Number(digits);
    if (column.length > 1 || column > 'L') return address;
    if (row === footerRow) return column + newFooter;
    if (metadataRows[row]) return column + metadataRows[row];
    if (row >= 14 && row < footerRow) return column + (row + 5);
    return address;
  };
}

// The requested export-only naming change applies solely to PRS contributor
// roles. Titles, names, metadata, formulas and all other payloads stay exact.
const prsExportRoleLabels = new Map([
  ['Lyricist', 'Author'],
  ['Lyricist / Author', 'Author'],
  ['Composer / Lyricist', 'Composer / Author'],
  ['Composer + Lyricist / Author', 'Composer / Author'],
]);

function isPrsContributorRole(address, contributorCount) {
  const row = /^D(\d+)$/.exec(address)?.[1];
  return contributorCount != null && row != null && Number(row) >= 19 && Number(row) < 19 + contributorCount;
}

function remapPrsContent(content, addressMap, contributorCount) {
  const mapped = Object.fromEntries(Object.entries(content).map(([address, cell]) => {
    const mappedAddress = addressMap(address);
    const roleLabel = isPrsContributorRole(mappedAddress, contributorCount) && cell.type === 's' &&
      cell.formula === undefined && cell.arrayFormula === undefined && prsExportRoleLabels.get(cell.value);
    return [mappedAddress, roleLabel ? { ...cell, value: roleLabel } : cell];
  }));
  const note = content.A3;
  assert.equal(note.type, 's');
  const newline = note.value.indexOf('\n');
  assert.ok(newline >= 0, 'Original two-paragraph note remains the baseline');
  mapped.A3 = { ...note, value: note.value.slice(0, newline) };
  mapped.A4 = { ...note, value: note.value.slice(newline + 1) };
  assert.equal(mapped.A3.value + '\n' + mapped.A4.value, note.value, 'Splitting the note preserves its entire original text');
  return mapped;
}

function remapXmlPayloads(payloads, addressMap, contributorCount) {
  return payloads.filter(([address]) => address !== 'A3').map(([address, attrs, payload]) => {
    const mappedAddress = addressMap(address);
    if (isPrsContributorRole(mappedAddress, contributorCount) && attrs.some(([name, value]) => name === 't' && value === 'inlineStr')) {
      for (const [oldLabel, newLabel] of prsExportRoleLabels) {
        if (payload === `<is><t xml:space="preserve">${oldLabel}</t></is>`) {
          payload = `<is><t xml:space="preserve">${newLabel}</t></is>`;
          break;
        }
      }
    }
    return [mappedAddress, attrs.map(([name, value]) => [name, name === 'r' ? mappedAddress : value]), payload];
  }).sort(([left], [right]) => left.localeCompare(right));
}

async function assertContentPreserved(beforeBytes, afterBytes, society, contributorCount = null) {
  const before = XLSX.read(beforeBytes, { type: 'array', cellNF: true });
  const after = XLSX.read(afterBytes, { type: 'array', cellNF: true });
  assert.deepEqual(after.SheetNames, before.SheetNames, 'Sheet names and order');
  const prsMap = society === 'PRS' ? prsContentMapping(before.Sheets[before.SheetNames[0]], contributorCount) : null;
  for (const name of before.SheetNames) {
    const remapped = prsMap && name === before.SheetNames[0];
    const originalContent = cellsWithContent(before.Sheets[name]);
    assert.deepEqual(cellsWithContent(after.Sheets[name]), remapped ? remapPrsContent(originalContent, prsMap, contributorCount) : originalContent,
      name + ': every value, type, formula and number format');
    if (!remapped) assert.deepEqual(after.Sheets[name]['!merges'], before.Sheets[name]['!merges'], name + ': merged ranges');
  }

  const [beforeZip, afterZip] = await Promise.all([JSZip.loadAsync(beforeBytes), JSZip.loadAsync(afterBytes)]);
  const parts = zip => Object.keys(zip.files).filter(name => !zip.files[name].dir).sort();
  assert.deepEqual(parts(afterZip), parts(beforeZip), 'All package parts retained');
  for (const name of parts(beforeZip)) {
    if (name === 'xl/styles.xml') continue;
    if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) {
      const remapped = prsMap && name === 'xl/worksheets/sheet1.xml';
      const originalPayloads = xmlCellPayloads(await beforeZip.file(name).async('string'));
      const updatedPayloads = xmlCellPayloads(await afterZip.file(name).async('string'));
      assert.deepEqual(
        remapped ? updatedPayloads.filter(([address]) => !['A3', 'A4'].includes(address)) : updatedPayloads,
        remapped ? remapXmlPayloads(originalPayloads, prsMap, contributorCount) : originalPayloads,
        name + ': cell XML data unchanged',
      );
    } else if (name === 'xl/sharedStrings.xml') {
      assert.equal(
        withoutRichTextFormatting(await afterZip.file(name).async('string')),
        withoutRichTextFormatting(await beforeZip.file(name).async('string')),
        name + ': shared string content unchanged',
      );
    } else {
      assert.deepEqual(
        await afterZip.file(name).async('uint8array'),
        await beforeZip.file(name).async('uint8array'),
        name + ': non-format package part unchanged',
      );
    }
  }
}

test('embedded export template formatting preserves every original label and workbook part', async () => {
  for (const society of societies) {
    await assertContentPreserved(Buffer.from(originalTemplates[society], 'base64'), Buffer.from(formatted.CueExportTemplateData[society], 'base64'), society);
  }
});

for (const society of societies) {
  for (const type of ['Movie', 'Series']) {
    for (const count of [1, 24]) {
      test(`${society} ${type} formatting preserves all exported content for ${count} cue(s) without mutating inputs`, async () => {
        const input = fixture(type, count), snapshot = structuredClone(input);
        const beforeBytes = await generate(original, society, input);
        assert.deepEqual(input, snapshot, 'Original exporter leaves inputs untouched');
        const afterBytes = await generate(formatted, society, input);
        assert.deepEqual(input, snapshot, 'Formatted exporter leaves inputs untouched');
        await assertContentPreserved(beforeBytes, afterBytes, society, count * 3);
        const output = XLSX.read(afterBytes, { type: 'array' });
        const titles = Object.values(output.Sheets[output.SheetNames[0]]).filter(cell => cell?.t === 's').map(cell => cell.v);
        for (const work of input.works) assert.ok(titles.includes(work.title), 'Retains cue ' + work.id + ' beyond original template capacity');
      });
    }
  }
}

async function addPreservationSentinels(base64) {
  const zip = await JSZip.loadAsync(Buffer.from(base64, 'base64'));
  const worksheet = 'xl/worksheets/sheet1.xml';
  // An existing formula outside the export's editable data columns must survive.
  zip.file(worksheet, (await zip.file(worksheet).async('string')).replace(/(<row\b[^>]*\br="4"[^>]*>[\s\S]*?)(<\/row>)/,
    '$1<c r="N4"><f>SUM(1,2)</f><v>3</v></c>$2'));
  const untouchedSheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B2"/><sheetData>' +
    '<row r="1"><c r="A1" t="inlineStr"><is><t>Existing notes संगीत</t></is></c><c r="B1" t="b"><v>1</v></c></row>' +
    '<row r="2"><c r="A2"><f>SUM(1,2)</f><v>3</v></c><c r="B2" t="e"><v>#N/A</v></c></row></sheetData></worksheet>';
  zip.file('xl/worksheets/sheet2.xml', untouchedSheet);
  zip.file('xl/workbook.xml', (await zip.file('xl/workbook.xml').async('string')).replace('</sheets>',
    '<sheet name="Existing notes संगीत" sheetId="2" r:id="rIdFormatTest"/></sheets>'));
  zip.file('xl/_rels/workbook.xml.rels', (await zip.file('xl/_rels/workbook.xml.rels').async('string')).replace('</Relationships>',
    '<Relationship Id="rIdFormatTest" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>'));
  zip.file('[Content_Types].xml', (await zip.file('[Content_Types].xml').async('string')).replace('</Types>',
    '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'));
  return zip.generateAsync({ type: 'base64' });
}

test('formatting preserves existing formulas and additional sheets with their exact names and order', async () => {
  for (const society of societies) {
    const beforeTemplate = await addPreservationSentinels(originalTemplates[society]);
    const afterTemplate = await addPreservationSentinels(formatted.CueExportTemplateData[society]);
    for (const type of ['Movie', 'Series']) {
      const input = fixture(type, 24);
      const beforeBytes = await generate(exportContext({ [society]: beforeTemplate }, true), society, input);
      const afterBytes = await generate(exportContext({ [society]: afterTemplate }), society, input);
      await assertContentPreserved(beforeBytes, afterBytes, society, input.works.length * 3);
      const workbook = XLSX.read(afterBytes, { type: 'array' });
      assert.equal(workbook.Sheets[workbook.SheetNames[0]].N4.f, 'SUM(1,2)');
      assert.deepEqual(workbook.SheetNames, [XLSX.read(Buffer.from(originalTemplates[society], 'base64')).SheetNames[0], 'Existing notes संगीत']);
      assert.equal(workbook.Sheets['Existing notes संगीत'].A2.f, 'SUM(1,2)');
      assert.equal(workbook.Sheets['Existing notes संगीत'].B1.v, true);
      assert.equal(workbook.Sheets['Existing notes संगीत'].B2.t, 'e');
    }
  }
});

function attributes(xml) {
  return Object.fromEntries([...xml.matchAll(/([\w:]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]));
}

function fontForCell(xml, styleXml, address) {
  const cell = xml.match(new RegExp(`<c\\b[^>]*\\br="${address}"[^>]*>`))?.[0];
  assert.ok(cell, address + ': styled cell exists');
  const xfs = styleXml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)[1];
  const xf = [...xfs.matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)][Number(attributes(cell).s || 0)][0];
  const fontXml = styleXml.match(/<fonts\b[^>]*>([\s\S]*?)<\/fonts>/)[1];
  const font = [...fontXml.matchAll(/<font\b[^>]*?(?:\/>|>[\s\S]*?<\/font>)/g)][Number(attributes(xf).fontId || 0)][0];
  const enabled = tag => {
    const element = font.match(new RegExp(`<${tag}\\b[^>]*`))?.[0];
    return !!element && !['0', 'false'].includes(attributes(element).val);
  };
  return {
    name: attributes(font.match(/<name\b[^>]*/)?.[0] || '').val,
    size: Number(attributes(font.match(/<sz\b[^>]*/)?.[0] || '').val),
    bold: enabled('b'), italic: enabled('i'),
  };
}

// Expected sizes/fonts were measured from the three user-approved formats.
// Runtime tests use only these constants and sanitized fixtures, never Downloads.
const approvedAppearance = {
  IPRS: {
    widths: [42.25, 18.38, 12, 10, 15.25, 12.13, 22.38, 37.63, 8.88, 7.13, 12, 18.13, 49.63],
    orientation: 'landscape', headerHeight: 44.4, bodyHeight: 15.75,
    headerFont: { name: 'Arial Narrow', size: 11, bold: true, italic: false },
    dataFont: { name: 'Arial Narrow', size: 11, bold: false, italic: false },
  },
  PRS: {
    widths: [6.75, 12.63, 12.63, 8.63, 23.75, 12.88, 13, 13, 11.75, 11.63, 9.5, 12.63],
    orientation: 'portrait', headerHeight: 31.5, bodyHeight: 15.75,
    headerFont: { name: 'Arial', size: 12, bold: true, italic: false },
    dataFont: { name: 'Arial', size: 10, bold: false, italic: false },
  },
  ASCAP: {
    widths: [5.75, 27.88, 5.63, 9.75, 43.88, 50.25, 18.13],
    orientation: 'landscape', headerHeight: 20.25, bodyHeight: 34.5,
    headerFont: { name: 'Arial', size: 11, bold: true, italic: false },
    dataFont: { name: 'Arial', size: 11, bold: false, italic: true },
  },
};

for (const society of societies) {
  test(`${society} exports retain approved column sizes, row heights, print orientation and fonts`, async () => {
    const expected = approvedAppearance[society];
    for (const type of ['Movie', 'Series']) {
      const input = fixture(type, 24), bytes = await generate(formatted, society, input);
      const zip = await JSZip.loadAsync(bytes);
      const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
      const styles = await zip.file('xl/styles.xml').async('string');
      const cols = [...xml.matchAll(/<col\b[^>]*\/>/g)].map(match => attributes(match[0]));
      expected.widths.forEach((width, index) => {
        const column = cols.find(col => Number(col.min) <= index + 1 && Number(col.max) >= index + 1);
        assert.equal(Number(column?.width), width, type + ' column ' + (index + 1));
      });
      assert.equal(attributes(xml.match(/<pageSetup\b[^>]*/)[0]).orientation, expected.orientation);
      const height = row => Number(attributes(xml.match(new RegExp(`<row\\b[^>]*\\br="${row}"[^>]*`))[0]).ht);
      const headerRow = formatted.CueExports.mappingFor(society, input.project).headerRow;
      assert.equal(height(headerRow), expected.headerHeight, type + ': header height');
      if (society === 'ASCAP') assert.ok(height(headerRow + 1) >= expected.bodyHeight, type + ': wrapped credits never shrink the reference height');
      else assert.equal(height(headerRow + 1), expected.bodyHeight, type + ': first cue height');
      // IPRS keeps separator row addresses but collapses their visible height.
      const expandedContributorRow = headerRow + (society === 'IPRS' ? 21 : 20);
      if (society === 'ASCAP') assert.ok(height(expandedContributorRow) >= expected.bodyHeight, type + ': expanded wrapped credits have room to grow');
      else assert.equal(height(expandedContributorRow), expected.bodyHeight, type + ': expanded cue height');
      if (society === 'IPRS') assert.equal(height(headerRow + 20), 0, type + ': no visible gap between songs');
      const headerCell = (society === 'IPRS' ? 'A' : society === 'PRS' ? 'D' : 'B') + headerRow;
      const dataCell = (society === 'IPRS' ? 'H' : 'E') + (headerRow + 1);
      assert.deepEqual(fontForCell(xml, styles, headerCell), expected.headerFont, type + ': header font');
      assert.deepEqual(fontForCell(xml, styles, dataCell), expected.dataFont, type + ': contributor font');
      if (society === 'IPRS') {
        assert.equal(height(1), 93.75);
        assert.equal(height(2), 33.75);
      }
      if (society === 'PRS') {
        const defaultHeight = Number(attributes(xml.match(/<sheetFormatPr\b[^>]*/)[0]).defaultRowHeight);
        const effectiveHeight = row => Number(attributes(xml.match(new RegExp(`<row\\b[^>]*\\br="${row}"[^>]*`))[0]).ht || defaultHeight);
        for (const row of [7, 9, 11, 13]) assert.equal(effectiveHeight(row) + effectiveHeight(row + 1), 31.5,
          type + ': paired reference metadata has 31.5 points of total height');
      }
    }
  });
}
