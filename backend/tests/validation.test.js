'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateWorkspace, validateSave } = require('../src/validation');

function fixture() {
  return { version: 1, works: [{ id: 'गीत-1', title: 'स्वर "A" <literal>', parties: [{ name: 'Composer', role: 'Composer', share: 25, ipi: '000123' }] }], artists: [], projects: [{ id: 'P1', title: 'Production', type: 'Series', episodes: [{ number: 1, title: 'Episode' }], periods: [{ from: 1, to: 4 }] }], cues: [{ id: 'C1', workId: 'गीत-1', projectId: 'P1', episode: 1, duration: 60, usagePercent: 33.3 }], clients: [], imports: [], exports: [], profiles: [], activity: [] };
}
test('optional metadata, Unicode IDs, leading zeros, partial shares and custom fields survive validation', () => {
  const value = fixture(); value.works[0].custom = { future: ['preserved'] };
  const before = structuredClone(value);
  assert.equal(validateWorkspace(value), value); assert.deepEqual(value, before);
});
test('malformed optional editor arrays and text are rejected before save', () => {
  const cases = [s => s.works[0].activity = 'bad', s => s.works[0].alternateTitles = {}, s => s.works[0].artist = [], s => s.projects[0].teamIds = 'bad', s => s.projects[0].productionHistory = [null], s => s.projects[0].periods[0].director = {}, s => s.activity = [{ text: 7 }], s => s.preferences = [], s => s.clients = [{ id: 'CL', name: 'Client', files: {} }], s => s.repositories = [{ id: 'R', references: [{ name: [] }] }]];
  for (const change of cases) { const value = fixture(); change(value); assert.throws(() => validateWorkspace(value), error => error.code === 'INVALID_WORKSPACE'); }
});
test('duplicate records, broken relationships and inconsistent episodes are rejected', () => {
  for (const change of [s => s.works.push({ ...s.works[0] }), s => s.cues[0].workId = 'missing', s => s.cues[0].episode = 2, s => s.projects[0].episodes.push({ number: 1 }), s => { s.projects[0].type = 'Movie'; }, s => s.works[0].parties[0].share = 101]) {
    const value = fixture(); change(value); assert.throws(() => validateWorkspace(value), error => error.code === 'INVALID_WORKSPACE');
  }
});
test('period overlap is detected regardless of input order without reordering data', () => {
  const value = fixture(); value.projects[0].periods = [{ from: 9, to: 11 }, { from: 1, to: 8 }];
  validateWorkspace(value); assert.equal(value.projects[0].periods[0].from, 9);
  value.projects[0].periods.push({ from: 8, to: 9 }); assert.throws(() => validateWorkspace(value), /overlap/);
});
test('unsafe imported keys and excessively nested records are rejected without mutation', () => {
  for (const key of ['__proto__', 'prototype', 'constructor', 'bad\0key']) {
    const value = fixture(); value.metadata = JSON.parse(JSON.stringify({ [key]: { auditMarker: true } }));
    assert.throws(() => validateWorkspace(value), /unsafe object key/);
  }
  const value = fixture(); let cursor = value;
  for (let i = 0; i < 95; i++) cursor = cursor.child = {};
  assert.throws(() => validateWorkspace(value), /deeply/); assert.equal({}.auditMarker, undefined);
});
test('save revisions must be nonnegative safe integers', () => {
  for (const expectedRevision of [-1, 0.1, '1', Number.MAX_SAFE_INTEGER]) assert.throws(() => validateSave({ workspace: fixture(), expectedRevision }), /safe integer/);
  assert.equal(validateSave({ workspace: fixture(), expectedRevision: 0 }).expectedRevision, 0);
});
test('large project and episode collections validate with original order preserved', () => {
  const value = fixture(); value.projects = []; value.cues = [];
  for (let i = 0; i < 500; i++) {
    value.projects.push({ id: 'P' + i, title: 'Project ' + i, type: 'Series', episodes: Array.from({ length: 20 }, (_, n) => ({ number: n + 1 })), periods: [{ from: 1, to: 20 }] });
    for (let n = 1; n <= 20; n++) value.cues.push({ id: `C${i}-${n}`, projectId: 'P' + i, workId: 'गीत-1', episode: n, duration: 30 });
  }
  assert.equal(validateWorkspace(value), value); assert.equal(value.cues.at(-1).id, 'C499-20');
});
