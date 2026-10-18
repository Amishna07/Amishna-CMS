'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const S = require('../public/societies.js');
const XLSX = require('../public/vendor/xlsx.full.min.js');
const JSZip = require('../public/vendor/jszip.min.js');
const context = { Buffer, Uint8Array, XLSX, JSZip, CueSocieties: S };
context.window = context;
vm.createContext(context);
const source = readFileSync(join(__dirname, '../public/dashboard.js'), 'utf8');
vm.runInContext(source.slice(0, source.indexOf('/* iprs.js */')), context);
context.structuredClone = structuredClone;
vm.runInContext(source.slice(source.indexOf('/* catalog.js */'), source.indexOf('/* database-import.js */')), context);
const project = { id: 'project', title: 'Membership Test', type: 'Movie', periods: [], episodes: [], duration: '01:00:00' };

function fixture() {
  const artists = [
    { id: 'iprs', name: 'IPRS Writer', societies: ['IPRS'] },
    { id: 'prs', name: 'PRS Writer', societies: ['PRS'] },
    { id: 'dual', name: 'Dual Publisher', societies: ['IPRS / PRS'] },
    { id: 'ascap', name: 'ASCAP Writer', societies: ['ASCAP'] },
    { id: 'unknown', name: 'Unknown Writer', societies: [] },
    { id: 'iprs-singer', name: 'IPRS Singer', societies: ['IPRS'] },
    { id: 'prs-singer', name: 'PRS Singer', societies: ['PRS'] },
  ];
  const works = [{
    id: 'mixed', title: 'Mixed Membership Song', artist: 'IPRS Singer, PRS Singer', artistIds: ['iprs-singer', 'prs-singer'], label: 'Unconfirmed Label',
    parties: artists.slice(0, 5).map((artist, index) => ({ artistId: artist.id, name: artist.name, society: '', share: [20, 30, 25, 15, 10][index], role: index === 2 ? 'Publisher' : 'Composer' })),
  }, {
    id: 'prs-song', title: 'PRS Only Song', parties: [{ artistId: 'prs', name: 'PRS Writer', role: 'Composer', share: 100 }],
  }, {
    id: 'unknown-song', title: 'Unconfirmed Song', parties: [{ artistId: 'unknown', name: 'Unknown Writer', role: 'Composer', share: 100 }],
  }];
  const cues = works.map((work, index) => ({ id: 'cue-' + index, workId: work.id, duration: (index + 1) * 60, usage: 'FV', usagePercent: 1.875 }));
  return { artists, works, cues };
}

test('society parsing uses tokens: IPRS alone is never PRS; dual and array memberships work', () => {
  assert.deepEqual(S.parse('IPRS / PRS; ASCAP'), ['IPRS', 'PRS', 'ASCAP']);
  assert.equal(S.has({ society: 'IPRS' }, 'PRS'), false);
  assert.equal(S.has({ societies: ['iprs/ prs', 'ASCAP'] }, 'PRS'), true);
  assert.deepEqual(S.parse('Unknown / N/A'), []);
  assert.equal(S.has({ society: 'NOTIPRS' }, 'IPRS'), false);
});

test('scopes exclude other societies and unknown affiliations, retain dual members and source shares', () => {
  const input = fixture(), before = structuredClone(input);
  const result = S.scope(input.cues, input.works, 'IPRS', input.artists);
  assert.deepEqual(result.cues.map(cue => cue.id), ['cue-0']);
  assert.deepEqual(result.works[0].parties.map(party => [party.name, party.share, party.society]), [['IPRS Writer', 20, 'IPRS'], ['Dual Publisher', 25, 'IPRS']]);
  assert.equal(result.works[0].artist, 'IPRS Singer');
  assert.equal(result.cues[0].usagePercent, 1.875);
  assert.equal(result.summary.prsOnlyArtists, 2);
  assert.equal(result.summary.unknownArtists, 1);
  assert.equal(result.summary.includedCues, 1);
  assert.equal(result.summary.excludedCues, 2);
  assert.deepEqual(input, before);
});

test('explicit non-member affiliations survive catalog reconciliation and every society scope', () => {
  for (const spelling of ['Non Member', 'Non-Member', 'nonmember']) {
    assert.deepEqual(S.parse(spelling), ['NON-MEMBER']);
    assert.equal(S.has({ society: spelling }, 'IPRS'), false);
  }
  const data = { artists: [], works: [{ id: 'nonmember', title: 'Independent Song', parties: [
    { name: 'Independent Writer', role: 'Composer', society: 'Non Member', ipi: '', share: 100 },
  ] }], cues: [{ id: 'independent-cue', workId: 'nonmember', duration: 60 }] };
  context.CueCatalog.ensure(data);
  const before = JSON.stringify(data);
  for (const society of S.supported) {
    const scoped = S.scope(data.cues, data.works, society, data.artists);
    assert.equal(scoped.cues.length, 1);
    assert.equal(scoped.works[0].parties[0].society, 'Non Member');
    assert.equal(scoped.works[0].parties[0].ipi, '');
    assert.equal(S.summary(data)[society].cues, 1);
    assert.equal(S.summary(data)[society].artists, 0);
  }
  assert.equal(JSON.stringify(data), before);
});

test('IPRS, PRS and ASCAP workbooks preserve non-member publisher credits with blank IPI', async () => {
  for (const society of S.supported) {
    const works = [{ id: 'song', title: 'Member and Non Member', parties: [
      { name: 'Member Composer', role: 'Composer', society, ipi: '1360105989', share: 50 },
      { name: 'ZeeTV', role: 'Publisher', society: 'Non Member', ipi: '', share: 50 },
    ] }];
    const cues = [{ id: 'cue', workId: 'song', duration: 60, usage: 'BI' }];
    const before = JSON.stringify(works);
    const bytes = await context.CueExports.buildFormatted(society, project, null, cues, works);
    const workbook = XLSX.read(bytes, { type: 'array' }), sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (society === 'IPRS') {
      assert.equal(sheet.H14.v, 'ZeeTV');
      assert.equal(sheet.G14.v, 'E');
      assert.equal(sheet.I14.v, 'NS');
      assert.equal(sheet.J14.v, '50%');
      assert.ok(!sheet.K14?.v);
    } else if (society === 'PRS') {
      assert.equal(sheet.E20.v, 'ZeeTV');
      assert.equal(sheet.D20.v, 'Publisher');
      assert.equal(sheet.I20.v, 'Non Member');
      assert.equal(sheet.H20.v, 0.5);
      assert.ok(!sheet.G20?.v);
    } else {
      assert.equal(sheet.F10.v, 'ZeeTV (Non Member) 100%');
      assert.equal(sheet.E10.v, 'Member Composer (ASCAP) 100%');
    }
    assert.equal(JSON.stringify(works), before);
  }
});

test('legacy split non-member tokens and stale linked memberships cannot drop or relabel a non-member credit', () => {
  assert.deepEqual(S.parse(['NON', 'MEMBER', 'NON-MEMBER']), ['NON-MEMBER']);
  const artists = [{ id: 'zeetv', name: 'ZeeTV', societies: ['IPRS', 'NON', 'MEMBER', 'NON-MEMBER'] }];
  const works = [{ id: 'background', parties: [{ artistId: 'zeetv', name: 'ZeeTV', role: 'Publisher', society: 'Non Member', ipi: '', share: 50 }] }];
  const cues = [{ workId: 'background', duration: 60 }];
  for (const society of S.supported) {
    const frozen = S.freezeWorks(works, artists);
    const first = S.scope(cues, frozen, society);
    const second = S.scope(first.cues, first.works, society);
    assert.equal(second.works[0].parties[0].society, 'Non Member');
    assert.equal(second.works[0].parties[0].ipi, '');
    assert.equal(second.works[0].parties[0].share, 50);
    assert.equal(S.has(works[0].parties[0], society, artists), false);
  }
  assert.deepEqual(S.memberships({ artistId: 'zeetv', name: 'ZeeTV' }, [{ ...artists[0], societies: ['NON', 'MEMBER', 'NON-MEMBER'] }]), ['NON-MEMBER']);
});

test('statistics and export eligibility agree and do not count a cue once for each contributor', () => {
  const data = fixture(), stats = S.summary(data);
  assert.deepEqual(stats.IPRS, { artists: 3, songs: 1, cues: 1, duration: 60 });
  assert.deepEqual(stats.PRS, { artists: 3, songs: 2, cues: 2, duration: 180 });
  assert.deepEqual(stats.ASCAP, { artists: 1, songs: 1, cues: 1, duration: 60 });
  assert.equal(stats.totalArtists, 7);
  assert.equal(stats.dualArtists, 1);
  assert.equal(stats.unknownArtists, 1);
  for (const society of S.supported) assert.equal(S.scope(data.cues, data.works, society, data.artists).cues.length, stats[society].cues);
  assert.equal(S.summary({ ...data, cues: [{ ...data.cues[0], duration: Infinity }] }).IPRS.duration, 0);
});

test('frozen membership snapshots retain historical decisions after artist memberships change', () => {
  const data = fixture(), frozen = S.freezeWorks(data.works, data.artists);
  data.artists.forEach(artist => { artist.societies = ['ASCAP']; });
  const result = S.scope(data.cues, frozen, 'IPRS', data.artists);
  assert.deepEqual(result.works[0].parties.map(party => party.name), ['IPRS Writer', 'Dual Publisher']);
  assert.equal(result.works[0].artist, 'IPRS Singer');
  assert.equal(result.summary.IPRS.artists, 3);
});

test('generated IPRS and PRS worksheets contain only eligible contributor names and selected labels', async () => {
  const data = fixture(), before = JSON.stringify(data);
  for (const [society, names, absent, shareCells] of [
    ['IPRS', ['IPRS Writer', 'Dual Publisher', 'IPRS Singer'], ['PRS Writer', 'PRS Singer', 'PRS Only Song', 'Unknown Writer', 'ASCAP Writer'], [['J13', '20%'], ['J14', '25%']]],
    ['PRS', ['PRS Writer', 'Dual Publisher', 'PRS Only Song'], ['IPRS Writer', 'Unknown Writer', 'ASCAP Writer'], [['H19', .3], ['H20', .25]]],
  ]) {
    const bytes = await context.CueExports.buildFormatted(society, project, null, data.cues, data.works, data.artists);
    const workbook = XLSX.read(bytes, { type: 'array' }), sheet = workbook.Sheets[workbook.SheetNames[0]];
    const text = Object.values(sheet).map(cell => cell?.v).filter(value => typeof value === 'string').join('\n');
    for (const name of names) assert.ok(text.includes(name), society + ' missing ' + name);
    for (const name of absent) assert.ok(!new RegExp('\\b' + name + '\\b').test(text), society + ' includes ' + name);
    assert.ok(!text.includes('IPRS/PRS'));
    assert.ok(!text.includes('Unconfirmed Song'));
    for (const [cell, value] of shareCells) assert.equal(sheet[cell].v, value);
    assert.equal(sheet[society === 'IPRS' ? 'I13' : 'I19'].v, society);
  }
  assert.equal(JSON.stringify(data), before);
});

test('ASCAP retains its existing 200-percent convention and excludes unconfirmed label fallbacks', async () => {
  const data = fixture();
  const bytes = await context.CueExports.buildFormatted('ASCAP', project, null, data.cues, data.works, data.artists);
  const workbook = XLSX.read(bytes, { type: 'array' }), sheet = workbook.Sheets[workbook.SheetNames[0]];
  assert.equal(sheet.E10.v, 'ASCAP Writer (ASCAP) 30%');
  assert.ok(!sheet.F10?.v);
  const text = Object.values(sheet).map(cell => cell?.v).join('\n');
  assert.ok(!text.includes('Unconfirmed Label'));
  assert.ok(!text.includes('PRS Writer'));
});

test('no matching memberships is a clear error, never a blank or placeholder export', async () => {
  const data = fixture();
  await assert.rejects(context.CueExports.buildFormatted('IPRS', project, null, data.cues.slice(1), data.works, data.artists), /No cues with confirmed IPRS/);
});

test('indexed lookup avoids ambiguous names and supports IPI and alias matching', () => {
  const artists = [{ id: 'a', name: 'Same Name', ipi: '123', societies: ['IPRS'], aliases: ['Unique Alias'] }, { id: 'b', name: 'Same Name', ipi: '456', societies: ['PRS'] }];
  const index = S.indexArtists(artists);
  assert.deepEqual(S.memberships({ name: 'Same Name' }, index), []);
  assert.deepEqual(S.memberships({ name: 'Unique Alias' }, index), ['IPRS']);
  assert.deepEqual(S.memberships({ name: 'Same Name', ipi: '456' }, index), ['PRS']);
});

test('editing artist memberships updates every linked contributor and survives registry reconciliation', () => {
  const data = fixture();
  context.CueCatalog.ensure(data);
  const artist = data.artists.find(artist => artist.id === 'dual');
  context.CueCatalog.applyArtist(data, { ...artist, societies: ['PRS'] }, artist.id);
  context.CueCatalog.ensure(data);
  assert.deepEqual(data.works[0].parties.filter(party => party.artistId === 'dual').map(party => party.society), ['PRS']);
  assert.equal(S.has(data.works[0].parties[2], 'IPRS', data.artists), false);
  assert.equal(S.has(data.works[0].parties[2], 'PRS', data.artists), true);
  context.CueCatalog.applyArtist(data, { ...artist, societies: [] }, artist.id);
  context.CueCatalog.ensure(data);
  assert.equal(data.artists.find(artist => artist.id === 'dual').societies.length, 0);
  assert.equal(data.works[0].parties[2].society, '');
});
