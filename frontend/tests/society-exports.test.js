'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const XLSX = require('../public/vendor/xlsx.full.min.js');
const JSZip = require('../public/vendor/jszip.min.js');

const source = readFileSync(join(__dirname, '../public/dashboard.js'), 'utf8');
const context = { Buffer, Uint8Array, XLSX, JSZip };
context.window = context;
vm.createContext(context);
vm.runInContext(readFileSync(join(__dirname, '../public/societies.js'), 'utf8'), context);
vm.runInContext(source.slice(0, source.indexOf('/* iprs.js */')), context);

function movie() {
  return {
    type: 'Movie', title: 'चांद & Rain', genre: 'Drama', language: 'Marathi',
    productionNo: 'CBFC-321', duration: '02:10:45', airdate: '2026-09-23', year: 2026,
    bgComposer: 'Background Composer', submittedBy: 'Amishna Music',
    totalEpisodes: 50, season: 2, channel: 'Must not show in movie',
    periods: [{ from: 1, to: 50, director: 'Movie Director', producer: 'Movie Producer', company: 'Movie Banner', cast: 'A & B' }],
    episodes: [{ number: 2, title: 'Wrong episode for movie', duration: '00:10:00', airdate: '2025-01-01' }],
  };
}

function series() {
  return {
    ...movie(), type: 'Series', serialType: 'Soap', title: 'Marathi Serial',
    episodes: [{ number: 2, title: 'Episode Two', duration: '00:32:35', airdate: '2026-04-10' }],
  };
}

const works = [{
  id: 'w1', title: 'Opening Title', artist: 'Singer', isrc: 'INP12308076',
  societies: { IPRS: 'IPRS-123', PRS: 'PRS-123', ASCAP: 'ASCAP-123' },
  research: { url: 'https://example.test/song?a=1&b=2' },
  parties: [
    { name: 'Writer', role: 'Composer', share: 50, ipi: '00123', society: 'IPRS/PRS/ASCAP' },
    { name: 'Publisher', role: 'Publisher', share: 50, ipi: '00456', society: 'IPRS/PRS/ASCAP' },
  ],
}];
const cues = [{ id: 'c1', workId: 'w1', duration: 184, usageCount: 1, episode: 2 }];

async function exported(society, project, episode, selectedCues = cues, selectedWorks = works) {
  const bytes = await context.CueExports.buildFormatted(society, project, episode, selectedCues, selectedWorks, [{ id: 'singer', name: 'Singer', societies: ['IPRS', 'PRS', 'ASCAP'] }]);
  const workbook = XLSX.read(bytes, { type: 'array', cellStyles: true });
  const zip = await JSZip.loadAsync(bytes);
  return { sheet: workbook.Sheets[workbook.SheetNames[0]], zip, xml: await zip.file('xl/worksheets/sheet1.xml').async('string') };
}

test('IPRS movie uses the supplied movie field order and all 13 cue columns', async () => {
  const project = movie(), { sheet } = await exported('IPRS', project, 2);
  const expected = {
    A2: 'MOVIE CUE SHEET', B3: project.title, H3: 'Movie Director', B4: 'Drama', H4: 'Movie Banner',
    B5: 'Marathi', H5: 'A & B', A6: 'PRODUCTION NUMBER (FROM CENSOR CERTIFICATE)',
    B6: 'CBFC-321', G6: 'TOTAL MOVIE DURATION', H6: '02:10:45',
    B7: '2026-09-23', H7: '00:03:04', B8: '2026', H8: 'Background Composer',
    B9: 'Movie Producer', H9: 'Amishna Music', A11: 'WORK DETAILS',
    F11: 'COMPOSER / AUTHOR / PUBLISHER / SINGER DETAILS',
    A12: 'SONG TITLE / TRACK NAME', B12: 'Code', A13: 'Opening Title', B13: 'OI', C13: 1,
    D13: 'IPRS-123', E13: 'INP12308076', F13: '00:03:04', G13: 'C', H13: 'Writer',
    I13: 'IPRS', J13: '50%', K13: '00123', L13: 'Singer',
    M13: 'https://example.test/song?a=1&b=2', G14: 'E', H14: 'Publisher', J14: '50%',
  };
  for (const [cell, value] of Object.entries(expected)) assert.equal(sheet[cell]?.v, value, cell);
  const displayed = Object.values(sheet).map(cell => cell?.v).filter(value => typeof value === 'string').join('\n');
  for (const label of ['SERIAL TITLE', 'CHANNEL NAME', 'TOTAL EPISODE DURATION', 'EPISODE NO.', 'EPISODE TITLE', 'TOTAL NO. OF EPISODE', 'SEASON NO', 'Note: Cue Sheets should']) assert.ok(!displayed.includes(label), label);
  const merges = sheet['!merges'].map(range => XLSX.utils.encode_range(range));
  for (const range of ['A1:K1', 'B3:E3', 'H3:K3', 'B9:E9', 'H9:K9', 'A11:E11', 'F11:K11']) assert.ok(merges.includes(range), range);
});

test('IPRS series retains serial layout and exports episode-specific metadata', async () => {
  const { sheet } = await exported('IPRS', series(), 2);
  const expected = {
    A2: 'TV/WEB SERIES CUE SHEET', B4: 'Soap', B11: '2', H7: '00:32:35',
    B8: '2026-04-10', H9: 'Background Composer', H11: 'Episode Two',
    B15: 'CHARACTERISTICS', A16: 'Opening Title', F16: '00:03:04',
  };
  for (const [cell, value] of Object.entries(expected)) assert.equal(sheet[cell]?.v, value, cell);
  const legacy = series();delete legacy.serialType;delete legacy.bgComposer;
  const fallback = await exported('IPRS', legacy, 2);
  assert.equal(fallback.sheet.B4.v, 'Web Series');
  assert.equal(fallback.sheet.H9.v, 'Writer');
});

test('IPRS movie expansion keeps all contributor rows and moves its footer below them', async () => {
  const many = Array.from({ length: 20 }, (_, index) => ({ ...cues[0], id: 'c' + index }));
  const { sheet, xml } = await exported('IPRS', movie(), null, many);
  assert.equal(sheet.A70.v, 'Opening Title');
  assert.equal(sheet.H71.v, 'Publisher');
  assert.equal(sheet.A73.v, 'Codes:');
  assert.equal(sheet.H7.v, '01:01:20');
  const rows = [...xml.matchAll(/<row\b[^>]*\br="(\d+)"/g)].map(match => Number(match[1]));
  assert.deepEqual(rows, [...new Set(rows)].sort((a, b) => a - b));
  const addresses = [...xml.matchAll(/<c\b[^>]*\br="([A-Z]+\d+)"/g)].map(match => match[1]);
  assert.equal(addresses.length, new Set(addresses).size);
});

test('PRS and ASCAP use the same supplied formatting for movies and serials', async () => {
  for (const society of ['PRS', 'ASCAP']) {
    const template = await JSZip.loadAsync(Buffer.from(context.CueExportTemplateData[society], 'base64'));
    const film = await exported(society, movie(), null), serial = await exported(society, series(), 2);
    assert.deepEqual(film.sheet['!merges'], serial.sheet['!merges']);
    for (const output of [film, serial]) {
      for (const [name, file] of Object.entries(template.files)) {
        if (file.dir || name === 'xl/worksheets/sheet1.xml') continue;
        assert.deepEqual(await output.zip.file(name).async('uint8array'), await file.async('uint8array'), name);
      }
      assert.equal(output.sheet[society === 'PRS' ? 'B19' : 'B10'].v, 'Opening Title');
      assert.equal(output.sheet[society === 'PRS' ? 'J19' : 'C10'].v, society === 'PRS' ? 'F' : 'MT');
    }
    if (society === 'PRS') {
      assert.equal(film.sheet.L7.v, '02:10:45');
      assert.equal(serial.sheet.L7.v, '00:32:35');
    } else {
      assert.match(film.sheet.E10.v, /Writer.*100%/);
      assert.match(film.sheet.F10.v, /Publisher.*100%/);
    }
  }
});

test('structural IPRS builder uses the same movie and series metadata and table positions', () => {
  for (const [project, episode, headerRow] of [[movie(), null, 12], [series(), 2, 15]]) {
    const workbook = context.CueExports.build('IPRS', project, episode, cues, works), sheet = workbook.Sheets['Cue Sheet'];
    assert.equal(sheet['A' + headerRow].v, 'SONG TITLE / TRACK NAME');
    assert.equal(sheet['A' + (headerRow + 1)].v, 'Opening Title');
    assert.equal(sheet[project.type === 'Movie' ? 'H8' : 'H9'].v, 'Background Composer');
  }
});

test('each format preserves composer, lyricist and publisher shares, IDs and cue values', async () => {
  const track = structuredClone(works[0]);
  track.title = 'A Song';
  track.parties = [
    { name: 'Composer Name', role: 'Composer', share: 24.5, ipi: '000123', society: 'IPRS/PRS/ASCAP' },
    { name: 'Lyricist Name', role: 'Lyricist', share: 25.5, ipi: '000456', society: 'IPRS/PRS/ASCAP' },
    { name: 'Publisher Name', role: 'Publisher', share: 50, ipi: '000789', society: 'IPRS/PRS/ASCAP' },
  ];
  const cue = { ...cues[0], duration: 367, usageCount: 3, usagePercent: 20.5 };
  for (const [project, episode, firstRow] of [[movie(), null, 13], [series(), 2, 16]]) {
    const { sheet } = await exported('IPRS', project, episode, [cue], [track]);
    assert.equal(sheet['A' + firstRow].v, track.title);
    assert.equal(sheet['B' + firstRow].v, 'FV');
    assert.equal(sheet['C' + firstRow].v, 3);
    assert.equal(sheet['D' + firstRow].v, track.societies.IPRS);
    assert.equal(sheet['E' + firstRow].v, track.isrc);
    assert.equal(sheet['F' + firstRow].v, '00:06:07');
    assert.equal(sheet['L' + firstRow].v, track.artist);
    for (let index = 0; index < track.parties.length; index++) {
      const row = firstRow + index, party = track.parties[index];
      assert.equal(sheet['G' + row].v, ['C', 'A', 'E'][index]);
      assert.equal(sheet['H' + row].v, party.name);
      assert.equal(sheet['I' + row].v, 'IPRS');
      assert.equal(sheet['J' + row].v, party.share + '%');
      assert.equal(sheet['K' + row].v, party.ipi);
    }
    const prs = (await exported('PRS', project, episode, [cue], [track])).sheet;
    assert.equal(prs.B19.v, track.title);
    assert.equal(prs.K19.v, '00:06:07');
    assert.equal(prs.L19.v, track.societies.PRS);
    for (let index = 0; index < track.parties.length; index++) {
      const row = 19 + index, party = track.parties[index];
      assert.equal(prs['D' + row].v, party.role === 'Lyricist' ? 'Author' : party.role);
      assert.equal(prs['E' + row].v, party.name);
      assert.equal(prs['G' + row].v, party.ipi);
      assert.equal(prs['H' + row].v, party.share / 100);
      assert.match(prs['H' + row].w, /%/);
    }
    const ascap = (await exported('ASCAP', project, episode, [cue], [track])).sheet;
    assert.equal(ascap.B10.v, track.title);
    assert.equal(ascap.D10.v, 367 / 86400);
    assert.equal(ascap.E10.v, 'Composer Name (ASCAP) 49%\nLyricist Name (ASCAP) 51%');
    assert.equal(ascap.F10.v, 'Publisher Name (ASCAP) 100%');
    assert.equal(ascap.G10.v, track.societies.ASCAP);
  }
});

test('empty metadata replaces every reference example rather than leaking template values', async () => {
  for (const type of ['Movie', 'Series']) {
    const project = { type, title: 'Blank production', periods: [], episodes: type === 'Movie' ? [] : [{ number: 7, title: 'Episode Seven' }] };
    const { sheet } = await exported('IPRS', project, type === 'Movie' ? null : 7);
    const blankCells = type === 'Movie'
      ? ['H3', 'B4', 'H4', 'B5', 'H5', 'B6', 'H6', 'B7', 'B8', 'B9']
      : ['H3', 'H4', 'B5', 'H5', 'B6', 'H6', 'B7', 'H7', 'B8', 'B9', 'B10', 'B12', 'H12'];
    for (const address of blankCells) assert.ok(sheet[address]?.v == null || sheet[address]?.v === '', address);
    assert.equal(sheet[type === 'Movie' ? 'H8' : 'H9'].v, 'Writer');
    assert.equal(sheet[type === 'Movie' ? 'H9' : 'H10'].v, 'Amishna Music');
    const values = Object.values(sheet).map(cell => cell?.v).filter(value => typeof value === 'string').join('\n');
    for (const sample of ['Monsoon Diaries', 'Aster Play', 'Neel Deshpande', 'Amberlight Studios', 'Ishan Kulkarni', 'Ananya Rao', 'Cue Rights Studio', 'DEMO-']) assert.ok(!values.includes(sample), sample);
  }
});

test('adapted movie and serial exports use the supplied production period and effective duration', async () => {
  const sourceSeries = series();
  const originalPeriod = { ...sourceSeries.periods[0], from: 1, to: 10 };
  const selectedPeriod = { from: 11, to: 20, director: 'Later Director', producer: 'Later Producer', company: 'Later Banner', cast: 'Later Cast' };
  sourceSeries.periods = [originalPeriod, selectedPeriod];
  sourceSeries.episodes = [{ number: 12, title: 'Twelfth episode', duration: '00:45:30', airdate: '2026-10-01' }];
  const source = await exported('IPRS', sourceSeries, 12);
  assert.equal(source.sheet.H4.v, 'Later Director');
  assert.equal(source.sheet.H7.v, '00:45:30');
  const filmProject = { ...sourceSeries, type: 'Movie', periods: [selectedPeriod], duration: '02:00:00', airdate: '2026-11-01' };
  const film = await exported('IPRS', filmProject, 12);
  assert.equal(film.sheet.H3.v, 'Later Director');
  assert.equal(film.sheet.B9.v, 'Later Producer');
  assert.equal(film.sheet.H6.v, '02:00:00');
  assert.equal(film.sheet.B7.v, '2026-11-01');
  const serialProject = { ...movie(), type: 'Series', periods: [{ ...selectedPeriod, from: 7, to: 7 }], episodes: [{ number: 7, title: 'Adapted episode', duration: '00:40:00', airdate: '2026-12-01' }] };
  const serial = await exported('IPRS', serialProject, 7);
  assert.equal(serial.sheet.H4.v, 'Later Director');
  assert.equal(serial.sheet.H7.v, '00:40:00');
  assert.equal(serial.sheet.B11.v, '7');
  assert.equal(serial.sheet.H11.v, 'Adapted episode');
});

test('generating any society format leaves project, cues, usage percentages and song data untouched', async () => {
  const project = series(), selectedCues = [{ ...cues[0], usagePercent: 17.875 }], selectedWorks = structuredClone(works);
  const before = JSON.stringify({ project, selectedCues, selectedWorks });
  for (const society of ['IPRS', 'PRS', 'ASCAP']) await exported(society, project, 2, selectedCues, selectedWorks, [{ id: 'singer', name: 'Singer', societies: ['IPRS', 'PRS', 'ASCAP'] }]);
  assert.equal(JSON.stringify({ project, selectedCues, selectedWorks }), before);
});

test('export preserves valid saved society usage even when the title suggests another code', async () => {
  const cue = { ...cues[0], usage: 'BI', societyUsage: { IPRS: 'BV', PRS: 'V', ASCAP: 'ET' } };
  for (const [project, episode, iprsCell] of [[movie(), null, 'B13'], [series(), 2, 'B16']]) {
    for (const [society, cell] of [['IPRS', iprsCell], ['PRS', 'J19'], ['ASCAP', 'C10']]) {
      const { sheet } = await exported(society, project, episode, [cue]);
      assert.equal(sheet[cell].v, cue.societyUsage[society]);
    }
  }
  const legacy = { ...cues[0], usage: 'FI' };
  assert.equal((await exported('IPRS', movie(), null, [legacy])).sheet.B13.v, 'FI');
  assert.equal((await exported('PRS', movie(), null, [legacy])).sheet.J19.v, 'F');
  const missing = { ...cues[0], societyUsage: { IPRS: 'invalid', PRS: '', ASCAP: 'invalid' } };
  await assert.rejects(exported('IPRS', movie(), null, [missing]), /invalid.*valid IPRS mapping/);
  assert.equal((await exported('PRS', movie(), null, [missing])).sheet.J19.v, 'F');
  await assert.rejects(exported('ASCAP', movie(), null, [missing]), /invalid.*valid ASCAP mapping/);
});
