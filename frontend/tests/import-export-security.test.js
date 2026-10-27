'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const XLSX = require('../public/vendor/xlsx.full.min.js');
const JSZip = require('../public/vendor/jszip.min.js');
const source = readFileSync(join(__dirname, '../public/dashboard.js'), 'utf8');
const context = { Uint8Array, TextDecoder, TextEncoder, Buffer, XLSX, JSZip, structuredClone };
context.window = context;
vm.createContext(context);
vm.runInContext(source.slice(0, source.indexOf('/* iprs.js */')), context);
vm.runInContext(readFileSync(join(__dirname, '../public/societies.js'), 'utf8'), context);
vm.runInContext(source.slice(source.indexOf('/* export-filenames.js */'), source.indexOf('/* amishna.prototype.js */')), context);
const safety = context.CueFileSafety;
const upload = (name, bytes, type = '') => ({ name, type, size: bytes.length, arrayBuffer: async () => Uint8Array.from(bytes).buffer });
function workbookBytes(rows, bookType = 'xlsx') {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Data');
  return XLSX.write(workbook, { type: 'buffer', bookType, compression: true });
}

test('safe importer reads normal XLSX and legacy XLS without changing Unicode or numeric timing', async () => {
  for (const extension of ['xlsx', 'xls']) {
    const bytes = workbookBytes([['Song Name', 'Duration'], ['संगीत & music', 0.5]], extension === 'xls' ? 'biff8' : 'xlsx');
    const result = await safety.read(upload('music.' + extension, bytes));
    assert.equal(result.Sheets.Data.A2.v, 'संगीत & music');
    assert.equal(result.Sheets.Data.B2.v, 0.5);
  }
});

test('Excel inspection lists large workbooks and selected reads parse only the chosen worksheets', async () => {
  const workbook = XLSX.utils.book_new();
  for (let index = 1; index <= 260; index++) XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Track'], ['Song ' + index]]), 'Episode ' + index);
  const file = upload('episodes.xlsx', XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true }));
  const names = (await safety.inspect(file)).sheetNames;
  assert.equal(names.length, 260);
  const selected = await safety.read(file, { sheetNames: names.slice(249, 251) });
  assert.deepEqual(Array.from(selected.SheetNames), ['Episode 250', 'Episode 251']);
  assert.equal(selected.Sheets['Episode 251'].A2.v, 'Song 251');
  await assert.rejects(safety.read(file, { sheetNames: names }), /250 worksheets/);
});

test('import trims formatted empty rows across 250 worksheets', async () => {
  const workbook = XLSX.utils.book_new();
  for (let episode = 1; episode <= 250; episode++) {
    const sheet = XLSX.utils.aoa_to_sheet([
      [0.02, '12 Sep 2022', 'Episode ' + episode, null, episode],
      [],
      [0, 0.001, 0.001, 'Instrumental cue']
    ]);
    sheet['!ref'] = 'A1:E1000';
    XLSX.utils.book_append_sheet(workbook, sheet, String(episode));
  }
  const file = upload('episodes.xlsx', XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true }));
  const imported = await safety.read(file);
  assert.equal(imported.SheetNames.length, 250);
  assert.equal(imported.Sheets['250']['!ref'], 'A1:E3');
  assert.equal(imported.Sheets['250'].D3.v, 'Instrumental cue');
  assert.equal(context.CueDomain.fixedWorkfile(XLSX.utils.sheet_to_json(imported.Sheets['250'], { header: 1, defval: '', raw: true, blankrows: true })).episodeNumber, 250);
});

test('import still rejects large populated worksheet ranges', () => {
  const workbook = { SheetNames: [], Sheets: {} };
  for (let episode = 1; episode <= 201; episode++) {
    const name = String(episode);
    workbook.SheetNames.push(name);
    workbook.Sheets[name] = { '!ref': 'A1:E1000', A1: { t: 's', v: 'Cue' }, E1000: { t: 's', v: 'Cue' } };
  }
  assert.throws(() => safety.validateWorkbook(workbook, XLSX), /too large to preview safely/);
});

test('CSV parsing treats formula prefixes and HTML as literal strings and preserves quoted Unicode', async () => {
  const text = 'Song Name,Notes\r\n"=HYPERLINK(""https://example.test"",""TEST"")","<script>alert(""TEST"")</script>"\r\n"संगीत, गीत","line 1\nline 2"';
  const workbook = await safety.read(upload('../fake.csv', Buffer.from(text), 'text/csv'));
  const sheet = workbook.Sheets.Sheet1;
  assert.equal(sheet.A2.t, 's');
  assert.equal(sheet.A2.f, undefined);
  assert.equal(sheet.B2.v, '<script>alert("TEST")</script>');
  assert.equal(sheet.A3.v, 'संगीत, गीत');
  assert.equal(sheet.B3.v, 'line 1\nline 2');
});

test('CSV parser supports UTF-16 Excel text and semicolon or tab delimiters', async () => {
  for (const delimiter of [';', '\t']) {
    const bytes = Buffer.concat([Buffer.from([255, 254]), Buffer.from('Song Name' + delimiter + 'Share\r\nमराठी' + delimiter + '25%', 'utf16le')]);
    const workbook = await safety.read(upload('songs.csv', bytes));
    assert.equal(workbook.Sheets.Sheet1.A2.v, 'मराठी');
    assert.equal(workbook.Sheets.Sheet1.B2.v, '25%');
  }
});

test('reject unsupported extensions, mismatched MIME, fake workbook signatures and corrupt ZIPs', async () => {
  for (const file of [upload('file.json', Buffer.from('{}')), upload('file.xlsx', Buffer.from('<table></table>')), upload('file.xls', Buffer.from('abc')), upload('file.csv', Buffer.from('a,b'), 'text/html'), upload('file.xlsx', Buffer.from([80, 75, 3, 4]))]) {
    await assert.rejects(safety.read(file));
  }
});

test('reject empty and oversized uploads before reading their content', async () => {
  for (const size of [0, safety.limits.bytes + 1]) {
    let read = false;
    await assert.rejects(safety.read({ name: 'songs.xlsx', size, arrayBuffer: async () => { read = true; return new ArrayBuffer(1); } }), /10 MB/);
    assert.equal(read, false);
  }
});

test('reject malformed, binary, excessively wide or tall CSV files', async () => {
  for (const text of ['a,b\n"unfinished', 'a,b\n"done"tail,x', 'a,b\nabc"def,x', 'a,b\n\u0000,x', Array(102).fill('x').join(','), 'x\n'.repeat(10004)]) {
    await assert.rejects(safety.read(upload('bad.csv', Buffer.from(text))));
  }
});

test('reject XLSX dimensions before materializing a sparse million-row grid', async () => {
  const zip = await JSZip.loadAsync(workbookBytes([['Name'], ['Song']]));
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  zip.file('xl/worksheets/sheet1.xml', xml.replace(/<dimension ref="[^"]*"/, '<dimension ref="A1:XFD1048576"'));
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  await assert.rejects(safety.read(upload('sparse.xlsx', bytes)), /10,000|100 columns/);
});

test('ZIP expansion is bounded by actual bytes, even when its declared size is forged', async () => {
  const zip = await JSZip.loadAsync(workbookBytes([['Name']]));
  const amount = safety.limits.entry + 1024;
  zip.file('xl/large.xml', 'x'.repeat(amount));
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  assert.ok(bytes.length < safety.limits.bytes);
  await assert.rejects(safety.read(upload('bomb.xlsx', bytes)), /safe import size/);
  const forged = Buffer.from(bytes);
  for (let i = 0; i < forged.length - 46; i++) {
    if (forged.readUInt32LE(i) === 0x02014b50 && forged.readUInt32LE(i + 24) === amount) forged.writeUInt32LE(1, i + 24);
  }
  await assert.rejects(safety.read(upload('forged.xlsx', forged)), /safe import size/);
});

test('ZIP traversal names are rejected and valid high-compression workbooks are allowed', async () => {
  const zip = await JSZip.loadAsync(workbookBytes([['Name']]));
  zip.file('../outside.xml', '<test/>');
  await assert.rejects(safety.read(upload('unsafe.xlsx', await zip.generateAsync({ type: 'uint8array' }))), /unsafe archive path/);
  zip.remove('../outside.xml');zip.remove('../');
  zip.file('xl/repetitive.xml', ' '.repeat(1024 * 1024));
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  assert.ok(bytes.length < 10000);
  assert.equal((await safety.read(upload('repetitive.xlsx', bytes))).Sheets.Data.A1.v, 'Name');
});

for (const type of ['Movie', 'Series']) for (const society of ['IPRS', 'PRS', 'ASCAP']) test(`${type} ${society} preserves hostile text as data and source records with its current affiliation policy`, async () => {
  const dangerous = '=HYPERLINK("https://example.test","TEST") <script>alert("TEST")</script> & गीत _x0041_\u0001';
  const project = { id: 'project', type, title: 'Film ../ "<TEST>" मराठी', periods: [], episodes: [{ number: 6, title: dangerous, duration: '01:00:00' }], duration: '02:00:00' };
  const works = [{ id: 'work', title: dangerous, artist: 'Singer', isrc: 'IN1234567890', societies: { IPRS: 'I-1', PRS: 'P-1', ASCAP: 'A-1' }, parties: [
    { name: 'IPRS Only', role: 'Composer', share: 25, society: 'IPRS' },
    { name: 'PRS Only', role: 'Lyricist', share: 25, society: 'PRS' },
    { name: 'Dual ' + dangerous, role: 'Publisher', share: 50, society: 'IPRS/PRS/ASCAP' }
  ] }];
  const cues = [{ id: 'cue', workId: 'work', duration: 90, episode: 6, usageCount: 2, usagePercent: 12.5, societyUsage: { IPRS: 'BV', PRS: 'T', ASCAP: 'ET' } }];
  const before = JSON.stringify({ project, works, cues });
  const bytes = await context.CueExports.buildFormatted(society, project, type === 'Movie' ? null : 6, cues, works);
  assert.equal(JSON.stringify({ project, works, cues }), before);
  const workbook = XLSX.read(bytes, { type: 'array' }), sheet = workbook.Sheets[workbook.SheetNames[0]];
  const titleCell = society === 'IPRS' ? (type === 'Movie' ? 'A13' : 'A16') : society === 'PRS' ? 'B19' : 'B10';
  assert.equal(sheet[titleCell].v, dangerous);
  assert.equal(sheet[titleCell].t, 's');
  assert.equal(sheet[titleCell].f, undefined);
  const values = Object.values(sheet).map(cell => cell?.v ?? '').join('\n');
  if (society === 'IPRS') { assert.ok(values.includes('IPRS Only'));assert.ok(!Object.values(sheet).some(cell => cell?.v === 'PRS Only'));assert.ok(values.includes('Dual ')); }
  if (society === 'PRS') {
    assert.ok(values.includes('PRS Only'));assert.ok(values.includes('IPRS Only'));
    assert.equal(sheet.I19.v, 'IPRS');assert.equal(sheet.I20.v, 'PRS');assert.equal(sheet.I21.v, 'IPRS/PRS/ASCAP');
  }
  if (society === 'ASCAP') {
    assert.ok(sheet.E10.v.includes('IPRS Only (IPRS) 50%'));
    assert.ok(sheet.E10.v.includes('PRS Only (PRS) 50%'));
    assert.ok(sheet.F10.v.includes('(IPRS/PRS/ASCAP) 100%'));
  }
  const name = context.CueExportFilename(project, 6, society);
  assert.ok(!/[<>:"/\\|?*]/.test(name));
  assert.ok(name.endsWith((type === 'Series' ? '_Episode_06' : '') + '_' + society + '.xlsx'));
  const zip = await JSZip.loadAsync(bytes), xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  assert.ok(!xml.includes('<script>'));
  assert.ok(!xml.includes('\u0001'));
});

test('file names bound every component and avoid reserved Windows device names', () => {
  const filename = context.CueExportFilename({ type: 'Series', title: 'मराठी'.repeat(100) }, '9'.repeat(1000), 'A'.repeat(1000), { endEpisode: '8'.repeat(1000), extension: 'zip' });
  assert.ok(Buffer.byteLength(filename) < 255);
  for (const title of ['CON', 'PRN', 'LPT1', 'AUX', 'NUL']) assert.equal(context.CueExportFilename({ type: 'Movie', title }, null, '', { extension: 'zip' }), 'Production_' + title + '.zip');
});

test('malformed route encodings recover to dashboard while valid routes decode', () => {
  const definition = source.match(/function decodeRoute\(hash\)\{[^\n]+/)[0];
  const ctx = vm.createContext({});vm.runInContext(definition, ctx);
  assert.equal(ctx.decodeRoute('#%E0%A4%A'), 'dashboard');
  assert.equal(ctx.decodeRoute('#wor%6Bs'), 'works');
  assert.equal(ctx.decodeRoute('#research'), 'research');
});

test('refresh warning only protects an unsaved modal form in an open workspace', () => {
  const ctx = vm.createContext({ workspaceClosed: false, modalDraft: true, document: { querySelector: () => ({}) } });
  vm.runInContext(source.match(/function guardUnsavedModal\(event\)\{[^\n]+/)[0], ctx);
  const event = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
  const dirty = event();ctx.guardUnsavedModal(dirty);assert.equal(dirty.prevented, true);
  for (const change of [() => { ctx.modalDraft = false; }, () => { ctx.modalDraft = true;ctx.workspaceClosed = true; }, () => { ctx.workspaceClosed = false;ctx.document.querySelector = () => null; }]) {
    change();const check = event();ctx.guardUnsavedModal(check);assert.equal(check.prevented, false);
  }
});

test('closing during a suspended workfile read cannot repopulate or save the workspace', async () => {
  let resume, saves = 0, renders = 0;
  const ctx = vm.createContext({ structuredClone, workspaceClosed: false, dataRevision: 0, state: { works: [], cues: [], projects: [] }, bulkImportActive: false, importDefaultType: 'Series', importMovieFields: [], importMovieDetails: {}, bulkMovieDetailsError: () => '', toast: () => {}, renderPage: () => { renders++; }, save: () => { saves++; }, CueFileSafety: { read: () => new Promise(resolve => { resume = resolve; }) } });
  vm.runInContext(source.slice(source.indexOf('async function bulkReadFiles('), source.indexOf('const importView=bulkImportView')), ctx);
  const pending = ctx.bulkReadFiles([{ name: 'work.xlsx', size: 100, lastModified: 1 }]);
  ctx.workspaceClosed = true;ctx.state = null;
  resume({ SheetNames: [], Sheets: {} });await pending;
  assert.equal(saves, 0);assert.equal(renders, 1);assert.equal(ctx.state, null);
});

test('correcting cue timing preserves saved usages and percentage', () => {
  const cue = { id: 'cue', workId: 'work', projectId: 'project', episode: 6, duration: 10, usage: 'BV', societyUsage: { IPRS: 'BV', PRS: 'T', ASCAP: 'ET' }, usagePercent: 12.5 };
  const ctx = vm.createContext({ form: { id: 'cue-form', dataset: { id: 'cue' } }, state: { cues: [cue] }, D: context.CueDomain, data: new Map([['start', '00:00:10'], ['end', '00:00:30'], ['source', 'Original'], ['notes', 'note']]), workName: () => 'Opening Title', toast: () => {}, commit: (_, change) => { change();return true; }, closeModal: () => {}, renderPage: () => {} });
  vm.runInContext("(()=>{" + source.slice(source.indexOf("if(form.id==='cue-form')"), source.indexOf("if(form.id==='work-form')")) + "})()", ctx);
  assert.equal(cue.duration, 20);assert.equal(cue.usagePercent, 12.5);
  assert.deepEqual(JSON.parse(JSON.stringify(cue.societyUsage)), { IPRS: 'BV', PRS: 'T', ASCAP: 'ET' });
});

test('song detail identifiers are escaped in the live modal markup', () => {
  let html;
  const payload = '<img src=x onerror="alert(\'TEST\')">';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ctx = vm.createContext({ modalWork: { id: payload, title: 'Test', activity: [] }, workTab: 'History', esc: escape, empty: () => '', modalHead: escape, showModal: value => { html = value; }, icon: () => '' });
  vm.runInContext(source.slice(source.indexOf('function renderWorkModal()'), source.indexOf('function importHistory()')), ctx);
  ctx.renderWorkModal();
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
});

test('database validation reports escape spreadsheet formula prefixes in CSV output', () => {
  const ctx = vm.createContext({});ctx.window = ctx;
  vm.runInContext(source.slice(source.indexOf('/* database-import.js */'), source.indexOf('/* app.prototype.js */')), ctx);
  for (const value of ['=1+1', '+SUM(1,2)', '-1+1', '@SUM(1,2)', '\t=1+1', '\r=1+1', ' =1+1']) {
    const csv = ctx.CueDatabaseImport.errorReport([{ row: 2, issues: [{ field: 'title', value, message: 'Review', suggestion: 'Correct' }] }]);
    assert.ok(csv.includes('"\'' + value + '"'));
  }
});

for (const society of ['IPRS', 'PRS', 'ASCAP']) test(`${society} public embedded template exposes no sample cue rows or unused shared strings`, async () => {
  const bytes = Buffer.from(context.CueExportTemplateData[society], 'base64');
  const workbook = XLSX.read(bytes, { type: 'buffer' }), sheet = workbook.Sheets[workbook.SheetNames[0]];
  const [first, last] = { IPRS: [16, 30], PRS: [19, 30], ASCAP: [10, 15] }[society];
  for (const [address, cell] of Object.entries(sheet)) {
    const row = Number(address.match(/\d+$/)?.[0]);
    if (/^[A-Z]+\d+$/.test(address) && row >= first && row <= last) assert.ok(cell.v == null || cell.v === '', address);
  }
  const zip = await JSZip.loadAsync(bytes), xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const used = new Set([...xml.matchAll(/<c\b[^>]*\bt="s"[^>]*>\s*<v>(\d+)<\/v>\s*<\/c>/g)].map(match => Number(match[1])));
  const shared = await zip.file('xl/sharedStrings.xml')?.async('string');
  if (shared) [...shared.matchAll(/<si\b[^>]*>[\s\S]*?<\/si>/g)].forEach((match, index) => { if (!used.has(index)) {
    // PRS retains the original legal note in sharedStrings while displaying its
    // two paragraphs separately in the reference's A3 and A4 merged rows.
    const retainedNote = society === 'PRS' && workbook.Strings?.[index]?.t === sheet.A3.v + '\n' + sheet.A4.v;
    if (!retainedNote) assert.equal(match[0], '<si><t></t></si>');
  } });
  assert.ok(sheet['!merges'].length > 0, 'Formatting merges remain available');
});
