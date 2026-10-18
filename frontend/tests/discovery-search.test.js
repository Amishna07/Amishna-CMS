'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const source = readFileSync(join(__dirname, '../public/dashboard.js'), 'utf8');
const discovery = source.slice(source.indexOf('/* discovery.js */'), source.indexOf('/* cue-resizer.js */'));

function harness() {
  let state = {
    projects: [{ id: 'P1', title: 'First serial', clientId: 'C1', assignedEditorId: 'M1', type: 'Series', episodes: [{ number: 1, title: 'Opening' }], status: 'Active' }, { id: 'P2', title: 'Second movie', type: 'Movie', episodes: [], status: 'Complete' }],
    works: Array.from({ length: 105 }, (_, index) => ({ id: 'W' + index, title: 'Song ' + String(index + 1).padStart(3, '0'), artistIds: ['A1'], parties: [{ name: 'Writer', artistId: 'A1', role: 'Composer', share: 100 }], isrc: 'ISRC' + index, societies: {} })),
    cues: Array.from({ length: 105 }, (_, index) => ({ id: 'Q' + index, workId: 'W' + index, projectId: index < 40 ? 'P1' : 'P2', episode: index < 40 ? 1 : null, duration: 60, start: 0, end: 60, usage: 'BV' })),
    artists: [{ id: 'A1', name: 'Writer', roles: ['Composer'], societies: ['IPRS'], status: 'Active' }],
    clients: [{ id: 'C1', name: 'A client', files: [{ id: 'F1', name: 'Client reference', url: 'https://example.com' }] }],
    repositories: [{ id: 'R1', name: 'Reference folder', projectIds: ['P1'], references: [{ id: 'F2', name: 'Repository reference' }] }],
    imports: [{ id: 'I1', filename: 'Imported.xlsx', projectId: 'P1' }], exports: [{ id: 'E1', projectTitle: 'Saved export', projectId: 'P1', society: 'IPRS', count: 40 }],
    members: [{ id: 'M1', name: 'Editor', role: 'Editor' }], profiles: [{ id: 'PF1', name: 'Sheet mapping', headers: ['Title'], mapping: ['title'] }],
    activity: [{ text: 'First serial created', date: '2026-01-01' }],
  };
  let revision = 0, query = '', html = '', modal = '', titleReads = 0;
  Object.defineProperty(state.works[0], 'artist', { enumerable: true, get() { titleReads++; return 'Test singer'; } });
  const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const context = { document: { getElementById: () => ({ focus() {}, scrollIntoView() {} }) }, FormData: class { constructor(form) { this.form = form; } get() { return this.form.value; } }, CueDomain: { time: value => String(value ?? 0) }, CueExports: { mappings: { IPRS: { columns: ['Title'], headerRow: 15 } } } };
  context.window = context; vm.createContext(context); vm.runInContext(discovery, context);
  const ctx = { state: () => state, revision: () => revision, query: () => query, setQuery: value => { query = value; }, esc: escape, icon: () => '', options: () => '', badge: value => escape(value), date: value => value, modalHead: title => '<h2>' + escape(title) + '</h2>', modal: value => { modal = value; }, render: () => { html = ux.search(); } };
  const ux = context.createDiscoveryUX(ctx);
  const render = () => { ctx.render(); return html; };
  const click = (dataset, disabled = false) => { ux.click({ target: { closest: () => ({ dataset, disabled }) } }); return html; };
  const change = (id, value) => { ux.change({ target: { id, value, dataset: { dxFilter: id } } }); return html; };
  const titles = () => [...html.matchAll(/<h3><button class="link-button"[^>]*>(.*?)<\/button><\/h3>/g)].map(match => match[1]);
  return { ux, render, click, change, titles, state: () => state, html: () => html, modal: () => modal, reads: () => titleReads,
    bump: () => revision++, replace: next => { state = next; }, query: value => { query = value; },
  };
}

test('search pages expose every result once, with at most 40 cards and working previous navigation', () => {
  const h = harness(), collected = [];
  h.click({ dxCategory: 'works' });
  assert.match(h.html(), /Showing 1–40 of 105 records · Page 1 of 3/);
  assert.match(h.html(), /aria-label="Previous page of search results"[^>]*disabled/);
  for (let page = 1; page <= 3; page++) {
    if (page > 1) h.click({ dxSearchPage: String(page) });
    assert.ok(h.titles().length <= 40); collected.push(...h.titles());
  }
  assert.equal(new Set(collected).size, 105);
  assert.deepEqual(collected, h.state().works.map(work => work.title));
  assert.match(h.html(), /Showing 81–105 of 105 records · Page 3 of 3/);
  assert.match(h.html(), /aria-label="Next page of search results"[^>]*disabled/);
  h.click({ dxSearchPage: '2' });
  assert.equal(h.titles()[0], 'Song 041');
  h.render(); assert.equal(h.titles()[0], 'Song 041');
  h.click({ dxDetail: 'works:W100' });
  assert.match(h.modal(), /Song 101/); assert.match(h.modal(), /ISRC100/);
});

test('changed global query, category, project filter, status and sort reset pagination', () => {
  const h = harness();
  h.click({ dxCategory: 'works' }); h.click({ dxSearchPage: '3' });
  h.query('Song 050'); h.render();
  assert.deepEqual(h.titles(), ['Song 050']); assert.match(h.html(), /Page 1 of 1/);
  h.query(''); h.render(); h.click({ dxSearchPage: '2' });
  h.change('dx-search-project', 'P2');
  assert.equal(h.titles()[0], 'Song 041'); assert.match(h.html(), /Showing 1–40 of 65 records/);
  h.click({ dxSearchPage: '2' }); h.change('dx-search-sort', 'title-desc');
  assert.equal(h.titles()[0], 'Song 105'); assert.match(h.html(), /Page 1 of 2/);
  h.click({ dxSearchPage: '2' }); h.click({ dxCategory: 'cues' });
  assert.match(h.html(), /Page 1 of 2/);
  h.click({ dxSearchPage: '2' }); h.change('dx-search-status', 'Active');
  assert.equal(h.titles().length, 0); assert.match(h.html(), /No matching records/);
  h.click({ dx: 'clear-search' }); assert.match(h.html(), /Showing 1–40/);
});

test('revision cache reuses records between pages and refreshes names, matching and full details after edits', () => {
  const h = harness();
  h.click({ dxCategory: 'works' }); const firstReads = h.reads();
  assert.ok(firstReads > 0);
  h.click({ dxSearchPage: '2' }); h.render();
  assert.equal(h.reads(), firstReads);
  h.state().works[0].title = 'Revised Sonata'; h.state().works[0].isrc = 'NEW-CODE'; h.bump();
  h.query('NEW-CODE'); h.render();
  assert.deepEqual(h.titles(), ['Revised Sonata']); assert.ok(h.reads() > firstReads);
  h.click({ dxDetail: 'works:W0' }); assert.match(h.modal(), /NEW-CODE/);
  h.query('Revised Sonata'); h.render(); assert.deepEqual(h.titles(), ['Revised Sonata']);
});

test('replacement workspaces invalidate equal-revision caches and shorter result sets clamp the current page', () => {
  const h = harness();
  h.click({ dxCategory: 'works' }); h.click({ dxSearchPage: '3' });
  const next = { ...h.state(), works: [{ ...h.state().works[0], title: 'Restored song' }] };
  h.replace(next); h.render();
  assert.deepEqual(h.titles(), ['Restored song']); assert.match(h.html(), /Showing 1–1 of 1 records · Page 1 of 1/);
});

test('all discovery categories and their records remain reachable after pagination', () => {
  const h = harness();
  const counts = { projects: 2, works: 105, artists: 1, cues: 105, episodes: 1, clients: 1, references: 2, repositories: 4, imports: 1, exports: 1, members: 1, profiles: 1, activity: 1, societies: 1 };
  for (const [category, total] of Object.entries(counts)) {
    h.click({ dxCategory: category });
    assert.equal(h.titles().length, Math.min(40, total), category);
    assert.match(h.html(), new RegExp('of ' + total + ' records'), category);
  }
  h.query('IPI'); h.click({ dxCategory: 'artists' });
  assert.deepEqual(h.titles(), ['Writer']);
});
