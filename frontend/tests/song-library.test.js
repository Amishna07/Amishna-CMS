'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const source = readFileSync(join(__dirname, '../public/dashboard.js'), 'utf8');
const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

function element(tagName, dataset = {}, parentElement = null) {
  const node = { tagName: tagName.toUpperCase(), dataset, parentElement, disabled: false, isConnected: true };
  node.matches = selector => selector.split(',').some(part => {
    part = part.trim();
    const tag = part.match(/^[a-z]+/i)?.[0];
    if (tag && tag.toUpperCase() !== node.tagName) return false;
    if (part.includes('.song-library-row') && !(node.tagName === 'TR' && dataset.catalog === 'song-select')) return false;
    const attributes = [...part.matchAll(/\[([^\]=]+)(?:=["']?([^\]"']+)["']?)?\]/g)];
    for (const [, name, expected] of attributes) {
      const key = name.startsWith('data-') ? name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()) : name;
      const value = name.startsWith('data-') ? node.dataset[key] : node[key];
      if (value == null || expected !== undefined && String(value) !== expected) return false;
    }
    return Boolean(tag || attributes.length || part === '.song-library-row');
  });
  node.closest = selector => node.matches(selector) ? node : parentElement?.closest(selector) || null;
  return node;
}

function fixture(count = 95) {
  const works = Array.from({ length: count }, (_, index) => ({
    id: 'song-' + index, title: 'Song ' + String(index).padStart(3, '0'), artist: 'Singer', artistIds: ['singer'],
    type: 'Song', language: 'Marathi', source: 'Original', isrc: 'ISRC-' + index,
    societies: {}, parties: [], createdAt: '2026-01-01', updatedAt: '2026-10-27', activity: [],
  }));
  if (works[0]) Object.assign(works[0], {
    isrc: 'ISRC-DISTINCT', iswc: 'ISWC-DISTINCT', tuneCode: 'TUNE-DISTINCT',
    societies: { IPRS: 'IPRS-DISTINCT', PRS: 'PRS-DISTINCT', ASCAP: 'ASCAP-DISTINCT' },
    societyUsage: { IPRS: 'BV', PRS: 'BI', ASCAP: 'BG' },
    parties: [
      { name: 'Dual Writer', role: 'Composer / Lyricist', ipi: '00012345678', society: 'IPRS/PRS', share: 100, artistId: 'writer' },
      { name: 'Zero Share Publisher', role: 'Publisher', ipi: '00000000001', society: 'ASCAP', share: 0 },
    ],
    label: 'Complete Label', album: 'Complete Album', genre: 'Soundtrack', releaseDate: '2026-10-01',
    recordingDuration: '00:04:03', alternateTitles: ['Alternate song title'], tags: ['Library tag'],
    notes: 'Long notes <script>alert("song")</script> & preserved text', status: 'Reviewed status',
    research: { source: 'Research archive', url: 'https://example.com/reference', notes: 'Research notes retained' },
    contract: { territory: 'Worldwide territory', customNumber: 0 },
  });
  return {
    works, artists: [
      { id: 'singer', name: 'Singer', roles: ['Performer'], societies: ['ASCAP'] },
      { id: 'writer', name: 'Dual Writer', roles: ['Composer / Lyricist'], societies: ['IPRS', 'PRS'] },
    ],
    projects: [{ id: 'project', title: 'Example production', type: 'Series', episodes: [{ number: 1 }] }],
    cues: works.length ? [{ id: 'cue', workId: 'song-0', projectId: 'project', episode: 1, duration: 60, start: 0, end: 60 }] : [],
    exports: [], imports: [], activity: [], preferences: {},
  };
}

function harness(state = fixture()) {
  let html = '', revision = 0, saves = 0;
  const focused = [], scrolls = [], edits = [];
  const focusNode = id => ({ focus() { focused.push(id); }, scrollIntoView() {}, setAttribute() {}, setSelectionRange() {} });
  const context = vm.createContext({ structuredClone, crypto: globalThis.crypto, setTimeout: callback => callback(), requestAnimationFrame: callback => callback() });
  context.window = context;
  context.matchMedia = () => ({ matches: false });
  context.scrollY = 280;
  context.scrollTo = (...args) => scrolls.push(args);
  context.document = {
    querySelector: selector => focusNode(selector), getElementById: id => focusNode(id),
    querySelectorAll: selector => selector === '.song-library-row'
      ? [...html.matchAll(/<tr\b[^>]*data-catalog="song-select"[^>]*data-id="([^"]+)"/g)].map(([, id]) => ({ ...focusNode(id), dataset: { id } }))
      : [],
  };
  vm.runInContext(source.slice(0, source.indexOf('/* data.js */')), context);
  vm.runInContext(readFileSync(join(__dirname, '../public/societies.js'), 'utf8'), context);
  vm.runInContext(source.slice(source.indexOf('/* catalog.js */'), source.indexOf('/* database-import.js */')), context);
  vm.runInContext(source.slice(source.indexOf('/* insights.js'), source.indexOf('/* insights.js end */')), context);
  const ctx = {
    state: () => state, revision: () => revision, esc: escape, icon: () => '', date: String,
    save: () => { saves++; return true; }, openWork: (...args) => edits.push(args),
    render: () => { html = catalog.songs(); }, go: () => { html = catalog.songs(); },
  };
  const catalog = context.CueCatalog.create(ctx);
  const render = () => { ctx.render(); return html; };
  const event = target => ({ target, prevented: false, preventDefault() { this.prevented = true; } });
  const click = (action, id = '') => { const ev = event(element('button', { catalog: action, id })); catalog.click(ev); return ev; };
  const row = id => { const node = element('tr', { catalog: 'song-select', id }); node.click = () => catalog.click(event(node)); return node; };
  const open = id => click('song-select', id);
  render();
  return { catalog, state, render, click, open, row, event, html: () => html, focused, scrolls, edits, saves: () => saves, bump: () => revision++ };
}

test('the library opens a full song record from the row or title without saving data', () => {
  const h = harness(), before = structuredClone(h.state);
  assert.ok(!h.html().includes('song-record-page'));
  assert.equal((h.html().match(/data-catalog="song-check"/g) || []).length, 40);
  const row = h.row('song-12');
  const cell = element('td', {}, row);
  assert.equal(h.catalog.click(h.event(element('span', {}, cell))), true);
  assert.match(h.html(), /song-record-page/);
  assert.match(h.html(), /<h1\b[^>]*>Song 012<\/h1>/);
  assert.ok(h.focused.some(selector => selector.includes('song-record-heading')), 'opening a record focuses its heading');
  assert.ok(!h.html().includes('data-catalog="song-check"'));
  h.click('song-back'); h.open('song-13');
  assert.match(h.html(), /<h1\b[^>]*>Song 013<\/h1>/);
  assert.equal(h.saves(), 0);
  assert.deepEqual(h.state, before);
});

test('checkbox and edit interactions inside rows do not open the song record', () => {
  const h = harness(), row = h.row('song-5');
  const checkbox = element('input', { catalog: 'song-check', id: 'song-5' }, row);
  checkbox.checked = true;
  h.catalog.click(h.event(checkbox));
  h.catalog.change({ target: checkbox });
  assert.ok(!h.html().includes('song-record-page'));
  assert.match(h.html(), /1 selected/);
  const edit = element('button', { catalog: 'song-edit', id: 'song-5' }, row);
  h.catalog.click(h.event(edit));
  assert.deepEqual(h.edits, [['song-5']]);
  assert.ok(!h.html().includes('song-record-page'));
});

test('Back retains the search and page, and next/previous cross page boundaries', () => {
  const h = harness();
  h.catalog.input({ target: { dataset: { catalog: 'song-search' }, value: 'Song', id: 'cat-song-search', selectionStart: 4 } });
  h.click('song-page-next'); h.open('song-79');
  assert.match(h.html(), /<h1\b[^>]*>Song 079<\/h1>/);
  h.click('song-record-next');
  assert.match(h.html(), /<h1\b[^>]*>Song 080<\/h1>/);
  h.click('song-record-previous');
  assert.match(h.html(), /<h1\b[^>]*>Song 079<\/h1>/);
  h.click('song-back');
  assert.match(h.html(), /Page 2 of 3/);
  assert.match(h.html(), /value="Song"/);
  assert.match(h.html(), /data-id="song-79"/);
  assert.ok(h.focused.some(selector => selector.includes('song-79')), 'Back restores focus to the song in the library');
  assert.equal(h.saves(), 0);
});

test('direct navigation finds songs outside current filters and returns to their library page', () => {
  const h = harness();
  h.catalog.input({ target: { dataset: { catalog: 'song-search' }, value: 'Song 001', id: 'cat-song-search', selectionStart: 8 } });
  h.click('song-open', 'song-91');
  assert.match(h.html(), /<h1\b[^>]*>Song 091<\/h1>/);
  h.click('song-back');
  assert.match(h.html(), /Page 3 of 3/);
  assert.ok(!h.html().includes('value="Song 001"'));
  assert.match(h.html(), /data-id="song-91"/);
});

test('record navigation stays within the filtered result set at both ends', () => {
  const h = harness();
  h.catalog.input({ target: { dataset: { catalog: 'song-search' }, value: 'Song 00', id: 'cat-song-search', selectionStart: 7 } });
  h.open('song-9'); h.click('song-record-next');
  assert.match(h.html(), /<h1\b[^>]*>Song 009<\/h1>/);
  h.click('song-record-previous');
  assert.match(h.html(), /<h1\b[^>]*>Song 008<\/h1>/);
  h.click('song-back'); h.open('song-0'); h.click('song-record-previous');
  assert.match(h.html(), /<h1\b[^>]*>Song 000<\/h1>/);
});

test('combined composer and lyricist credits appear under either contributor filter', () => {
  const h = harness();
  for (const value of ['Composer', 'Lyricist']) {
    h.catalog.change({ target: { dataset: { catalog: 'song-role' }, value } });
    assert.equal((h.html().match(/data-catalog="song-check"/g) || []).length, 1);
    assert.match(h.html(), /data-id="song-0"/);
  }
});

test('row keyboard activation opens details while checkbox and button key events keep native behavior', () => {
  const h = harness(), row = h.row('song-7');
  for (const key of ['Enter', ' ']) {
    const ev = { ...h.event(row), key };
    assert.equal(h.catalog.keydown(ev), true);
    assert.equal(ev.prevented, true);
    assert.match(h.html(), /<h1\b[^>]*>Song 007<\/h1>/);
    h.click('song-back');
  }
  for (const tag of ['input', 'button']) {
    const target = element(tag, { catalog: tag === 'input' ? 'song-check' : 'song-select', id: 'song-7' }, row);
    const ev = { ...h.event(target), key: ' ' };
    assert.ok(!h.catalog.keydown(ev));
    assert.equal(ev.prevented, false);
    assert.ok(!h.html().includes('song-record-page'));
  }
});

test('full records retain separate identifiers, combined writer credits, zero shares and all stored metadata', () => {
  const h = harness(); h.open('song-0');
  const html = h.html();
  for (const value of ['ISRC-DISTINCT', 'ISWC-DISTINCT', 'TUNE-DISTINCT', 'IPRS-DISTINCT', 'PRS-DISTINCT', 'ASCAP-DISTINCT',
    '00012345678', '00000000001', 'Zero Share Publisher', 'Complete Label', 'Complete Album', 'Soundtrack', '00:04:03',
    'Alternate song title', 'Library tag', 'Research archive', 'Research notes retained', 'Reviewed status', 'Worldwide territory']) assert.ok(html.includes(value), value);
  assert.match(html, /<dt>Composers?<\/dt>\s*<dd>[^<]*Dual Writer/);
  assert.match(html, /<dt>Lyricists?(?: \/ Authors?)?<\/dt>\s*<dd>[^<]*Dual Writer/);
  assert.match(html, /0%/);
  assert.match(html, /&lt;script&gt;/);
  assert.ok(!html.includes('<script>alert'));
});

test('a selected song removed by a workspace refresh returns safely to the library', () => {
  const h = harness(); h.open('song-4');
  h.state.works = h.state.works.filter(work => work.id !== 'song-4'); h.bump();
  assert.doesNotThrow(h.render);
  assert.ok(!h.html().includes('song-record-page'));
  assert.match(h.html(), /Song database/);
  assert.equal(h.saves(), 0);
});

test('empty libraries and stale direct links remain navigable without selecting another song', () => {
  const h = harness(fixture(0));
  assert.ok(!h.html().includes('song-record-page'));
  assert.doesNotThrow(() => h.click('song-open', 'missing-song'));
  assert.ok(!h.html().includes('song-record-page'));
  assert.match(h.html(), /Song database/);
});
