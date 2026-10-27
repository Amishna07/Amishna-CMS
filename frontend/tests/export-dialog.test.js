'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const source = readFileSync(join(__dirname, '../public/dashboard.js'), 'utf8');
const domainContext = vm.createContext({});
vm.runInContext(source.slice(0, source.indexOf('/* data.js */')), domainContext);
globalThis.CueDomain = domainContext.CueDomain;
globalThis.CueSocieties = require('../public/societies.js');
const { createCueExportDialog, createDraft, valuesFor, setValue, prepare } = require('../public/export-dialog.js');

function sourceOptions() {
  const project = {
    id: 'P1', title: 'Original Serial', type: 'Series', year: 2025, language: 'Marathi',
    genre: 'Drama', serialType: 'Web Series', totalEpisodes: 10, season: 1,
    episodes: [{ number: 1, title: 'First', duration: '00:25:00', airdate: '1 Apr 2025' }, { number: 2, title: 'Second', duration: '00:30:00', airdate: '2 Apr 2025' }],
    periods: [{ from: 1, to: 1, director: 'First Director', producer: 'Producer', company: 'Studio One', cast: 'Cast One' }, { from: 2, to: 10, director: 'Second Director', producer: 'Producer', company: 'Studio Two', cast: 'Cast Two' }],
    ascap: { address: 'Office', phone: '123' },
  };
  const first = [{ id: 'C1', projectId: 'P1', workId: 'W1', episode: 1, duration: 60, usage: 'FV', usagePercent: 17.25, notes: 'Keep this note' }];
  const second = [{ id: 'C2', projectId: 'P1', workId: 'W1', episode: 2, duration: 90, usage: 'BI', usagePercent: 33.3 }];
  const works = [{ id: 'W1', title: 'Song', parties: [{ name: 'Composer', role: 'Composer', share: 25, society: 'IPRS/PRS/ASCAP' }, { name: 'Publisher', role: 'Publisher', share: 75, society: 'IPRS/PRS/ASCAP' }], isrc: 'IN1234567890' }];
  return { project, episode: 2, cues: second, works, episodes: [{ episode: 1, cues: first }, { episode: 2, cues: second }] };
}

test('episode range exports only episodes inside the inclusive bounds', () => {
  const input = sourceOptions();
  input.episodes.push({ episode: 5, cues: [{ ...input.episodes[0].cues[0], id: 'C5', episode: 5 }] });
  input.project.episodes.push({ ...input.project.episodes[0], number: 5 });
  const before = structuredClone(input), draft = createDraft(input);
  draft.scope = 'range';
  draft.rangeFrom = 2;
  draft.rangeTo = 5;
  const result = prepare(draft);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.outputs.map(output => output.sourceEpisodes), [[2], [5]]);
  assert.deepEqual(result.outputs.flatMap(output => output.cues.map(cue => cue.episode)), [2, 5]);
  assert.deepEqual(result.outputs.flatMap(output => output.cues.map(cue => cue.id)), ['C2', 'C5']);
  assert.deepEqual(input, before);
  draft.rangeTo = 2;
  assert.deepEqual(prepare(draft).outputs.map(output => output.episode), [2]);
});

test('reversed episode range blocks export', () => {
  const draft = createDraft(sourceOptions());
  draft.scope = 'range';
  draft.rangeFrom = 2;
  draft.rangeTo = 1;
  assert.equal(prepare(draft).outputs.length, 0);
  assert.match(prepare(draft).errors[0], /valid episode range/);
});

test('dialog preselects project type/current episode and defaults every format on', () => {
  const draft = createDraft(sourceOptions());
  assert.equal(draft.type, 'Series');
  assert.equal(draft.selected, 1);
  assert.equal(draft.scope, 'single');
  assert.deepEqual(draft.societies, ['IPRS', 'PRS', 'ASCAP']);
  assert.equal(valuesFor(draft).episodeNumber, '02');
  assert.equal(valuesFor(draft).director, 'Second Director');
  assert.equal(valuesFor(draft).duration, '00:30:00');
  assert.equal(valuesFor(draft).ascap_address, 'Office');
});

test('editable serial name and episode number affect only export clones, preserving cues and shares', () => {
  const input = sourceOptions(), before = structuredClone(input), draft = createDraft(input);
  setValue(draft, 'title', 'Renamed Serial');
  setValue(draft, 'episodeNumber', '07');
  setValue(draft, 'episodeTitle', 'Output episode');
  const { outputs, errors } = prepare(draft), output = outputs[0];
  assert.deepEqual(errors, []);
  assert.equal(output.episode, 7);
  assert.equal(output.project.title, 'Renamed Serial');
  assert.equal(output.project.episodes[0].number, 7);
  assert.equal(output.project.episodes[0].title, 'Output episode');
  assert.equal(output.cues[0].episode, 7);
  assert.equal(output.cues[0].id, 'C2');
  assert.equal(output.cues[0].usagePercent, 33.3);
  assert.deepEqual(output.works[0].parties, input.works[0].parties);
  assert.deepEqual(input, before);
});

test('movie adaptation keeps the selected source cue and metadata without altering source project', () => {
  const input = sourceOptions(), before = structuredClone(input), draft = createDraft(input);
  draft.type = 'Movie';
  setValue(draft, 'title', 'Movie Name');
  setValue(draft, 'productionNo', 'Censor-123');
  const { outputs, errors } = prepare(draft), output = outputs[0];
  assert.deepEqual(errors, []);
  assert.equal(output.project.type, 'Movie');
  assert.equal(output.project.title, 'Movie Name');
  assert.equal(output.project.productionNo, 'Censor-123');
  assert.equal(output.project.duration, '00:30:00');
  assert.equal(output.project.periods[0].director, 'Second Director');
  assert.deepEqual(output.project.episodes, []);
  assert.equal(output.episode, null);
  assert.equal(output.cues.length, 1);
  assert.equal(output.cues[0].id, 'C2');
  assert.equal(output.cues[0].episode, null);
  assert.deepEqual(input, before);
});

test('all serial episodes preserve their own credits, dates and durations; number edits stay with one episode', () => {
  const draft = createDraft(sourceOptions());
  draft.scope = 'all';
  setValue(draft, 'title', 'Shared Serial');
  setValue(draft, 'episodeNumber', '09');
  setValue(draft, 'airdate', '3 May 2026');
  const { outputs, errors } = prepare(draft);
  assert.deepEqual(errors, []);
  assert.deepEqual(outputs.map(output => output.episode), [1, 9]);
  assert.deepEqual(outputs.map(output => output.project.title), ['Shared Serial', 'Shared Serial']);
  assert.deepEqual(outputs.map(output => output.project.periods[0].director), ['First Director', 'Second Director']);
  assert.deepEqual(outputs.map(output => output.project.duration), ['00:25:00', '00:30:00']);
  assert.deepEqual(outputs.map(output => output.project.airdate), ['1 Apr 2025', '3 May 2026']);
  assert.deepEqual(outputs.map(output => output.cues[0].id), ['C1', 'C2']);
});

test('all selected episodes can be combined as one movie, preserving each cue exactly once', () => {
  const draft = createDraft(sourceOptions());
  draft.scope = 'all';
  draft.type = 'Movie';
  setValue(draft, 'duration', '01:30:00');
  const { outputs, errors } = prepare(draft);
  assert.deepEqual(errors, []);
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].project.duration, '01:30:00');
  assert.deepEqual(outputs[0].cues.map(cue => cue.id), ['C1', 'C2']);
  assert.deepEqual(outputs[0].cues.map(cue => cue.episode), [null, null]);
  assert.deepEqual(outputs[0].sourceEpisodes, [1, 2]);
});

test('optional metadata may be blank; invalid name, episode, duration or duplicate episode numbers is reported', () => {
  const draft = createDraft({ project: { id: 'P2', title: 'Minimal', type: 'Movie' }, episode: null, cues: [], works: [] });
  assert.deepEqual(prepare(draft).errors, []);
  draft.type = 'Series';
  setValue(draft, 'episodeNumber', '00');
  setValue(draft, 'title', ' ');
  setValue(draft, 'duration', 'bad time');
  assert.equal(prepare(draft).errors.length, 3);
  const range = createDraft(sourceOptions());
  range.scope = 'all';
  setValue(range, 'episodeNumber', '01');
  assert.match(prepare(range).errors[0], /same export episode number/);
});

test('changing displayed episode restores its own typed fields and all shared fields remain intact', () => {
  const draft = createDraft(sourceOptions());
  setValue(draft, 'episodeNumber', '12');
  setValue(draft, 'episodeTitle', 'Edited second episode');
  setValue(draft, 'director', 'Shared Director');
  draft.selected = 0;
  assert.equal(valuesFor(draft).episodeNumber, '01');
  assert.equal(valuesFor(draft).episodeTitle, 'First');
  assert.equal(valuesFor(draft).director, 'Shared Director');
  draft.selected = 1;
  assert.equal(valuesFor(draft).episodeNumber, '12');
  assert.equal(valuesFor(draft).episodeTitle, 'Edited second episode');
});

function dialogHarness({ build, save = true, preferences, artists = [] } = {}) {
  const listeners = {}, workspace = { exports: [], artists, preferences: { exportDefaults: preferences } };
  const result = { html: '', commits: 0, downloads: [], allowSave: save, closeCalls: 0, visible: false, builds: [] };
  const modal = { classList: { add() {} }, querySelector() { return {}; }, contains() { return true; } };
  const host = { closest() { return modal; }, querySelectorAll() { return []; }, contains() { return true; } };
  globalThis.document = {
    addEventListener(name, listener) { (listeners[name] ||= []).push(listener); },
    querySelector() { return result.visible ? host : null; },
  };
  globalThis.JSZip = require('../public/vendor/jszip.min.js');
  domainContext.TextEncoder = TextEncoder;
  vm.runInContext(source.slice(source.indexOf('/* export-filenames.js */'), source.indexOf('/* amishna.prototype.js */')), domainContext);
  globalThis.CueExportFilename = domainContext.CueExportFilename;
  globalThis.CueExports = {
    mappings: Object.fromEntries(['IPRS', 'PRS', 'ASCAP'].map(society => [society, { version: 'test' }])),
    async buildFormatted(society, project, episode, cues, works, artists, options) {
      result.builds.push({ society, project, episode, cues, works, artists, options });
      return build ? build(society, project, episode, cues, works, artists, options) : new Uint8Array([1, 2, 3]);
    },
    async buildEpisodesFormatted(society, outputs, artists, options) {
      if (build?.episodes) {
        for (const output of outputs) result.builds.push({ society, ...output, artists, options });
        return build.episodes(society, outputs, artists, options);
      }
      for (const output of outputs) await this.buildFormatted(society, output.project, output.episode, output.cues, output.works, artists, options);
      return new Uint8Array([1, 2, 3]);
    },
  };
  const dialog = createCueExportDialog({
    modal(html) { result.html = html; result.visible = true; }, modalHead: title => title,
    close(force) { assert.equal(force, true); result.visible = false; result.closeCalls++; }, toast() {},
    commit(message, change) { result.commits++; if (!result.allowSave) return false; change(workspace); return true; },
    download(binary, filename, mime) { result.downloads.push({ binary, filename, mime }); },
    state: () => workspace,
  });
  const event = target => ({ target, preventDefault() {}, stopImmediatePropagation() {} });
  result.submit = () => listeners.submit.forEach(listener => listener(event({ dataset: { cueExportForm: '1' } })));
  result.clickFormat = society => {
    const button = { dataset: { cedFormat: society } };
    const target = { closest: selector => selector === '[data-ced-format]' ? button : null };
    listeners.click.forEach(listener => listener(event(target)));
  };
  result.changeScope = value => listeners.change.forEach(listener => listener(event({ value, matches: selector => selector === '[data-ced-scope]' })));
  result.changeRange = (bound, value) => listeners.change.forEach(listener => listener(event({ value: String(value), dataset: { cedRange: bound }, matches: selector => selector === '[data-ced-range]' })));
  result.changeEpisode = value => listeners.change.forEach(listener => listener(event({ value: String(value), matches: selector => selector === '[data-ced-source]' })));
  result.dialog = dialog;
  result.workspace = workspace;
  return result;
}

async function until(check) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('Dialog did not finish the expected operation');
}

test('dialog opens directly with format download buttons and no content type or production inputs', () => {
  const harness = dialogHarness();
  harness.dialog.open(sourceOptions());
  for (const society of ['IPRS', 'PRS', 'ASCAP']) assert.match(harness.html, new RegExp('data-ced-format="' + society + '"'));
  assert.match(harness.html, /Original Serial/);
  assert.match(harness.html, /Episode 02/);
  assert.match(harness.html, /production details saved in your project/);
  assert.doesNotMatch(harness.html, /data-ced-type|data-ced-field|name="contentType"|name="title"|Content type|Details &amp; formats/);
  assert.equal(harness.builds.length, 0);
  assert.equal(harness.downloads.length, 0);
});

for (const society of ['IPRS', 'PRS', 'ASCAP']) {
  test(society + ' button downloads one file using the saved episode and production metadata', async () => {
    const harness = dialogHarness(), input = sourceOptions(), before = structuredClone(input);
    harness.dialog.open(input);
    harness.clickFormat(society);
    await until(() => harness.downloads.length === 1);
    assert.equal(harness.builds.length, 1);
    const build = harness.builds[0];
    assert.equal(build.society, society);
    assert.equal(build.episode, 2);
    assert.equal(build.project.type, 'Series');
    assert.equal(build.project.title, 'Original Serial');
    assert.equal(build.project.language, 'Marathi');
    assert.equal(build.project.year, 2025);
    assert.equal(build.project.duration, '00:30:00');
    assert.equal(build.project.airdate, '2 Apr 2025');
    assert.equal(build.project.episodes[0].title, 'Second');
    assert.equal(build.project.periods[0].director, 'Second Director');
    assert.equal(build.project.periods[0].company, 'Studio Two');
    assert.equal(build.project.ascap.address, 'Office');
    assert.deepEqual(build.cues, input.cues);
    const membershipPolicy = ['PRS', 'ASCAP'].includes(society) ? 'as-entered-v1' : 'confirmed-members-v1';
    assert.deepEqual(build.options, { membershipPolicy });
    assert.deepEqual(build.works, globalThis.CueSocieties.scope(input.cues, input.works, society, [], { membershipPolicy }).works);
    assert.equal(harness.commits, 1);
    assert.equal(harness.workspace.exports.length, 1);
    const record = harness.workspace.exports[0];
    assert.equal(record.society, society);
    assert.equal(record.filename, 'Original_Serial_Episode_02_' + society + '.xlsx');
    assert.deepEqual(record.snapshot, { project: build.project, cues: build.cues, works: globalThis.CueSocieties.freezeWorks(input.works), membershipPolicy });
    assert.notEqual(record.snapshot.project, build.project);
    assert.notEqual(record.snapshot.cues, build.cues);
    assert.notEqual(record.snapshot.works, build.works);
    assert.equal(harness.downloads[0].filename, record.filename);
    assert.equal(harness.downloads[0].mime, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.deepEqual(input, before);
    await until(() => harness.closeCalls === 1);
  });
}

test('saved movie downloads directly with its production details and no episode suffix', async () => {
  const harness = dialogHarness(), input = sourceOptions();
  input.project = {
    ...input.project, title: 'Saved Movie', type: 'Movie', episodes: [],
    duration: '02:01:00', airdate: '3 May 2025', productionNo: 'Censor-123',
  };
  input.episode = null;
  input.cues = input.cues.map(cue => ({ ...cue, episode: null }));
  delete input.episodes;
  const before = structuredClone(input);
  harness.dialog.open(input);
  assert.match(harness.html, /Saved Movie/);
  assert.doesNotMatch(harness.html, /data-ced-scope|data-ced-source|data-ced-type|data-ced-field/);
  harness.clickFormat('IPRS');
  await until(() => harness.downloads.length === 1);
  const build = harness.builds[0];
  assert.equal(build.project.type, 'Movie');
  assert.equal(build.project.duration, '02:01:00');
  assert.equal(build.project.airdate, '3 May 2025');
  assert.equal(build.project.productionNo, 'Censor-123');
  assert.equal(build.project.periods[0].director, 'First Director');
  assert.deepEqual(build.project.episodes, []);
  assert.equal(build.episode, null);
  assert.equal(harness.downloads[0].filename, 'Saved_Movie_IPRS.xlsx');
  assert.deepEqual(input, before);
});

test('one submit generates every format before one commit and downloads a ZIP with immutable snapshots', async () => {
  const harness = dialogHarness(), input = sourceOptions(), before = structuredClone(input);
  harness.dialog.open(input);
  harness.submit();
  await until(() => harness.downloads.length === 1);
  assert.equal(harness.builds.length, 3);
  assert.equal(harness.commits, 1);
  assert.equal(harness.workspace.exports.length, 3);
  assert.equal(harness.downloads[0].filename, 'Original_Serial_Episode_02.zip');
  assert.equal(harness.downloads[0].mime, 'application/zip');
  const zip = await globalThis.JSZip.loadAsync(harness.downloads[0].binary);
  assert.deepEqual(Object.keys(zip.files).sort(), ['Original_Serial_Episode_02_ASCAP.xlsx', 'Original_Serial_Episode_02_IPRS.xlsx', 'Original_Serial_Episode_02_PRS.xlsx']);
  assert.deepEqual(input, before);
  assert.equal(harness.workspace.exports[0].snapshot.cues[0].usagePercent, 33.3);
  await until(() => harness.closeCalls === 1);
});

test('save failure retains saved source details and allows retry without partial downloads or history', async () => {
  const harness = dialogHarness({ save: false }), input = sourceOptions(), before = structuredClone(input);
  harness.dialog.open(input);
  harness.submit();
  await until(() => harness.html.includes('Export history could not be saved'));
  assert.equal(harness.downloads.length, 0);
  assert.equal(harness.workspace.exports.length, 0);
  assert.match(harness.html, /Original Serial/);
  assert.match(harness.html, /Episode 02/);
  assert.deepEqual(input, before);
  assert.equal(harness.closeCalls, 0);
  harness.allowSave = true;
  harness.submit();
  await until(() => harness.downloads.length === 1);
  assert.equal(harness.workspace.exports.length, 3);
  assert.equal(harness.downloads[0].filename, 'Original_Serial_Episode_02.zip');
  assert.equal(harness.commits, 2);
  assert.ok(harness.builds.every(build => build.project.title === 'Original Serial' && build.project.periods[0].director === 'Second Director'));
  assert.deepEqual(input, before);
});

test('range controls update preview and limit the downloaded files and saved history', async () => {
  const harness = dialogHarness();
  harness.dialog.open(sourceOptions());
  harness.changeScope('range');
  assert.match(harness.html, /From episode/);
  assert.match(harness.html, /To episode/);
  harness.changeRange('From', 2);
  harness.changeRange('To', 2);
  assert.match(harness.html, /<strong>1<\/strong>/);
  harness.clickFormat('PRS');
  await until(() => harness.downloads.length === 1);
  assert.deepEqual(harness.builds.map(build => build.episode), [2]);
  assert.equal(harness.workspace.exports.length, 1);
  assert.equal(harness.downloads[0].filename, 'Original_Serial_Episode_02_PRS.xlsx');
});

test('episode selection downloads that saved episode; all scope preserves each episode production period', async () => {
  const first = dialogHarness();
  first.dialog.open(sourceOptions());
  first.changeEpisode(0);
  first.clickFormat('PRS');
  await until(() => first.downloads.length === 1);
  assert.equal(first.downloads[0].filename, 'Original_Serial_Episode_01_PRS.xlsx');
  assert.equal(first.builds[0].project.periods[0].director, 'First Director');
  assert.equal(first.builds[0].project.duration, '00:25:00');
  const range = dialogHarness();
  range.dialog.open(sourceOptions());
  range.changeScope('all');
  range.clickFormat('IPRS');
  await until(() => range.downloads.length === 1);
  assert.deepEqual(range.builds.map(build => build.episode), [1, 2]);
  assert.deepEqual(range.builds.map(build => build.project.periods[0].director), ['First Director', 'Second Director']);
  assert.deepEqual(range.builds.map(build => build.project.airdate), ['1 Apr 2025', '2 Apr 2025']);
  assert.deepEqual(range.builds.map(build => build.project.duration), ['00:25:00', '00:30:00']);
  assert.equal(range.workspace.exports.length, 1);
  assert.equal(range.downloads[0].filename, 'Original_Serial_Episodes_01-02_IPRS.xlsx');
  assert.deepEqual(range.workspace.exports[0].episodes, [1, 2]);
  assert.equal(range.workspace.exports[0].snapshot.episodes.length, 2);
});

test('dismissing the dialog externally during generation prevents later commit and download', async () => {
  let finish;
  const harness = dialogHarness({ build: () => new Promise(resolve => { finish = resolve; }) });
  harness.dialog.open(sourceOptions());
  harness.submit();
  assert.equal(harness.builds.length, 1);
  harness.visible = false;
  finish(new Uint8Array([1]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.commits, 0);
  assert.equal(harness.downloads.length, 0);
  assert.equal(harness.visible, false);
});

test('format generation failure creates no partial export records', async () => {
  const harness = dialogHarness({ build: society => { if (society === 'PRS') throw new Error('Template unavailable'); return new Uint8Array([1]); } });
  harness.dialog.open(sourceOptions());
  harness.submit();
  await until(() => harness.html.includes('Template unavailable'));
  assert.equal(harness.commits, 0);
  assert.equal(harness.workspace.exports.length, 0);
  assert.equal(harness.downloads.length, 0);
  assert.equal(harness.visible, true);
});

test('preview and saved export history match society-scoped rows while retaining original ownership', async () => {
  const input = sourceOptions();
  input.works[0].parties = [
    { name: 'IPRS Member', role: 'Composer', share: 25, society: 'IPRS' },
    { name: 'Dual Member', role: 'Publisher', share: 25, society: 'IPRS/PRS' },
    { name: 'PRS Member', role: 'Lyricist', share: 50, society: 'PRS' },
  ];
  input.works.push({ id: 'W2', title: 'PRS Only Song', parties: [{ name: 'PRS Member', role: 'Composer', society: 'PRS', share: 100 }] });
  const extra = { ...input.cues[0], id: 'C3', workId: 'W2' };
  input.cues.push(extra);
  input.episodes[1].cues = input.cues;
  const before = structuredClone(input), harness = dialogHarness();
  harness.dialog.open(input);
  assert.match(harness.html, /PRS and ASCAP include all selected cues and contributors/);
  assert.match(harness.html, /IPRS includes its members and contributors marked Non-society/);
  harness.clickFormat('IPRS');
  await until(() => harness.downloads.length === 1);
  assert.equal(harness.builds[0].cues.length, 1);
  assert.deepEqual(harness.builds[0].works[0].parties.map(party => [party.name, party.share, party.society]), [['IPRS Member', 25, 'IPRS'], ['Dual Member', 25, 'IPRS']]);
  const record = harness.workspace.exports[0];
  assert.equal(record.count, 1);
  assert.equal(record.snapshot.cues.length, 1);
  assert.equal(record.snapshot.works.length, 1);
  assert.equal(record.snapshot.works[0].parties.reduce((total, party) => total + party.share, 0), 100);
  assert.deepEqual(record.snapshot.works[0].parties[1]._exportMemberships, ['IPRS', 'PRS']);
  assert.equal(record.membershipSummary.excludedCues, 1);
  assert.deepEqual(input, before);
});

test('default format preferences control generation and separate-file behavior uses one saved batch', async () => {
  const defaults = dialogHarness({ preferences: { formats: ['PRS'], downloadBehavior: 'zip' } });
  defaults.dialog.open(sourceOptions());
  defaults.submit();
  await until(() => defaults.downloads.length === 1);
  assert.deepEqual(defaults.builds.map(build => build.society), ['PRS']);
  assert.equal(defaults.downloads[0].filename, 'Original_Serial_Episode_02_PRS.xlsx');
  const separate = dialogHarness({ preferences: { formats: ['IPRS', 'PRS'], downloadBehavior: 'files' } });
  separate.dialog.open(sourceOptions());
  separate.submit();
  await until(() => separate.downloads.length === 2);
  assert.equal(separate.commits, 1);
  assert.equal(separate.workspace.exports.length, 2);
  assert.ok(separate.downloads.every(download => download.filename.endsWith('.xlsx')));
});

function iprsPrsOnlyOptions() {
  const input = sourceOptions();
  input.works[0].parties = [
    { name: 'IPRS Composer', role: 'Composer', share: 25, society: 'IPRS' },
    { name: 'PRS Author', role: 'Lyricist', share: 25, society: 'PRS' },
    { name: 'Dual Publisher', role: 'Publisher', share: 50, society: 'IPRS/PRS' },
  ];
  return input;
}

function actualWorkbookBuilder() {
  const context = { Buffer, Uint8Array, XLSX: require('../public/vendor/xlsx.full.min.js'), JSZip: require('../public/vendor/jszip.min.js') };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(readFileSync(join(__dirname, '../public/societies.js'), 'utf8'), context);
  vm.runInContext(source.slice(0, source.indexOf('/* iprs.js */')), context);
  const build = (...args) => context.CueExports.buildFormatted(...args);
  build.episodes = (...args) => context.CueExports.buildEpisodesFormatted(...args);
  return build;
}

for (const mode of ['single', 'movie-zip', 'episodes-zip', 'episodes-files']) {
  test(`real ${mode} exports apply IPRS row cleanup and preserve saved affiliation text in PRS and ASCAP`, async () => {
    const input = sourceOptions();
    input.works = Array.from({ length: 24 }, (_, index) => ({
      id: 'W' + index, title: 'Track ' + index, isrc: 'IN00000000' + String(index).padStart(2, '0'),
      parties: [
        { name: 'Composer ' + index, role: 'Composer', society: 'IPRS/PRS/ASCAP', share: 50, ipi: '000123' },
        { name: 'Independent ' + index, role: 'Publisher', society: ['Non Member', 'non-member', 'nonmember'][index % 3], share: 50, ipi: '' },
      ],
    }));
    input.episodes.forEach((entry, index) => {
      entry.cues = input.works.slice(0, index ? 24 : 1).map((work, cueIndex) => ({
        id: `C${index}-${cueIndex}`, projectId: 'P1', workId: work.id, episode: entry.episode,
        duration: 60 + cueIndex, usage: 'FV', usagePercent: 33.3,
      }));
    });
    input.cues = input.episodes[1].cues;
    if (mode === 'movie-zip') {
      input.project.type = 'Movie'; input.project.episodes = []; input.episode = null;
      input.cues = input.cues.map(cue => ({ ...cue, episode: null })); delete input.episodes;
    }
    const before = structuredClone(input);
    const harness = dialogHarness({ build: actualWorkbookBuilder(), preferences: { formats: ['IPRS', 'PRS', 'ASCAP'], downloadBehavior: mode === 'episodes-files' ? 'files' : 'zip' } });
    harness.dialog.open(input);
    if (mode.startsWith('episodes-')) harness.changeScope('all');
    if (mode === 'single') harness.clickFormat('IPRS'); else harness.submit();
    const expected = mode === 'episodes-files' ? 3 : 1;
    await until(() => harness.downloads.length === expected);
    const files = [];
    for (const download of harness.downloads) {
      if (download.filename.endsWith('.zip')) {
        const zip = await globalThis.JSZip.loadAsync(download.binary);
        for (const file of Object.values(zip.files)) if (!file.dir) files.push({ name: file.name, bytes: await file.async('uint8array') });
      } else files.push({ name: download.filename, bytes: download.binary });
    }
    assert.equal(files.length, mode === 'single' ? 1 : 3);
    const XLSX = require('../public/vendor/xlsx.full.min.js');
    for (const { name, bytes } of files) {
      const society = name.match(/_(IPRS|PRS|ASCAP)\.xlsx$/)[1];
      const workbook = XLSX.read(bytes, { type: 'array' });
      assert.equal(workbook.SheetNames.length, mode.startsWith('episodes-') ? 2 : 1);
      const zip = await globalThis.JSZip.loadAsync(bytes);
      for (const [sheetIndex, sheetName] of workbook.SheetNames.entries()) {
        const count = sheetName === 'Episode_01' ? 1 : 24;
        const sheet = workbook.Sheets[sheetName], xml = await zip.file(`xl/worksheets/sheet${sheetIndex + 1}.xml`).async('string');
        if (society === 'IPRS') {
          const start = mode === 'movie-zip' ? 13 : 16;
          for (let index = 0; index < count; index++) {
            const row = start + index * 3;
            assert.equal(sheet['A' + row].v, 'Track ' + index);
            assert.equal(sheet['I' + (row + 1)].v, 'NS');
            assert.equal(sheet['J' + (row + 1)].v, '50%');
            assert.ok(!sheet['K' + (row + 1)]?.v);
          }
          const codes = start + count * 3;
          assert.equal(sheet['A' + codes].v, 'Codes:', name);
          assert.match(xml, new RegExp(`<row r="${codes - 1}" ht="15.75" customHeight="1"\\s*/>`), 'Exactly one visible empty row precedes Codes');
          assert.ok((sheet['!merges'] || []).some(merge => merge.s.r === codes + 4), 'Footer note merge moves with Codes');
        } else if (society === 'PRS') {
          assert.equal(XLSX.utils.decode_range(sheet['!ref']).e.r + 1, 20 + count * 2, 'PRS used range ends at the footer');
          assert.match(xml, new RegExp(`<row r="${19 + count * 2}"\\s*/>`), 'PRS has one plain gap above its footer');
          for (let index = 0; index < count; index++) {
            assert.equal(sheet['E' + (20 + index * 2)].v, 'Independent ' + index);
            assert.equal(sheet['I' + (20 + index * 2)].v, 'Non Member');
            assert.equal(sheet['H' + (20 + index * 2)].v, 0.5);
          }
        } else {
          assert.equal(XLSX.utils.decode_range(sheet['!ref']).e.r + 1, 15 + count, 'ASCAP used range ends at the footer');
          assert.match(xml, new RegExp(`<row r="${10 + count}"\\s*/>`), 'ASCAP has one plain gap above its code legend');
          assert.match(sheet['A' + (11 + count)].v, /Use Codes:/, 'ASCAP codes immediately follow the gap');
          for (let index = 0; index < count; index++) assert.equal(sheet['F' + (10 + index)].v, `Independent ${index} (Non Member) 100%`);
        }
        const rowNumbers = [...xml.matchAll(/<row\b[^>]*\br="(\d+)"/g)].map(match => Number(match[1]));
        assert.deepEqual(rowNumbers, [...new Set(rowNumbers)].sort((a, b) => a - b), name + ': valid ordered rows');
      }
    }
    assert.equal(harness.commits, 1);
    assert.deepEqual(input, before, 'Bulk export preserves source edits');
  });
}

for (const combined of [false, true]) test(`ASCAP is enabled without ASCAP members and downloads ${combined ? 'alongside IPRS and PRS in a real ZIP' : 'a real workbook'} with recorded affiliations`, async () => {
  const input = iprsPrsOnlyOptions(), before = structuredClone(input);
  const harness = dialogHarness({ build: actualWorkbookBuilder() });
  harness.dialog.open(input);
  const button = harness.html.match(/<button\b[^>]*data-ced-format="ASCAP"[^>]*>/)?.[0];
  assert.ok(button);
  assert.doesNotMatch(button, /\bdisabled\b/);
  assert.match(harness.html, /PRS and ASCAP include all selected cues and contributors/);
  if (combined) harness.submit(); else harness.clickFormat('ASCAP');
  await until(() => harness.downloads.length === 1);
  let bytes = harness.downloads[0].binary;
  if (combined) {
    const zip = await globalThis.JSZip.loadAsync(bytes);
    assert.deepEqual(Object.keys(zip.files).sort(), ['Original_Serial_Episode_02_ASCAP.xlsx', 'Original_Serial_Episode_02_IPRS.xlsx', 'Original_Serial_Episode_02_PRS.xlsx']);
    bytes = await zip.file('Original_Serial_Episode_02_ASCAP.xlsx').async('uint8array');
  }
  const XLSX = require('../public/vendor/xlsx.full.min.js'), sheet = XLSX.read(bytes, { type: 'array' }).Sheets.ASCAP;
  assert.equal(sheet.B10.v, 'Song');
  assert.equal(sheet.E10.v, 'IPRS Composer (IPRS) 50%\nPRS Author (PRS) 50%');
  assert.equal(sheet.F10.v, 'Dual Publisher (IPRS/PRS) 100%');
  assert.equal(sheet.D10.v, 90 / 86400);
  const record = harness.workspace.exports.find(record => record.society === 'ASCAP');
  assert.equal(record.snapshot.membershipPolicy, 'as-entered-v1');
  assert.equal(record.membershipSummary.ASCAP.artists, 0);
  assert.equal(record.membershipSummary.includedCues, 1);
  assert.deepEqual(record.snapshot.works[0].parties.map(p => [p.name, p.share, p.society]), input.works[0].parties.map(p => [p.name, p.share, p.society]));
  assert.deepEqual(input, before);
});

test('ASCAP without member affiliations remains available across episodes and downloads every episode', async () => {
  const input = iprsPrsOnlyOptions(), harness = dialogHarness({ build: actualWorkbookBuilder() });
  harness.dialog.open(input);
  harness.changeEpisode(0);
  assert.doesNotMatch(harness.html.match(/<button\b[^>]*data-ced-format="ASCAP"[^>]*>/)[0], /\bdisabled\b/);
  harness.changeScope('all');
  harness.clickFormat('ASCAP');
  await until(() => harness.downloads.length === 1);
  assert.equal(harness.downloads[0].filename, 'Original_Serial_Episodes_01-02_ASCAP.xlsx');
  const XLSX = require('../public/vendor/xlsx.full.min.js');
  const workbook = XLSX.read(harness.downloads[0].binary, { type: 'array' });
  assert.deepEqual(workbook.SheetNames, ['Episode_01', 'Episode_02']);
  assert.equal(workbook.Sheets.Episode_01.D10.v, 60 / 86400);
  assert.equal(workbook.Sheets.Episode_02.D10.v, 90 / 86400);
  assert.deepEqual(harness.builds.map(build => build.cues[0].duration), [60, 90]);
});

test('saved ASCAP snapshots retain their original confirmed-member export policy', () => {
  const harness = dialogHarness(), input = iprsPrsOnlyOptions();
  harness.dialog.open({ ...input, membershipPolicy: 'confirmed-members-v1' });
  assert.match(harness.html.match(/<button\b[^>]*data-ced-format="ASCAP"[^>]*>/)[0], /\bdisabled\b/);
  assert.match(harness.html, /saved PRS \/ ASCAP export uses its original membership filtering/);
});

for (const society of ['PRS', 'ASCAP']) test(society + ' downloads without local society members, exports NS as Non Member, and preserves raw NS in its snapshot', async () => {
  const input = sourceOptions();
  input.works[0].parties = [
    { name: 'Test IPRS Composer', role: 'Composer', society: 'IPRS', ipi: '0000000123', share: 50 },
    { name: 'Test Publisher', role: 'Publisher', society: 'NS', ipi: '', share: 50 },
  ];
  const before = structuredClone(input), harness = dialogHarness({ build: actualWorkbookBuilder() });
  harness.dialog.open(input);
  assert.doesNotMatch(harness.html.match(new RegExp('<button\\b[^>]*data-ced-format="' + society + '"[^>]*>'))[0], /\bdisabled\b/);
  harness.clickFormat(society);
  await until(() => harness.downloads.length === 1);
  const XLSX = require('../public/vendor/xlsx.full.min.js');
  const workbook = XLSX.read(harness.downloads[0].binary, { type: 'array' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (society === 'PRS') {
    assert.equal(sheet.E19.v, 'Test IPRS Composer');
    assert.equal(sheet.I19.v, 'IPRS');
    assert.equal(sheet.G19.v, '0000000123');
    assert.equal(sheet.H19.v, 0.5);
    assert.equal(sheet.E20.v, 'Test Publisher');
    assert.equal(sheet.I20.v, 'Non Member');
    assert.ok(!sheet.G20?.v);
    assert.equal(sheet.H20.v, 0.5);
  } else {
    assert.equal(sheet.E10.v, 'Test IPRS Composer (IPRS) 100%');
    assert.equal(sheet.F10.v, 'Test Publisher (Non Member) 100%');
  }
  assert.equal(harness.workspace.exports[0].snapshot.membershipPolicy, 'as-entered-v1');
  assert.deepEqual(harness.workspace.exports[0].snapshot.works[0].parties.map(party => [party.name, party.society, party.share]), [
    ['Test IPRS Composer', 'IPRS', 50], ['Test Publisher', 'NS', 50],
  ]);
  assert.deepEqual(input, before);
});

test('PRS download remains enabled for IPRS-only contributors', async () => {
  const input = sourceOptions(), harness = dialogHarness({ build: actualWorkbookBuilder() });
  input.works[0].parties = [{ name: 'IPRS Writer', role: 'Composer', society: 'IPRS', ipi: '', share: 100 }];
  harness.dialog.open(input);
  assert.doesNotMatch(harness.html.match(/<button\b[^>]*data-ced-format="PRS"[^>]*>/)[0], /\bdisabled\b/);
  harness.clickFormat('PRS');
  await until(() => harness.downloads.length === 1);
  assert.equal(harness.workspace.exports[0].society, 'PRS');
  assert.equal(harness.builds[0].works[0].parties[0].society, 'IPRS');
});

test('ASCAP cannot download an empty project', () => {
  const harness = dialogHarness();
  harness.dialog.open({ project: { title: 'Empty', type: 'Movie' }, cues: [], works: [] });
  assert.match(harness.html.match(/<button\b[^>]*data-ced-format="ASCAP"[^>]*>/)[0], /\bdisabled\b/);
});

for (const society of ['PRS', 'ASCAP']) test(society + ' exports a selected cue with no contributor metadata instead of blocking or omitting it', async () => {
  const input = sourceOptions();
  input.works[0].parties = [];
  const before = structuredClone(input), harness = dialogHarness({ build: actualWorkbookBuilder() });
  harness.dialog.open(input);
  assert.match(harness.html, /missing contributor details stay blank/);
  assert.doesNotMatch(harness.html, /PRS artists:|ASCAP artists:/);
  harness.clickFormat(society);
  await until(() => harness.downloads.length === 1 || harness.html.includes('Check these details') || harness.html.includes('Export could not be completed'));
  assert.equal(harness.downloads.length, 1, harness.html);
  const XLSX = require('../public/vendor/xlsx.full.min.js');
  const workbook = XLSX.read(harness.downloads[0].binary, { type: 'array' }), sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (society === 'PRS') {
    assert.equal(sheet.B19.v, 'Song');
    assert.equal(sheet.K19.v, '00:01:30');
    for (const column of ['D', 'E', 'G', 'H', 'I']) assert.ok(!sheet[column + '19']?.v);
  } else {
    assert.equal(sheet.B10.v, 'Song');
    assert.equal(sheet.D10.v, 90 / 86400);
    assert.ok(!sheet.E10?.v);
    assert.ok(!sheet.F10?.v);
  }
  const record = harness.workspace.exports[0];
  assert.equal(record.count, 1);
  assert.equal(record.snapshot.membershipPolicy, 'as-entered-v1');
  assert.deepEqual(record.snapshot.works[0].parties, []);
  assert.deepEqual(input, before);
});

for (const society of ['PRS', 'ASCAP']) test(society + ' copies arbitrary saved societies and unknown contributor roles while leaving missing shares blank', async () => {
  const input = sourceOptions();
  input.works[0].parties = [
    { name: 'GEMA Composer', role: 'Composer', society: 'GEMA', ipi: '0000123', share: null },
    { name: 'Custom Role Writer', role: 'Arranger', society: 'bMaI; GEMA & other', ipi: '0000456', share: 25 },
    { name: 'Mixed Writer', role: 'Lyricist', society: 'prs, IPRS / ASCAP', share: 0 },
    { name: 'Independent Publisher', role: 'Publisher', society: 'Non-society', share: '' },
    { name: 'Blank Society Writer', role: 'Composer', society: '', artistId: 'stale', share: null },
  ];
  input.artists = [{ id: 'stale', name: 'Blank Society Writer', societies: ['IPRS'] }];
  const before = structuredClone(input), harness = dialogHarness({ build: actualWorkbookBuilder() });
  harness.dialog.open(input);
  harness.clickFormat(society);
  await until(() => harness.downloads.length === 1 || harness.html.includes('Check these details') || harness.html.includes('Export could not be completed'));
  assert.equal(harness.downloads.length, 1, harness.html);
  const XLSX = require('../public/vendor/xlsx.full.min.js');
  const workbook = XLSX.read(harness.downloads[0].binary, { type: 'array' }), sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (society === 'PRS') {
    input.works[0].parties.forEach((party, index) => {
      const row = 19 + index;
      assert.equal(sheet['E' + row].v, party.name);
      assert.equal(sheet['I' + row]?.v || '', party.name === 'Independent Publisher' ? 'Non Member' : party.society);
      if (party.share === null || party.share === '') assert.ok(!sheet['H' + row]?.v);
      else assert.equal(sheet['H' + row].v, party.share / 100);
    });
    assert.equal(sheet.G19.v, '0000123');
  } else {
    assert.equal(sheet.E10.v, 'GEMA Composer (GEMA)\nCustom Role Writer (bMaI; GEMA & other) 50%\nMixed Writer (prs, IPRS / ASCAP) 0%\nBlank Society Writer');
    assert.equal(sheet.F10.v, 'Independent Publisher (Non Member)');
  }
  assert.equal(harness.workspace.exports[0].count, 1);
  assert.deepEqual(harness.workspace.exports[0].snapshot.works[0].parties.map(party => [party.name, party.share, party.society]), input.works[0].parties.map(party => [party.name, party.share, party.society]));
  assert.deepEqual(input, before);
});

test('IPRS keeps ownership validation when PRS and ASCAP allow incomplete saved contributors', async () => {
  const input = sourceOptions(), harness = dialogHarness();
  input.works[0].parties = [{ name: 'IPRS Composer', role: 'Composer', society: 'IPRS', share: null }];
  const before = structuredClone(input);
  harness.dialog.open(input);
  harness.clickFormat('IPRS');
  await until(() => harness.html.includes('every contributor needs a name and share'));
  assert.equal(harness.builds.length, 0);
  assert.equal(harness.downloads.length, 0);
  assert.deepEqual(input, before);
});

for (const society of ['PRS', 'ASCAP']) for (const membershipPolicy of ['recorded-affiliations-v1', 'confirmed-members-v1']) test('saved ' + society + ' export keeps ' + membershipPolicy + ' on regeneration', async () => {
  const input = sourceOptions(), before = structuredClone(input), harness = dialogHarness({ build: actualWorkbookBuilder() });
  harness.dialog.open({ ...input, membershipPolicy });
  harness.clickFormat(society);
  await until(() => harness.downloads.length === 1 || harness.html.includes('Check these details') || harness.html.includes('Export could not be completed'));
  assert.equal(harness.downloads.length, 1, harness.html);
  assert.equal(harness.builds[0].options.membershipPolicy, membershipPolicy);
  assert.equal(harness.workspace.exports[0].snapshot.membershipPolicy, membershipPolicy);
  assert.deepEqual(input, before);
});

for (const society of ['IPRS', 'PRS', 'ASCAP']) test(society + ' range keeps sparse episodes, metadata and formatting separate and regenerates every saved tab', async () => {
  const input = sourceOptions(), build = actualWorkbookBuilder();
  input.project.episodes.push({ number: 5, title: 'Fifth', duration: '00:40:00', airdate: '5 Apr 2025' });
  input.project.periods[1].to = 4;
  input.project.periods.push({ from: 5, to: 5, director: 'Fifth Director', company: 'Studio Five', cast: 'Cast Five' });
  input.works.push({ ...structuredClone(input.works[0]), id: 'W5', title: '=Episode five song' });
  input.episodes.unshift({ episode: 5, cues: [{ ...input.cues[0], id: 'C5', workId: 'W5', episode: 5, duration: 125 }] });
  const before = structuredClone(input), harness = dialogHarness({ build });
  harness.dialog.open(input);
  harness.changeScope('range');
  harness.changeRange('From', 2);
  harness.changeRange('To', 5);
  assert.match(harness.html, /separate sheet for each episode/);
  harness.clickFormat(society);
  await until(() => harness.downloads.length === 1);
  const XLSX = require('../public/vendor/xlsx.full.min.js');
  const bytes = harness.downloads[0].binary, workbook = XLSX.read(bytes, { type: 'array' });
  assert.deepEqual(workbook.SheetNames, ['Episode_02', 'Episode_05']);
  assert.deepEqual(harness.builds.map(item => item.episode), [2, 5]);
  assert.deepEqual(harness.builds.map(item => item.project.periods[0].director), ['Second Director', 'Fifth Director']);
  const zip = await globalThis.JSZip.loadAsync(bytes), styles = await zip.file('xl/styles.xml').async('string');
  const styleCount = Number(styles.match(/<cellXfs\b[^>]*\bcount="(\d+)"/)[1]);
  for (const [index, prepared] of harness.builds.entries()) {
    const xml = await zip.file(`xl/worksheets/sheet${index + 1}.xml`).async('string');
    const single = await globalThis.JSZip.loadAsync(await build(society, prepared.project, prepared.episode, prepared.cues, prepared.works, prepared.artists, prepared.options));
    const singleXml = await single.file('xl/worksheets/sheet1.xml').async('string');
    const comparable = value => value.replace(/\bs="\d+"/g, '').replace(/tabSelected="[01]"/g, 'tabSelected="1"');
    assert.equal(comparable(xml), comparable(singleXml), 'Every tab retains the complete individual society sheet layout and data');
    assert.ok([...xml.matchAll(/\bs="(\d+)"/g)].every(match => Number(match[1]) < styleCount), 'All style references remain valid across tabs');
    assert.match(xml, new RegExp('tabSelected="' + (index === 0 ? 1 : 0) + '"'), 'Only the first tab is selected');
    assert.equal(await zip.file('xl/sharedStrings.xml').async('string'), await single.file('xl/sharedStrings.xml').async('string'));
  }
  const second = workbook.Sheets.Episode_02, fifth = workbook.Sheets.Episode_05;
  if (society === 'IPRS') {
    assert.equal(second.B11.v, '2'); assert.equal(fifth.B11.v, '5');
    assert.equal(second.H4.v, 'Second Director'); assert.equal(fifth.H4.v, 'Fifth Director');
    assert.equal(second.H7.v, '00:30:00'); assert.equal(fifth.H7.v, '00:40:00');
  } else if (society === 'PRS') {
    assert.equal(second.C11.v, '2'); assert.equal(fifth.C11.v, '5');
    assert.equal(second.C9.v, 'Second'); assert.equal(fifth.C9.v, 'Fifth');
    assert.equal(second.J11.v, '2 Apr 2025'); assert.equal(fifth.J11.v, '5 Apr 2025');
  } else {
    assert.equal(second.A4.v, 'Episode Title/Number: Second / 2'); assert.equal(fifth.A4.v, 'Episode Title/Number: Fifth / 5');
    assert.equal(second.A6.v, 'Program Length: 00:30:00'); assert.equal(fifth.A6.v, 'Program Length: 00:40:00');
    assert.equal(second.D10.v, 90 / 86400); assert.equal(fifth.D10.v, 125 / 86400);
  }
  assert.equal(Object.values(second).filter(cell => cell?.v === '=Episode five song').length, 0);
  assert.equal(Object.values(fifth).filter(cell => cell?.v === '=Episode five song' && !cell.f).length, 1);
  const record = harness.workspace.exports[0];
  assert.equal(harness.workspace.exports.length, 1);
  assert.equal(record.count, 2);
  assert.deepEqual(record.sourceEpisodes, [2, 5]);
  assert.deepEqual(input, before);

  // Exercise the application's actual Download again handler with the saved
  // snapshot, after live source data has changed.
  input.project.title = 'Changed after export';
  input.project.episodes = [];
  let savedOptions;
  const handler = source.slice(source.indexOf('if(d.regenerate){'), source.indexOf('\nif(d.googleSync)'));
  vm.runInNewContext('(function(){' + handler + '})()', {
    d: { regenerate: record.id }, state: harness.workspace,
    ExportDialog: { open(options) { savedOptions = options; } }, toast() { assert.fail('Snapshot should exist'); },
  });
  const restored = dialogHarness({ build });
  restored.dialog.open(savedOptions);
  restored.clickFormat(society);
  await until(() => restored.downloads.length === 1);
  assert.equal(restored.downloads[0].filename, harness.downloads[0].filename);
  const restoredZip = await globalThis.JSZip.loadAsync(restored.downloads[0].binary);
  for (const path of ['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/styles.xml']) {
    assert.equal(await restoredZip.file(path).async('string'), await zip.file(path).async('string'), path + ' regenerates from frozen episode data');
  }
});

test('a later episode failure prevents partial workbook downloads and export history', async () => {
  const harness = dialogHarness({ build: (society, project, episode) => {
    if (episode === 2) throw new Error('Episode two cannot be generated');
    return new Uint8Array([1]);
  } });
  harness.dialog.open(sourceOptions());
  harness.changeScope('range');
  harness.submit();
  await until(() => harness.html.includes('Episode two cannot be generated'));
  assert.equal(harness.commits, 0);
  assert.equal(harness.workspace.exports.length, 0);
  assert.equal(harness.downloads.length, 0);
});


test('range 1-300 downloads three workbooks with 300 separate episode sheets each', async () => {
  const input = sourceOptions();
  input.project.totalEpisodes = 301;
  input.project.episodes = Array.from({ length: 301 }, (_, index) => ({ number: index + 1, title: 'Episode ' + (index + 1), duration: '00:25:00' }));
  input.episodes = input.project.episodes.map(ep => ({ episode: ep.number, cues: [{ ...input.cues[0], id: 'C' + ep.number, episode: ep.number }] }));
  const before = structuredClone(input);
  const harness = dialogHarness({ build: actualWorkbookBuilder(), preferences: { downloadBehavior: 'zip' } });
  harness.dialog.open(input);
  harness.changeScope('range');
  harness.changeRange('From', 1);
  harness.changeRange('To', 300);
  harness.submit();
  await until(() => harness.downloads.length === 3);
  assert.equal(harness.builds.length, 900);
  assert.equal(harness.workspace.exports.length, 3);
  const XLSX = require('../public/vendor/xlsx.full.min.js');
  for (const download of harness.downloads) {
    assert.match(download.filename, /Episodes_01-300_(IPRS|PRS|ASCAP)\.xlsx$/);
    const workbook = XLSX.read(download.binary, { type: 'array' });
    assert.deepEqual(workbook.SheetNames, Array.from({ length: 300 }, (_, index) => 'Episode_' + String(index + 1).padStart(2, '0')));
    const zip = await globalThis.JSZip.loadAsync(download.binary);
    const properties = await zip.file('docProps/app.xml').async('string');
    assert.match(properties, /<vt:i4>300<\/vt:i4>/);
    assert.match(properties, /<vt:vector size="300" baseType="lpstr">/);
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      assert.equal(Object.values(sheet).filter(cell => cell?.v === 'Song').length, 1, sheetName + ' contains only its own cue');
    }
  }
  for (const build of harness.builds) {
    assert.deepEqual(build.cues.map(cue => cue.episode), [build.episode]);
  }
  assert.ok(harness.builds.every(build => build.episode >= 1 && build.episode <= 300));
  for (const record of harness.workspace.exports) {
    assert.equal(record.count, 300);
    assert.deepEqual(record.episodes, Array.from({ length: 300 }, (_, index) => index + 1));
    assert.equal(record.snapshot.episodes.length, 300);
  }
  assert.deepEqual(input, before);
});
