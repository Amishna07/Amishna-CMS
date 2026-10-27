'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const S = require('../public/societies.js');
const XLSX = require('../public/vendor/xlsx.full.min.js');
const JSZip = require('../public/vendor/jszip.min.js');

const source = readFileSync(join(__dirname, '../public/dashboard.js'), 'utf8');
const context = { Buffer, Uint8Array, XLSX, JSZip, CueSocieties: S };
context.window = context;
vm.createContext(context);
vm.runInContext(source.slice(0, source.indexOf('/* iprs.js */')), context);
const recorded = { membershipPolicy: 'recorded-affiliations-v1' };

function fixture(type = 'Movie', count = 1) {
  const project = {
    id: 'p1', type, title: 'Recorded Affiliation Production', duration: '01:12:00',
    airdate: '2026-09-24', periods: [],
    episodes: [{ number: 3, title: 'Third Episode', duration: '00:24:00', airdate: '2026-09-25' }],
  };
  const artists = [
    { id: 'iprs', name: 'IPRS Composer', ipi: '0000123', societies: ['IPRS'] },
    { id: 'registry', name: 'Registry Lyricist', ipi: '0000456', societies: ['PRS'] },
    { id: 'unknown', name: 'Unknown Writer', ipi: '0000789', societies: [] },
  ];
  const works = Array.from({ length: count }, (_, index) => ({
    id: 'w' + index, title: 'Cue ' + (index + 1),
    label: 'Unrecorded Publisher Fallback',
    societies: { ASCAP: '0000' + (index + 1), IPRS: '000IPRS' + index, PRS: '000PRS' + index },
    parties: [
      { artistId: 'iprs', name: 'IPRS Composer', role: 'Composer', society: 'IPRS', ipi: '0000123', share: 12.25 },
      { name: 'PRS Author', role: 'Author', society: 'PRS', ipi: '0000321', share: 13.25 },
      { name: 'NS Publisher', role: 'Publisher', society: 'NS', ipi: '0000654', share: 25 },
      { artistId: 'unknown', name: 'Unknown Writer', role: 'Writer', society: '', ipi: '0000789', share: 5 },
      { name: 'ASCAP Writer', role: 'Composer', society: 'ASCAP', ipi: '0000987', share: 20 },
      { artistId: 'registry', name: 'Registry Lyricist', role: 'Lyricist', society: '', ipi: '0000456', share: 9.5 },
      { name: 'Unknown Publisher', role: 'Publisher', society: '', ipi: '0000111', share: 15 },
    ],
  }));
  const cues = works.map((work, index) => ({
    id: 'c' + index, projectId: project.id, episode: type === 'Series' ? 3 : null,
    workId: work.id, duration: 61 + index * 7, usageCount: index + 1,
    usage: 'FV', societyUsage: { ASCAP: index % 2 ? 'BV' : 'MT', IPRS: 'FV', PRS: 'V' },
    usagePercent: 12.345 + index,
  }));
  return { project, artists, works, cues };
}

async function exportSheet(data, society = 'ASCAP', options = recorded) {
  const bytes = await context.CueExports.buildFormatted(
    society, data.project, data.project.type === 'Series' ? 3 : null,
    data.cues, data.works, data.artists, options,
  );
  const zip = await JSZip.loadAsync(bytes);
  const workbook = XLSX.read(bytes, { type: 'array', cellStyles: true });
  return { sheet: workbook.Sheets[workbook.SheetNames[0]], zip };
}

for (const type of ['Movie', 'Series']) {
  for (const count of [1, 12]) {
    test(`ASCAP recorded affiliations preserves ${count} ${type} cues and each contributor's actual affiliation`, async () => {
      const data = fixture(type, count), before = structuredClone(data);
      const { sheet, zip } = await exportSheet(data);
      const expectedWriters = [
        'IPRS Composer (IPRS) 24.5%',
        'PRS Author (PRS) 26.5%',
        'Unknown Writer 10%',
        'ASCAP Writer (ASCAP) 40%',
        'Registry Lyricist (PRS) 19%',
      ].join('\n');
      for (const [index, cue] of data.cues.entries()) {
        const row = 10 + index;
        assert.equal(sheet['A' + row].v, index + 1);
        assert.equal(sheet['B' + row].v, data.works[index].title);
        assert.equal(sheet['C' + row].v, cue.societyUsage.ASCAP);
        assert.equal(sheet['D' + row].v, cue.duration / 86400);
        assert.equal(sheet['D' + row].w, '0:' + String(Math.floor(cue.duration / 60)).padStart(2, '0') + ':' + String(cue.duration % 60).padStart(2, '0'));
        assert.equal(sheet['E' + row].v, expectedWriters);
        assert.equal(sheet['F' + row].v, 'NS Publisher (Non Member) 50%\nUnknown Publisher 30%');
        assert.equal(sheet['G' + row].v, data.works[index].societies.ASCAP);
        assert.equal(sheet['G' + row].t, 's', 'leading-zero work codes remain text');
      }
      assert.equal(sheet.A4.v, type === 'Series' ? 'Episode Title/Number: Third Episode / 3' : 'Episode Title/Number: Movie');
      assert.equal(sheet.A6.v, type === 'Series' ? 'Program Length: 00:24:00' : 'Program Length: 01:12:00');
      assert.ok(!Object.values(sheet).some(cell => String(cell?.v || '').includes('Unrecorded Publisher Fallback')));
      const template = await JSZip.loadAsync(Buffer.from(context.CueExportTemplateData.ASCAP, 'base64'));
      assert.equal(await zip.file('xl/styles.xml').async('string'), await template.file('xl/styles.xml').async('string'));
      assert.deepEqual(data, before, 'source cues, shares, IPI numbers, artists and memberships are untouched');
    });
  }
}

test('ASCAP can export cues with no ASCAP members while strict eligibility remains available', async () => {
  const data = fixture(), before = structuredClone(data);
  data.works[0].parties = data.works[0].parties.filter(party => party.society !== 'ASCAP');
  const original = structuredClone(data);
  assert.deepEqual(S.scope(data.cues, data.works, 'ASCAP', data.artists).works[0].parties.map(party => party.name), ['NS Publisher']);
  const unconfirmed = structuredClone(data);
  unconfirmed.works[0].parties = unconfirmed.works[0].parties.filter(party => party.society !== 'NS');
  assert.equal(S.scope(unconfirmed.cues, unconfirmed.works, 'ASCAP', unconfirmed.artists).cues.length, 0);
  await assert.rejects(exportSheet(unconfirmed, 'ASCAP', { membershipPolicy: 'confirmed-members-v1' }), /No cues with confirmed ASCAP/);
  const scoped = S.scope(data.cues, data.works, 'ASCAP', data.artists, recorded);
  assert.deepEqual(scoped.cues, data.cues);
  assert.equal(scoped.works[0]._exportSociety, 'ASCAP');
  assert.deepEqual(scoped.works[0].parties.map(party => party.society), original.works[0].parties.map(party => party.society));
  assert.deepEqual(S.memberships(scoped.works[0].parties[4]), ['PRS']);
  assert.deepEqual(scoped.works[0].parties.map(party => party.ipi), original.works[0].parties.map(party => party.ipi));
  assert.deepEqual(scoped.works[0].parties.map(party => party.share), original.works[0].parties.map(party => party.share));
  const { sheet } = await exportSheet(data);
  assert.equal(sheet.B10.v, 'Cue 1');
  assert.ok(!sheet.E10.v.includes('(ASCAP)'));
  assert.ok(sheet.E10.v.includes('Unknown Writer 10%'));
  assert.ok(sheet.F10.v.includes('NS Publisher (Non Member)'));
  assert.deepEqual(data, original);
  assert.deepEqual(data.artists, before.artists);
});

test('recorded affiliation exports preserve explicit affiliation text over artist-registry memberships', () => {
  const data = fixture();
  data.works[0].parties[0].society = 'IPRS / PRS';
  data.artists[0].societies = ['ASCAP'];
  const before = structuredClone(data);
  const scoped = S.scope(data.cues, data.works, 'ASCAP', data.artists, recorded);
  assert.equal(scoped.works[0].parties[0].society, 'IPRS / PRS');
  assert.equal(scoped.works[0].parties[3].society, '');
  assert.deepEqual(data, before);
});

test('recorded affiliations retain PRS credits while IPRS still filters contributors', async () => {
  const data = fixture(), before = structuredClone(data);
  for (const society of ['IPRS']) {
    assert.deepEqual(
      S.scope(data.cues, data.works, society, data.artists, recorded),
      S.scope(data.cues, data.works, society, data.artists),
    );
    const { sheet } = await exportSheet(data, society);
    const text = Object.values(sheet).map(cell => cell?.v).join('\n');
    assert.ok(!text.includes('ASCAP Writer'));
    assert.ok(text.includes('NS Publisher'), 'explicit non-society ownership credits remain included');
    assert.ok(!text.includes('Unknown Writer'));
    assert.ok(!text.includes('Unknown Publisher'));
    assert.ok(text.includes(society === 'IPRS' ? 'IPRS Composer' : 'PRS Author'));
  }
  const { sheet } = await exportSheet(data, 'PRS');
  const text = Object.values(sheet).map(cell => cell?.v).join('\n');
  for (const party of data.works[0].parties) assert.ok(text.includes(party.name), 'PRS recorded affiliations retain ' + party.name);
  assert.equal(sheet.I19.v, 'IPRS', 'PRS retains the recorded affiliation');
  assert.deepEqual(data, before);
});
