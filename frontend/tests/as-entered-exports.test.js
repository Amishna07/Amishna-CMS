'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const XLSX = require('../public/vendor/xlsx.full.min.js');
const JSZip = require('../public/vendor/jszip.min.js');
const source = readFileSync(join(__dirname, '../public/dashboard.js'), 'utf8');
const context = vm.createContext({ Buffer, Uint8Array, XLSX, JSZip, structuredClone });
context.window = context;
vm.runInContext(readFileSync(join(__dirname, '../public/societies.js'), 'utf8'), context);
vm.runInContext(source.slice(0, source.indexOf('/* iprs.js */')), context);
const policy = { membershipPolicy: 'as-entered-v1' };
const plain = value => JSON.parse(JSON.stringify(value));
const cell = (sheet, address) => sheet[address]?.v ?? '';

function fixture(type = 'Movie') {
  const parties = [
    { name: 'IPRS Composer', role: 'Composer', society: 'IPRS', ipi: '000001', share: 12.5 },
    { name: 'PRS Author', role: 'Lyricist', society: 'PRS', ipi: '000002', share: 25 },
    { name: 'ASCAP Arranger', role: 'Arranger', society: 'ASCAP', ipi: '000003', share: null },
    { name: 'BMAI Writer', role: 'Composer', society: 'BMAI', ipi: '000004', share: 0 },
    { name: 'GEMA Writer', role: 'Composer', society: ' gEmA / BMAI ; CUSTOM-REG ', ipi: '000005', share: 31.25 },
    { name: 'Unfamiliar Role', role: 'Music Supervisor', society: 'Unknown Society', ipi: '', share: undefined },
    { name: 'NS Publisher', role: 'Publisher', society: 'NS', ipi: '', share: 12.5 },
    { name: 'Non Society Publisher', role: 'Publisher', society: 'non-society', ipi: '', share: null },
    { name: 'Blank Society Writer', role: 'Composer', society: '', artistId: 'registry', ipi: '', share: 7 },
  ];
  return {
    project: { id: 'p', title: 'Saved Data Production', type, periods: [], duration: '00:30:00',
      episodes: type === 'Series' ? [{ number: 2, title: 'Second', duration: '00:30:00' }, { number: 7, title: 'Seventh', duration: '00:30:00' }] : [] },
    works: [
      { id: 'mixed', title: 'Every saved contributor', parties, tuneCode: '000-PRS', societies: { ASCAP: '000-ASCAP' } },
      { id: 'empty', title: 'Cue without contributor details', parties: [], tuneCode: '000-EMPTY' },
    ],
    artists: [{ id: 'registry', name: 'Blank Society Writer', societies: ['PRS'] }],
    cues: [
      { id: 'c1', workId: 'mixed', episode: type === 'Series' ? 2 : null, duration: 85, usage: 'FV', societyUsage: { PRS: 'F', ASCAP: 'VI' } },
      { id: 'c2', workId: 'empty', episode: type === 'Series' ? 2 : null, duration: 30, usage: 'BI', societyUsage: { PRS: 'B', ASCAP: 'BI' } },
    ],
  };
}

async function formatted(society, input, options) {
  const bytes = await context.CueExports.buildFormatted(society, input.project,
    input.project.type === 'Movie' ? null : 2, input.cues, input.works, input.artists, options);
  const book = XLSX.read(bytes, { type: 'array', cellStyles: true });
  return { bytes, book, sheet: book.Sheets[book.SheetNames[0]] };
}

test('as-entered scope keeps every cue and contributor regardless of society, without changing input', () => {
  const input = fixture(), before = structuredClone(input);
  for (const society of ['PRS', 'ASCAP']) {
    const scoped = context.CueSocieties.scope(input.cues, input.works, society, input.artists, policy);
    assert.deepEqual(plain(scoped.cues), plain(input.cues));
    assert.deepEqual(plain(scoped.works.map(work => work.id)), input.works.map(work => work.id));
    assert.deepEqual(plain(scoped.works[0].parties.map(party => [party.name, party.society, party.share])),
      plain(input.works[0].parties.map(party => [party.name, party.society, party.share])));
    assert.equal(scoped.summary.includedCues, 2);
    assert.equal(scoped.summary.excludedCues, 0);
  }
  assert.deepEqual(input, before);
});

for (const society of ['PRS', 'ASCAP']) test(`${society} as-entered validation permits missing contributor details and incomplete ownership`, () => {
  const input = fixture(), before = structuredClone(input);
  assert.equal(context.CueDomain.validateExport(input.cues, input.works, society, input.project, policy).length, 0);
  input.works[0].parties.push({ name: '', role: '', society: 'GEMA', share: '' });
  assert.equal(context.CueDomain.validateExport(input.cues, input.works, society, input.project, policy).length, 0);
  input.works[0].parties.pop();
  assert.deepEqual(input, before);
});

test('as-entered validation and workbook builders still reject missing songs, titles, duration and invalid usage', async () => {
  for (const society of ['PRS', 'ASCAP']) for (const mutate of [
    input => { input.cues[0].workId = 'missing'; },
    input => { input.works[0].title = ''; },
    input => { input.cues[0].duration = 0; },
    input => { input.cues[0].societyUsage[society] = 'INVALID'; },
  ]) {
    const input = fixture(); mutate(input);
    assert.ok(context.CueDomain.validateExport(input.cues, input.works, society, input.project, policy).length > 0);
    assert.throws(() => context.CueExports.build(society, input.project, null, input.cues, input.works, input.artists));
    await assert.rejects(formatted(society, input));
  }
  const input = fixture();
  assert.ok(context.CueDomain.validateExport(input.cues, input.works, 'IPRS', input.project, policy).some(issue => /contributor|shares/.test(issue.message)));
});

test('PRS fresh workbooks retain society text, label non-members consistently, and keep blank shares and contributor-free cues', async () => {
  const input = fixture(), before = structuredClone(input), { bytes, sheet } = await formatted('PRS', input);
  for (const [index, party] of input.works[0].parties.entries()) {
    const row = 19 + index;
    assert.equal(cell(sheet, 'E' + row), party.name);
    const affiliation = ['NS Publisher', 'Non Society Publisher'].includes(party.name) ? 'Non Member' : party.society;
    assert.equal(cell(sheet, 'I' + row), affiliation, 'Only explicit non-society labels change in the exported copy');
    assert.equal(cell(sheet, 'G' + row), party.ipi);
    assert.equal(cell(sheet, 'H' + row), party.share == null || party.share === '' ? '' : party.share / 100);
  }
  const emptyRow = 19 + input.works[0].parties.length;
  assert.equal(cell(sheet, 'A' + emptyRow), 2);
  assert.equal(cell(sheet, 'B' + emptyRow), input.works[1].title);
  assert.equal(cell(sheet, 'K' + emptyRow), '00:00:30');
  assert.equal(cell(sheet, 'L' + emptyRow), '000-EMPTY');
  for (const column of ['D', 'E', 'G', 'H', 'I']) assert.equal(cell(sheet, column + emptyRow), '');
  const zip = await JSZip.loadAsync(bytes), xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  assert.ok(xml.includes(`B${emptyRow}:C${emptyRow}`));
  assert.deepEqual(input, before);
});

test('ASCAP fresh workbooks include every role and affiliation, label non-members consistently, and leave absent details blank', async () => {
  const input = fixture(), before = structuredClone(input), { sheet } = await formatted('ASCAP', input);
  const writers = String(cell(sheet, 'E10')).split('\n'), publishers = String(cell(sheet, 'F10')).split('\n');
  for (const party of input.works[0].parties) {
    const affiliation = ['NS Publisher', 'Non Society Publisher'].includes(party.name) ? 'Non Member' : party.society;
    const expected = `${party.name}${affiliation ? ' (' + affiliation + ')' : ''}${party.share == null ? '' : ' ' + party.share * 2 + '%'}`;
    assert.ok((party.role === 'Publisher' ? publishers : writers).includes(expected), expected);
  }
  assert.ok(writers.includes('Blank Society Writer 14%'), 'A blank recorded society must not inherit registry membership');
  assert.equal(cell(sheet, 'B11'), input.works[1].title);
  assert.equal(cell(sheet, 'D11'), 30 / 86400);
  assert.equal(cell(sheet, 'E11'), '');
  assert.equal(cell(sheet, 'F11'), '');
  assert.deepEqual(input, before);
});

for (const society of ['PRS', 'ASCAP']) test(`${society} leaves blank recorded affiliations blank when linked profiles contain NS or PRS`, async () => {
  for (const recorded of ['', undefined]) for (const membership of ['NS', 'NON-MEMBER', 'PRS']) {
    const input = fixture();
    input.works[0].parties = [{ name: 'Blank Society Writer', role: 'Composer', society: recorded, artistId: 'registry', share: 100 }];
    input.artists[0].societies = [membership];
    const before = structuredClone(input);
    const { sheet } = await formatted(society, input);
    assert.equal(cell(sheet, society === 'PRS' ? 'I19' : 'E10'), society === 'PRS' ? '' : 'Blank Society Writer 200%', 'Fresh exports only use the affiliation saved on this credit');
    const legacy = await formatted(society, input, { membershipPolicy: 'recorded-affiliations-v1' });
    const inherited = membership === 'PRS' ? 'PRS' : 'Non Member';
    assert.equal(cell(legacy.sheet, society === 'PRS' ? 'I19' : 'E10'), society === 'PRS' ? inherited : `Blank Society Writer (${inherited}) 200%`, 'Historical exports keep their registry fallback');
    assert.deepEqual(input, before);
  }
});

for (const society of ['PRS', 'ASCAP']) test(`${society} normalizes non-member tokens in mixed affiliations while preserving real societies, separators and unrelated codes`, async () => {
  const input = fixture();
  input.works[0].parties = [
    { name: 'Mixed Writer', role: 'Composer', society: 'IPRS / NS; GEMA', share: 25 },
    { name: 'Dotted Writer', role: 'Composer', society: 'prs / n.s.; BMAI', share: 25 },
    { name: 'Independent Writer', role: 'Lyricist', society: 'GEMA, Non-society & PRS', share: 25 },
    { name: 'Other Publisher', role: 'Publisher', society: ' N.S.W. / DNS ; BMAI ', share: 25 },
  ];
  const expected = ['IPRS / Non Member; GEMA', 'prs / Non Member; BMAI', 'GEMA, Non Member & PRS', ' N.S.W. / DNS ; BMAI '];
  const before = structuredClone(input);
  for (const options of [undefined, { membershipPolicy: 'recorded-affiliations-v1' }]) {
    const { sheet } = await formatted(society, input, options);
    if (society === 'PRS') {
      expected.forEach((affiliation, index) => {
        assert.equal(cell(sheet, 'E' + (19 + index)), input.works[0].parties[index].name);
        assert.equal(cell(sheet, 'I' + (19 + index)), affiliation);
        assert.equal(cell(sheet, 'H' + (19 + index)), 0.25);
      });
    } else {
      assert.equal(cell(sheet, 'E10'), [
        'Mixed Writer (IPRS / Non Member; GEMA) 50%',
        'Dotted Writer (prs / Non Member; BMAI) 50%',
        'Independent Writer (GEMA, Non Member & PRS) 50%',
      ].join('\n'));
      assert.equal(cell(sheet, 'F10'), 'Other Publisher ( N.S.W. / DNS ; BMAI ) 50%');
    }
    assert.deepEqual(input, before, 'Formatting mixed affiliations never rewrites saved text or ownership');
  }
});

for (const society of ['PRS', 'ASCAP']) test(`${society} synchronous builders use the same full-data default`, () => {
  const input = fixture(), before = structuredClone(input);
  const book = context.CueExports.build(society, input.project, null, input.cues, input.works, input.artists);
  const sheet = book.Sheets[book.SheetNames[0]], values = Object.values(sheet).map(item => item?.v).join('\n');
  assert.ok(values.includes(input.works[1].title));
  for (const party of input.works[0].parties) assert.ok(values.includes(party.name), party.name);
  assert.deepEqual(input, before);
});

for (const society of ['PRS', 'ASCAP']) test(`${society} multi-episode exports retain contributor-free cues on every worksheet`, async () => {
  const input = fixture('Series'), before = structuredClone(input);
  const outputs = [2, 7].map(episode => ({ project: input.project, episode,
    cues: input.cues.map(cue => ({ ...cue, id: cue.id + '-' + episode, episode })), works: input.works }));
  const bytes = await context.CueExports.buildEpisodesFormatted(society, outputs, input.artists);
  const book = XLSX.read(bytes, { type: 'array' });
  assert.deepEqual(book.SheetNames, ['Episode_02', 'Episode_07']);
  for (const sheet of Object.values(book.Sheets)) {
    const values = Object.values(sheet).map(item => item?.v).join('\n');
    assert.ok(values.includes(input.works[1].title));
    assert.ok(values.includes('BMAI'));
  }
  assert.deepEqual(input, before);
});

test('explicit historical policies retain their original filtering and registry-fallback behavior', async () => {
  const input = fixture(), before = structuredClone(input);
  for (const society of ['PRS', 'ASCAP']) {
    const { sheet } = await formatted(society, input, { membershipPolicy: 'confirmed-members-v1' });
    const values = Object.values(sheet).map(item => item?.v).join('\n');
    assert.ok(!values.includes('BMAI Writer'));
    assert.ok(!values.includes(input.works[1].title));
  }
  const { sheet } = await formatted('PRS', input, { membershipPolicy: 'recorded-affiliations-v1' });
  assert.equal(cell(sheet, 'I' + (19 + input.works[0].parties.length - 1)), 'PRS');
  assert.deepEqual(input, before);
});
