'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../public/dashboard.js'), 'utf8');
const context = { TextEncoder };
const start = source.indexOf('/* export-filenames.js */');
const end = source.indexOf('/* amishna.prototype.js */', start);
assert.ok(start >= 0 && end > start, 'The export filename module is present');
vm.runInNewContext(source.slice(start, end), context);
const filename = context.CueExportFilename;
const series = { type: 'Series', title: 'SerialName' };
const movie = { type: 'Movie', title: 'MovieName' };

test('serial workbooks name the serial, padded episode and selected society', () => {
  for (const society of ['IPRS', 'PRS', 'ASCAP']) {
    assert.equal(filename(series, 1, society), `SerialName_Episode_01_${society}.xlsx`);
    assert.equal(filename(series, '06', society), `SerialName_Episode_06_${society}.xlsx`);
    assert.equal(filename(series, 123, society), `SerialName_Episode_123_${society}.xlsx`);
  }
  assert.equal(filename(series, '001', 'IPRS'), 'SerialName_Episode_001_IPRS.xlsx');
});

test('movie workbooks omit episode metadata and retain the selected society', () => {
  for (const society of ['IPRS', 'PRS', 'ASCAP']) {
    assert.equal(filename(movie, null, society), `MovieName_${society}.xlsx`);
    assert.equal(filename(movie, 6, society), `MovieName_${society}.xlsx`);
  }
});

test('combined episode ZIP names omit the society', () => {
  assert.equal(filename(series, 1, undefined, { extension: 'zip' }), 'SerialName_Episode_01.zip');
  assert.equal(filename(series, '06', 'IPRS', { extension: 'zip' }), 'SerialName_Episode_06.zip');
  assert.equal(filename(series, 1, 'PRS', { extension: 'zip', endEpisode: 1 }), 'SerialName_Episode_01.zip');
});

test('range ZIP names use padded start and end episodes without a society', () => {
  assert.equal(filename(series, 1, 'IPRS', { extension: 'zip', endEpisode: 50 }), 'SerialName_Episodes_01-50.zip');
  assert.equal(filename(series, '06', null, { extension: 'zip', endEpisode: 9 }), 'SerialName_Episodes_06-09.zip');
});

test('movie ZIP names contain only the movie title', () => {
  assert.equal(filename(movie, null, undefined, { extension: 'zip' }), 'MovieName.zip');
  assert.equal(filename(movie, 1, 'ASCAP', { extension: 'zip', endEpisode: 50 }), 'MovieName.zip');
});

test('Unicode names survive sanitization while path characters are removed', () => {
  assert.equal(filename({ ...series, title: 'मराठी मालिका' }, 3, 'IPRS'), 'मराठी_मालिका_Episode_03_IPRS.xlsx');
  assert.equal(filename({ ...movie, title: 'मेरा गीत / mùa hè' }, null, 'PRS'), 'मेरा_गीत_mùa_hè_PRS.xlsx');
  assert.equal(filename({ ...series, title: 'Serial: "Season/One"?*' }, 21, 'ASCAP'), 'Serial_Season_One_Episode_21_ASCAP.xlsx');
  assert.equal(filename({ ...movie, title: '../\\:*?' }, null, 'IPRS'), 'Production_IPRS.xlsx');
});

test('long non-Latin titles fit ordinary filesystem filename limits', () => {
  const result = filename({ ...series, title: 'मराठी '.repeat(100) }, 100, 'IPRS');
  assert.ok(Buffer.byteLength(result, 'utf8') < 255);
  assert.match(result, /_Episode_100_IPRS\.xlsx$/);
  assert.ok(!result.includes('\uFFFD'), 'Truncation preserves complete Unicode characters');
});

test('historical snapshot downloads can use their saved title and episode', () => {
  const record = { projectTitle: 'Saved Serial', episode: 7, society: 'IPRS', snapshot: { project: { type: 'Series' } } };
  const project = { ...record.snapshot.project, title: record.snapshot.project.title || record.projectTitle };
  assert.equal(filename(project, record.episode, record.society), 'Saved_Serial_Episode_07_IPRS.xlsx');
  assert.ok(!filename(project, record.episode, record.society).startsWith('DRAFT_'));
});
