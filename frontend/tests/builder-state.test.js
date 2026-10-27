'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const source = readFileSync(join(__dirname, '../public/dashboard.js'), 'utf8');

function harness() {
  let state = {
    works: [{ id: 'work', title: 'Background Music', artist: 'Singer', isrc: '', iswc: '', tuneCode: '', parties: [{ name: 'Writer', share: 100, role: 'Composer', society: 'IPRS', ipi: '' }], societies: {}, research: {}, alternateTitles: [] }],
    cues: [{ id: 'cue', projectId: 'project', workId: 'work', episode: 1, duration: 60, start: 0, end: 60, usage: 'FV', societyUsage: { IPRS: 'FV', PRS: 'V', ASCAP: 'ET' }, usagePercent: 42.75, notes: '' }],
    projects: [{ id: 'project', type: 'Series', title: 'Serial', episodes: [{ number: 1, title: 'First', duration: '00:30:00' }, { number: 2, title: 'Second', duration: '00:30:00' }], periods: [] }],
    clients: [], members: [], deletedCues: [], activity: [],
  };
  let revision = 0, activeForm = null;
  const listeners = {}, result = { notices: [], saves: 0 };
  const context = { structuredClone, setTimeout, crypto: require('node:crypto').webcrypto, document: {
    createElement() { return { innerHTML: '', content: { querySelectorAll: () => [] } }; },
    addEventListener(name, listener) { (listeners[name] ||= []).push(listener); },
    querySelector(selector) { return selector === '#am-track-form' ? activeForm : null; },
  }, FormData: class {
    constructor(form) { this.values = form.values; }
    get(key) { return this.values[key] ?? null; }
    has(key) { return Object.hasOwn(this.values, key); }
    *[Symbol.iterator]() { yield* Object.entries(this.values); }
  } };
  context.window = context;
  context.addEventListener = () => {};
  vm.createContext(context);
  vm.runInContext(source.slice(0, source.indexOf('/* data.js */')), context);
  vm.runInContext(source.slice(source.indexOf('/* amishna.prototype.js */'), source.indexOf('/* portfolio.js */')), context);
  const api = {
    state: () => state, revision: () => revision,
    replaceState(value) { state = value; revision++; },
    save() { revision++; result.saves++; return true; },
    esc: value => String(value ?? ''), icon: () => '', options: () => '', toast: value => result.notices.push(value), go() {}, render() {}, close() {}, modal() {}, modalHead() {},
  };
  const ui = context.createAmishnaUI(api);
  ui.openProject('project');
  result.ui = ui;
  result.state = () => state;
  result.bump = () => { revision++; };
  result.replace = api.replaceState;
  result.submit = (id, values, occurrenceRows = []) => {
    activeForm = { id, values, classList: { contains: () => true }, querySelectorAll: selector => selector === '[data-am-occurrence]' ? occurrenceRows.map(row => ({ querySelector: name => ({ value: row[name.match(/name="([^"]+)"/)[1]] }) })) : state.works[0].parties.map((party, index) => ({ dataset: { amParty: index }, querySelector: name => ({ value: String(party[name.match(/data-key="([^"]+)"/)[1]] ?? '') }) })) };
    const event = { target: activeForm, preventDefault() {}, stopImmediatePropagation() {} };
    for (const listener of listeners.submit || []) listener(event);
  };
  result.click = action => {
    const control = { dataset: { am: action } };
    const event = { target: { closest: selector => selector.includes('[data-am]') ? control : null }, preventDefault() {}, stopImmediatePropagation() {} };
    for (const listener of listeners.click || []) listener(event);
  };
  return result;
}

test('builder shows saved music usage and saving unrelated edits keeps manual percentages and usage', () => {
  const h = harness(), before = structuredClone(h.state().cues[0]);
  const html = h.ui.builder();
  assert.match(html, /name="usage" value="FV"/);
  assert.match(html, /name="usagePRS"[^>]*value="V"/);
  h.submit('am-track-form', { title: 'Background Music', artist: 'Singer', start: '00:00:00', end: '00:01:00', duration: '00:01:00', source: 'Original', usageCount: '1', notes: 'Updated note' });
  assert.equal(h.saves, 1, h.notices.join('; '));
  assert.equal(h.state().cues[0].notes, 'Updated note');
  assert.equal(h.state().cues[0].usagePercent, 42.75);
  assert.equal(h.state().cues[0].usage, before.usage);
  assert.deepEqual(h.state().cues[0].societyUsage, before.societyUsage);
});

for (const storage of ['tuneCode', 'PRS']) test(`builder opens ${storage}-only identifiers in one PRS field and saves both aliases`, () => {
  const h = harness();
  const work = h.state().works[0];
  if (storage === 'tuneCode') work.tuneCode = '000TEST123AB';
  else work.societies.PRS = '000TEST123AB';
  h.bump(); h.ui.openCue('cue');
  const html = h.ui.builder();
  assert.match(html, /Work ID \/ Tune Code/);
  assert.match(html, /name="idPRS"[^>]*value="000TEST123AB"/);
  assert.doesNotMatch(html, /name="tuneCode"/);
  const beforeUsage = structuredClone(h.state().cues[0].societyUsage);
  h.submit('am-track-form', { title: 'Background Music', artist: 'Singer', start: '00:00:00', end: '00:01:00',
    duration: '00:01:00', source: 'Original', usageCount: '1', notes: '', idIPRS: '', idPRS: '  000928AB  ', idASCAP: '' });
  assert.equal(h.saves, 1, h.notices.join('; '));
  assert.equal(h.state().works[0].tuneCode, '000928AB');
  assert.equal(h.state().works[0].societies.PRS, '000928AB');
  assert.deepEqual(h.state().cues[0].societyUsage, beforeUsage);
  h.submit('am-track-form', { title: 'Background Music', artist: 'Singer', start: '00:00:00', end: '00:01:00',
    duration: '00:01:00', source: 'Original', usageCount: '1', notes: '', idIPRS: '', idPRS: '', idASCAP: '' });
  assert.equal(h.saves, 2, h.notices.join('; '));
  assert.equal(h.state().works[0].tuneCode, '');
  assert.equal(h.state().works[0].societies.PRS, '');
});

test('a partial cue form does not clear an existing PRS identifier when its field is absent', () => {
  const h = harness();
  h.state().works[0].tuneCode = '000TEST123AB';
  h.bump(); h.ui.openCue('cue');
  h.submit('am-track-form', { title: 'Background Music', artist: 'Singer', start: '00:00:00', end: '00:01:00',
    duration: '00:01:00', source: 'Original', usageCount: '1', notes: 'Unrelated correction' });
  assert.equal(h.saves, 1, h.notices.join('; '));
  assert.equal(h.state().works[0].tuneCode, '000TEST123AB');
});

for (const storage of ['tuneCode', 'PRS']) for (const replacement of ['', '000-NEW']) test(`Save as New Record clears owned ${storage}-only identifiers and retains ${replacement ? 'new user-entered codes' : 'the original song'}`, () => {
  const h = harness(), original = h.state().works[0];
  if (storage === 'tuneCode') original.tuneCode = '000TEST123AB';
  else original.societies.PRS = '000TEST123AB';
  const before = structuredClone(original);
  h.bump(); h.ui.openCue('cue');
  h.submit('am-track-form', { title: 'New Song', artist: 'Singer', start: '00:00:00', end: '00:01:00',
    duration: '00:01:00', source: 'Original', usageCount: '1', notes: '', idPRS: replacement || '000TEST123AB' });
  assert.equal(h.saves, 0, 'Renaming waits for the existing/new record choice');
  h.click('title-save-new');
  assert.equal(h.saves, 1, h.notices.join('; '));
  assert.equal(h.state().works.length, 2);
  assert.deepEqual(h.state().works.find(work => work.id === 'work'), before);
  const created = h.state().works.find(work => work.id !== 'work');
  assert.equal(created.title, 'New Song');
  assert.equal(created.tuneCode, replacement);
  assert.equal(created.societies.PRS, replacement);
  assert.equal(h.state().cues[0].workId, created.id);
});

test('builder cached lookups follow revision changes, same-length replacements, and restored state', () => {
  const h = harness();
  assert.match(h.ui.builder(), /Background Music/);
  h.state().works[0] = { ...h.state().works[0], title: 'Renamed Work' };
  h.state().cues[0] = { ...h.state().cues[0], episode: 2 };
  h.bump();
  h.ui.openProject('project');
  assert.match(h.ui.builder(), /0 of 0 cues/);
  h.ui.openCue('cue');
  assert.match(h.ui.builder(), /Renamed Work/);
  assert.match(h.ui.builder(), /1 of 1 cues/);
  const restored = structuredClone(h.state());
  restored.works[0].title = 'Restored Work';
  h.replace(restored);
  assert.match(h.ui.builder(), /Restored Work/);
});

test('episode edits and new episodes receive truthful update timestamps without inventing historic creation dates', () => {
  const h = harness();
  h.submit('am-episode-form', { number: '1', title: 'Changed', airdate: '', duration: '00:30:00' });
  assert.equal(h.state().projects[0].episodes[0].createdAt, undefined);
  assert.ok(Number.isFinite(Date.parse(h.state().projects[0].episodes[0].updatedAt)));
  h.submit('am-add-episode', { number: '3', title: 'New Third', airdate: '', duration: '00:25:00' });
  const added = h.state().projects[0].episodes.find(episode => episode.number === 3);
  assert.ok(Number.isFinite(Date.parse(added.createdAt)));
  assert.ok(Number.isFinite(Date.parse(added.updatedAt)));
});

test('combined cue editor shows both entries and saves recalculated timing', () => {
  const h = harness(), next = structuredClone(h.state());
  next.works[0].title = 'City Dreams';
  Object.assign(next.cues[0], { start: null, end: null, duration: 83, usageCount: 2, occurrences: [
    { title: 'City Dreams', start: 70, end: 134, duration: 64 },
    { title: 'City Dreams', start: 418, end: 437, duration: 19 }
  ] });
  h.replace(next); h.ui.openProject('project');
  const html = h.ui.builder();
  assert.match(html, /Original workfile entries/);
  assert.match(html, /Entry 1 · Track name/);
  assert.match(html, /Entry 2 · Track name/);
  h.submit('am-track-form', { title: 'City Dreams', artist: 'Singer', duration: '00:01:23', source: 'Original', usageCount: '2', notes: '' }, [
    { occurrenceTitle: 'City Dreams', occurrenceStart: '00:01:10', occurrenceEnd: '00:02:14' },
    { occurrenceTitle: 'City Dreams', occurrenceStart: '00:06:58', occurrenceEnd: '00:07:27' }
  ]);
  assert.equal(h.saves, 1, h.notices.join('; '));
  assert.equal(h.state().cues[0].duration, 93);
  assert.equal(h.state().cues[0].usageCount, 2);
  assert.equal(h.state().cues[0].occurrences[1].duration, 29);
  assert.equal(h.state().cues[0].start, null);
  assert.equal(h.state().cues[0].end, null);
});

test('combined cue editor separates entries with different track names on save', () => {
  const h = harness(), next = structuredClone(h.state());
  next.works[0].title = 'City Dreams';
  Object.assign(next.cues[0], { start: null, end: null, duration: 83, usageCount: 2, occurrences: [
    { title: 'City Dreams', start: 70, end: 134, duration: 64 },
    { title: 'City Dreams', start: 418, end: 437, duration: 19 }
  ] });
  h.replace(next); h.ui.openProject('project');
  h.submit('am-track-form', { title: 'City Dreams', artist: 'Singer', duration: '00:01:23', source: 'Original', usageCount: '2', notes: '' }, [
    { occurrenceTitle: 'City Dreams', occurrenceStart: '00:01:10', occurrenceEnd: '00:02:14' },
    { occurrenceTitle: 'Different Song', occurrenceStart: '00:06:58', occurrenceEnd: '00:07:17' }
  ]);
  assert.equal(h.saves, 1, h.notices.join('; '));
  assert.equal(h.state().cues.length, 2);
  assert.equal(h.state().works.length, 2);
  const originalCue = h.state().cues.find(cue => cue.workId === 'work');
  const separateCue = h.state().cues.find(cue => cue.workId !== 'work');
  assert.equal(originalCue.duration, 64);
  assert.equal(originalCue.usageCount, 1);
  assert.equal(separateCue.duration, 19);
  assert.equal(separateCue.usageCount, 1);
  const separateWork = h.state().works.find(work => work.id === separateCue.workId);
  assert.equal(separateWork.title, 'Different Song');
  assert.equal(separateWork.parties.length, 0);
  assert.equal(separateWork.artist, '');
  assert.equal(separateWork.needsMetadata, true);
});

test('separated entry reuses an existing matching song record', () => {
  const h = harness(), next = structuredClone(h.state());
  next.works[0].title = 'City Dreams';
  next.works.push({ ...structuredClone(next.works[0]), id: 'existing-song', title: 'Different Song', isrc: 'ISRC-2' });
  Object.assign(next.cues[0], { start: null, end: null, duration: 83, usageCount: 2, occurrences: [
    { title: 'City Dreams', start: 70, end: 134, duration: 64 },
    { title: 'City Dreams', start: 418, end: 437, duration: 19 }
  ] });
  h.replace(next); h.ui.openProject('project');
  h.submit('am-track-form', { title: 'City Dreams', artist: 'Singer', duration: '00:01:23', source: 'Original', usageCount: '2', notes: '' }, [
    { occurrenceTitle: 'City Dreams', occurrenceStart: '00:01:10', occurrenceEnd: '00:02:14' },
    { occurrenceTitle: 'Different Song', occurrenceStart: '00:06:58', occurrenceEnd: '00:07:17' }
  ]);
  assert.equal(h.saves, 1, h.notices.join('; '));
  assert.equal(h.state().works.length, 2);
  assert.equal(h.state().cues.find(cue => cue.workId === 'existing-song').duration, 19);
  assert.equal(h.state().works[1].isrc, 'ISRC-2');
});
