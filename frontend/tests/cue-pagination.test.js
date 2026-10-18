'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../public/dashboard.js'), 'utf8');
const block = source.slice(source.indexOf('function cues(){'), source.indexOf('function societies(){'));

test('cue list renders 100 rows per page while keeping all matching counts', () => {
  const state = {
    projects: [{ id: 'project', title: 'Series', type: 'Series' }],
    cues: Array.from({ length: 225 }, (_, index) => ({ id: 'cue-' + index, workId: 'work', projectId: 'project', episode: index + 1, duration: 30, start: 0, end: 30, usage: 'BI', source: 'Own' }))
  };
  const context = vm.createContext({ state, cueProject: 'All', cueListPage: 1, query: '',
    heading: () => '', btn: () => '', icon: () => '', esc: value => String(value),
    options: () => '', workName: () => 'Song', projectName: () => 'Series',
    badge: value => String(value), empty: () => '', D: { time: value => String(value) } });
  vm.runInContext(block, context);
  const first = context.cues();
  assert.equal((first.match(/data-edit-cue=/g) || []).length, 100);
  assert.match(first, /1–100 of 225 cues/);
  assert.match(first, /225 cues/);
  context.cueListPage = 3;
  const last = context.cues();
  assert.equal((last.match(/data-edit-cue=/g) || []).length, 25);
  assert.match(last, /201–225 of 225 cues/);
});
