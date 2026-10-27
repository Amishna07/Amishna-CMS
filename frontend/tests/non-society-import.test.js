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
const societySource = readFileSync(join(__dirname, '../public/societies.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function harness() {
  const context = vm.createContext({ Buffer, Uint8Array, TextDecoder, XLSX, JSZip, structuredClone, crypto: { randomUUID } });
  context.window = context;
  vm.runInContext(societySource, context);
  vm.runInContext(source.slice(0, source.indexOf('/* iprs.js */')), context);
  vm.runInContext(source.slice(source.indexOf('/* catalog.js */'), source.indexOf('/* app.prototype.js */')), context);
  return context;
}

function upload(rows, extension) {
  let bytes;
  if (extension === 'csv') bytes = Buffer.from(rows.map(row => row.map(value => '"' + String(value).replace(/"/g, '""') + '"').join(',')).join('\r\n'));
  else {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Songs');
    bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx', compression: true });
  }
  return { name: 'non-society.' + extension, size: bytes.length, arrayBuffer: async () => Uint8Array.from(bytes).buffer };
}

for (const spelling of ['NS', 'ns', 'N.S.', 'Non Society', 'Non-Society']) {
  test(spelling + ' marks a non-society contributor without creating a supported membership', () => {
    const S = harness().CueSocieties, party = { name: 'Independent Writer', society: spelling, share: 37.5 };
    assert.deepEqual(plain(S.parse(spelling)), ['NON-MEMBER']);
    assert.equal(S.isNonMember(party), true);
    for (const society of S.supported) assert.equal(S.has(party, society), false);
    assert.equal(party.society, spelling);
    assert.equal(party.share, 37.5);
  });
}

test('an explicit NS credit overrides stale linked memberships, including frozen records', () => {
  const S = harness().CueSocieties;
  const artists = [{ id: 'writer', name: 'Independent Writer', societies: ['IPRS', 'PRS'] }];
  const party = { artistId: 'writer', name: 'Independent Writer', society: 'NS', share: 100 };
  assert.deepEqual(plain(S.memberships(party, artists)), ['NON-MEMBER']);
  assert.equal(S.isNonMember(party, artists), true);
  for (const society of S.supported) assert.equal(S.has(party, society, artists), false);
  const frozen = S.freezeWorks([{ id: 'song', parties: [party] }], artists);
  artists[0].societies = ['ASCAP'];
  assert.deepEqual(plain(S.memberships(frozen[0].parties[0], artists)), ['NON-MEMBER']);
  assert.equal(frozen[0].parties[0].society, 'NS');
});

test('mixed affiliations retain real societies and unknown DP tokens', () => {
  const S = harness().CueSocieties;
  assert.deepEqual(plain(S.parse('NS / IPRS')).sort(), ['IPRS', 'NON-MEMBER']);
  assert.equal(S.has({ society: 'NS / IPRS' }, 'IPRS'), true);
  assert.deepEqual(plain(S.parse('NS / DP')).sort(), ['DP', 'NON-MEMBER']);
  assert.deepEqual(plain(S.parse('DP')), ['DP']);
  assert.equal(S.isNonMember({ society: 'DP' }), false);
  assert.deepEqual(plain(S.parse('NSC')), ['NSC'], 'an NS substring does not change another affiliation');
});

test('NS aliases never match substrings within other society names or codes', () => {
  const S = harness().CueSocieties;
  for (const value of ['NSW', 'DNS', 'NSC', 'SNS', 'NS-OTHER']) {
    assert.deepEqual(plain(S.parse(value)), [value]);
    assert.equal(S.isNonMember({ society: value }), false);
    assert.equal(S.label(value), value);
  }
  for (const value of ['N.S.W.', 'N.S.A.']) {
    assert.equal(S.isNonMember({ society: value }), false);
    assert.equal(S.label(value), value);
  }
});

test('song details show Non-society for raw NS without rewriting imported contributor data', () => {
  const ctx = harness();
  vm.runInContext(source.slice(source.indexOf('/* insights.js'), source.indexOf('/* insights.js end */')), ctx);
  ctx.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  ctx.matchMedia = () => ({ matches: false });
  ctx.scrollTo = () => {};
  const state = {
    version: 1, artists: [], projects: [], cues: [], exports: [], imports: [], activity: [], preferences: {},
    works: [{ id: 'song', title: 'Independent Theme', type: 'Song', societies: {}, parties: [
      { name: 'Independent Writer', role: 'Composer', society: 'NS', share: 100, ipi: '000123' },
    ] }],
  };
  ctx.CueCatalog.ensure(state);
  const before = JSON.stringify(state);
  let html = '';
  const catalog = ctx.CueCatalog.create({
    state: () => state, revision: () => 0, esc: value => String(value ?? ''), icon: () => '', date: String,
    render: () => { html = catalog.songs(); },
  });
  const button = { dataset: { catalog: 'song-select', id: 'song' } };
  catalog.click({ target: { closest: () => button }, preventDefault() {} });
  assert.match(html, /song-record-page/);
  assert.match(html, /<dt>Society<\/dt><dd>Non-society<\/dd>/);
  assert.ok(!/>\s*NON-MEMBER\s*</.test(html), 'internal membership markers are not rendered as affiliation labels');
  assert.equal(JSON.stringify(state), before, 'opening details does not change stored contributor data');
  assert.equal(state.works[0].parties[0].society, 'NS');
});

test('editing unrelated artist metadata preserves an explicit NS credit over stale mixed memberships', () => {
  const ctx = harness(), state = {
    artists: [{ id: 'writer', name: 'Independent Writer', ipi: '000123', roles: ['Composer'], societies: ['IPRS', 'NON-MEMBER'], aliases: [] }],
    works: [{ id: 'song', title: 'Independent Theme', parties: [
      { artistId: 'writer', name: 'Independent Writer', role: 'Composer', society: 'NS', share: 100, ipi: '000123' },
    ] }],
  };
  ctx.CueCatalog.ensure(state);
  const before = plain(state.works[0].parties[0]);
  ctx.CueCatalog.applyArtist(state, { ...plain(state.artists[0]), notes: 'Updated contact notes' }, 'writer');
  assert.equal(state.artists[0].notes, 'Updated contact notes');
  assert.deepEqual(plain(state.works[0].parties[0]), before);
  assert.deepEqual(plain(ctx.CueSocieties.memberships(state.works[0].parties[0], state.artists)), ['NON-MEMBER']);
  assert.equal(ctx.CueSocieties.has(state.works[0].parties[0], 'IPRS', state.artists), false);
});

for (const extension of ['csv', 'xlsx']) {
  test(extension + ' song import keeps NS contributors, original affiliations, leading-zero IPI and shares', async () => {
    const ctx = harness(), state = { works: [], artists: [] };
    const rows = [
      ['Song Name', 'Composer 1', 'Composer 1 · Society', 'Composer 1 · CAE', 'Composer 1 · Share', 'Publisher', 'Publisher · Society', 'Publisher · CAE', 'Publisher · Share'],
      ['Independent Theme', 'Independent Writer', 'NS', '00001234567', '37.5', 'Registered Publisher', 'IPRS', '00007654321', '62.5'],
    ];
    const workbook = await ctx.CueFileSafety.read(upload(rows, extension), { extensions: ['csv', 'xlsx'], raw: true });
    const cells = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: '', raw: false });
    const before = JSON.stringify(state);
    const review = ctx.CueDatabaseImport.preview(cells.slice(1), ctx.CueDatabaseImport.mapping(cells[0]), state.works);
    assert.equal(review[0].issues.length, 0);
    assert.equal(JSON.stringify(state), before, 'review has no workspace side effects');
    assert.equal(ctx.CueDatabaseImport.execute(state, review, 'non-society.' + extension).added, 1);
    ctx.CueCatalog.ensure(state);
    assert.equal(state.works[0].parties.length, 2, 'non-society credits are retained');
    const writer = state.works[0].parties.find(party => party.name === 'Independent Writer');
    assert.equal(writer.society, 'NS', 'the imported affiliation remains available');
    assert.equal(writer.ipi, '00001234567');
    assert.equal(writer.share, 37.5);
    assert.equal(state.works[0].parties.reduce((sum, party) => sum + party.share, 0), 100);
    const artist = state.artists.find(artist => artist.id === writer.artistId);
    assert.deepEqual(plain(artist.societies), ['NON-MEMBER']);
    assert.equal(ctx.CueSocieties.isNonMember(writer, state.artists), true);
    for (const society of ctx.CueSocieties.supported) assert.equal(ctx.CueSocieties.has(writer, society, state.artists), false);
    const after = JSON.stringify(state);
    assert.equal(ctx.CueCatalog.ensure(state), false);
    assert.equal(JSON.stringify(state), after, 'reconciliation is idempotent');
  });
}

test('reconciliation repairs saved NS membership markers without dropping credits or ownership', () => {
  const ctx = harness(), state = {
    artists: [{ id: 'legacy', name: 'Legacy Writer', ipi: '000001', societies: ['NS'], roles: ['Composer'] }],
    works: [{ id: 'legacy-song', title: 'Legacy Theme', parties: [{ artistId: 'legacy', name: 'Legacy Writer', ipi: '000001', society: 'NS', role: 'Composer', share: 0 }] }],
  };
  ctx.CueCatalog.ensure(state);
  assert.deepEqual(plain(state.artists[0].societies), ['NON-MEMBER']);
  assert.equal(state.works[0].parties.length, 1);
  assert.equal(state.works[0].parties[0].society, 'NS');
  assert.equal(state.works[0].parties[0].share, 0);
  assert.equal(state.works[0].parties[0].ipi, '000001');
  assert.equal(ctx.CueCatalog.ensure(state), false);
});

for (const society of ['IPRS', 'PRS', 'ASCAP']) for (const spelling of ['NS', 'ns', 'N.S.', 'Non Society', 'Non-society']) {
  test(society + ' exports ' + spelling + ' as ' + (society === 'IPRS' ? 'NS' : 'Non Member') + ' without changing saved credits or ownership', async () => {
    const ctx = harness();
    const works = [{ id: 'song', title: 'Independent Theme', parties: [
      { name: 'Independent Writer', role: 'Composer', society: spelling, ipi: '00001234567', share: 70 },
      { name: 'Independent Publisher', role: 'Publisher', society: spelling, ipi: '', share: 30 },
    ] }];
    const cues = [{ id: 'cue', workId: 'song', duration: 60, usage: 'FV' }];
    const project = { id: 'project', type: 'Movie', title: 'Non-society Production', periods: [], episodes: [] };
    const before = JSON.stringify({ works, cues });
    const scope = ctx.CueSocieties.scope(cues, works, society);
    assert.equal(scope.cues.length, 1);
    assert.deepEqual(plain(scope.works[0].parties.map(party => [party.name, party.share])), [['Independent Writer', 70], ['Independent Publisher', 30]]);
    const stats = ctx.CueSocieties.summary({ works, cues });
    assert.equal(stats[society].artists, 0, 'non-society contributors do not count as members');
    assert.equal(stats[society].cues, 1);
    for (const options of [undefined, { membershipPolicy: 'recorded-affiliations-v1' }, { membershipPolicy: 'confirmed-members-v1' }]) {
      const bytes = await ctx.CueExports.buildFormatted(society, project, null, cues, works, [], options);
      const book = XLSX.read(bytes, { type: 'array' }), sheet = book.Sheets[book.SheetNames[0]];
      if (society === 'IPRS') {
        assert.equal(sheet.H13.v, 'Independent Writer'); assert.equal(sheet.I13.v, 'NS'); assert.equal(sheet.J13.v, '70%');
        assert.equal(sheet.H14.v, 'Independent Publisher'); assert.equal(sheet.I14.v, 'NS'); assert.equal(sheet.J14.v, '30%');
      } else if (society === 'PRS') {
        assert.equal(sheet.E19.v, 'Independent Writer'); assert.equal(sheet.I19.v, 'Non Member'); assert.equal(sheet.H19.v, 0.7);
        assert.equal(sheet.E20.v, 'Independent Publisher'); assert.equal(sheet.I20.v, 'Non Member'); assert.equal(sheet.H20.v, 0.3);
        assert.equal(sheet.G19.v, '00001234567', 'IPI keeps its leading zeros');
      } else {
        assert.equal(sheet.E10.v, 'Independent Writer (Non Member) 140%');
        assert.equal(sheet.F10.v, 'Independent Publisher (Non Member) 60%');
      }
      assert.equal(JSON.stringify({ works, cues }), before, 'Only export labels change; stored spelling, contributors and numeric shares remain intact');
    }
  });
}
