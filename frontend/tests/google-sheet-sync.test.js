'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const GoogleSheetSync = require('../public/google-sheet-sync.js');

const sheetId = '1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789';
const shareLink = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;

test('Google Sheets links are canonicalized without retaining unrelated query data', () => {
  assert.deepEqual(GoogleSheetSync.parseUrl(`  ${shareLink}?usp=sharing&gid=42#gid=42  `), {
    id: sheetId, url: shareLink,
  });
  assert.deepEqual(GoogleSheetSync.parseUrl(`${shareLink}?resourcekey=0-access_key&usp=sharing`), {
    id: sheetId, url: `${shareLink}?resourcekey=0-access_key`,
  });
  assert.deepEqual(GoogleSheetSync.parseUrl(`https://docs.google.com/spreadsheets/d/${sheetId}/view/`), {
    id: sheetId, url: shareLink,
  });
  assert.deepEqual(GoogleSheetSync.parseUrl(`https://docs.google.com/spreadsheets/d/${sheetId}/preview`), {
    id: sheetId, url: shareLink,
  });
});

test('unsafe or unrelated URLs cannot be treated as Google Sheets', () => {
  for (const value of [
    '', 'not a URL',
    `http://docs.google.com/spreadsheets/d/${sheetId}/edit`,
    `https://docs.google.com.evil.test/spreadsheets/d/${sheetId}/edit`,
    `https://docs.google.com:444/spreadsheets/d/${sheetId}/edit`,
    `https://user:password@docs.google.com/spreadsheets/d/${sheetId}/edit`,
    `https://docs.google.com/document/d/${sheetId}/edit`,
    `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=xlsx`,
    `${shareLink}?resourcekey=first&resourcekey=second`,
    `${shareLink}?resourcekey=invalid%2Fkey`,
  ]) assert.throws(() => GoogleSheetSync.parseUrl(value), /Google Sheets|HTTPS|resource key/);
});

test('the browser script exposes the same API without requiring a module loader', () => {
  const source = readFileSync(join(__dirname, '../public/google-sheet-sync.js'), 'utf8');
  const context = vm.createContext({ URL });
  vm.runInContext(source, context);
  assert.equal(context.GoogleSheetSync.parseUrl(shareLink).id, sheetId);
  assert.equal(typeof context.GoogleSheetSync.replaceManagedOccurrences, 'function');
});

test('preserveTabs accepts a Set created by an isolated dashboard realm', () => {
  const vmSet = vm.runInNewContext("new Set(['Episode 2'])");
  const workspace = { cues: [{ id: 'one', occurrences: [
    { googleSheetId: sheetId, googleSheetTab: 'Episode 1', duration: 10 },
    { googleSheetId: sheetId, googleSheetTab: 'Episode 2', duration: 20 },
  ] }] };
  assert.equal(GoogleSheetSync.replaceManagedOccurrences(workspace, sheetId, { preserveTabs: vmSet }), 1);
  assert.equal(workspace.cues[0].occurrences[0].googleSheetTab, 'Episode 2');
  assert.equal(workspace.cues[0].duration, 20);
});

test('a refresh removes changed, deleted and reordered rows from its own tabs only', () => {
  const workspace = { cues: [
    {
      id: 'old-google-only', duration: 30, usageCount: 2,
      occurrences: [
        { googleSheetId: sheetId, googleSheetTab: 'Episode 1', rowNumber: 3, importSourceKey: 'old|3', duration: 10 },
        { googleSheetId: sheetId, googleSheetTab: 'Episode 1', rowNumber: 4, importSourceKey: 'old|4', duration: 20 },
      ],
    },
    {
      id: 'invalid-tab', duration: 8, usageCount: 1,
      occurrences: [{ googleSheetId: sheetId, googleSheetTab: 'Episode 2', rowNumber: 3, duration: 8 }],
    },
    {
      id: 'other-sheet', duration: 9, usageCount: 1,
      occurrences: [{ googleSheetId: 'a-different-sheet', googleSheetTab: 'Episode 1', rowNumber: 3, duration: 9 }],
    },
  ] };

  assert.equal(GoogleSheetSync.replaceManagedOccurrences(workspace, sheetId, { preserveTabs: new Set(['Episode 2']) }), 2);
  assert.deepEqual(workspace.cues.map(cue => cue.id), ['invalid-tab', 'other-sheet']);
  // After this preparation, the regular importer can add the changed row at
  // any position, omit a deleted row, and add a new one without stale matches.
  workspace.cues.push({ id: 'fresh-row', occurrences: [{ googleSheetId: sheetId, googleSheetTab: 'Episode 1', rowNumber: 7, duration: 12 }] });
  assert.equal(GoogleSheetSync.replaceManagedOccurrences(workspace, sheetId, { preserveTabs: new Set(['Episode 2']) }), 1);
  assert.deepEqual(workspace.cues.map(cue => cue.id), ['invalid-tab', 'other-sheet']);
});

test('manual and other-source plays survive and cue totals reflect the remaining plays', () => {
  const googleUse = { googleSheetId: sheetId, googleSheetTab: 'Episode 1', start: 5, end: 15, duration: 10, importSourceKey: 'google|3', importFingerprint: 'old-fingerprint' };
  const manualUse = { start: 30, end: 48, duration: 18, notes: 'Edited manually' };
  const otherFileUse = { start: 60, end: 70, duration: 10, importSourceKey: 'file|4', importFingerprint: 'file-fingerprint' };
  const workspace = { cues: [
    { id: 'mixed', workId: 'song', usage: 'FV', notes: 'Keep this', duration: 38, usageCount: 3,
      start: null, end: null, importSourceKey: 'google|3', importFingerprint: 'old-fingerprint',
      occurrences: [googleUse, manualUse, otherFileUse] },
    { id: 'manual-only', duration: 7, occurrences: [{ start: 1, end: 8, duration: 7 }] },
  ] };

  assert.equal(GoogleSheetSync.replaceManagedOccurrences(workspace, sheetId), 1);
  assert.equal(workspace.cues.length, 2);
  assert.deepEqual(workspace.cues[0].occurrences, [manualUse, otherFileUse]);
  assert.equal(workspace.cues[0].duration, 28);
  assert.equal(workspace.cues[0].usageCount, 2);
  assert.equal(workspace.cues[0].start, null);
  assert.equal(workspace.cues[0].end, null);
  assert.equal(workspace.cues[0].importSourceKey, 'file|4');
  assert.equal(workspace.cues[0].importFingerprint, 'file-fingerprint');
  assert.equal(workspace.cues[0].workId, 'song');
  assert.equal(workspace.cues[0].usage, 'FV');
  assert.equal(workspace.cues[0].notes, 'Keep this');
  assert.equal(workspace.cues[1].duration, 7);
  assert.equal(GoogleSheetSync.replaceManagedOccurrences(workspace, sheetId), 0);
});

test('a single surviving manual play restores its own timing and clears stale import keys', () => {
  const workspace = { cues: [{
    id: 'mixed', duration: 25, usageCount: 2, start: null, end: null,
    importSourceKey: 'google|3', importFingerprint: 'old-fingerprint',
    occurrences: [
      { googleSheetId: sheetId, googleSheetTab: 'Episode 1', start: 0, end: 10, duration: 10, importSourceKey: 'google|3', importFingerprint: 'old-fingerprint' },
      { start: 90, end: 105, duration: 15, notes: 'manual' },
    ],
  }] };
  assert.equal(GoogleSheetSync.replaceManagedOccurrences(workspace, sheetId), 1);
  assert.equal(workspace.cues[0].duration, 15);
  assert.equal(workspace.cues[0].usageCount, 1);
  assert.equal(workspace.cues[0].start, 90);
  assert.equal(workspace.cues[0].end, 105);
  assert.equal(workspace.cues[0].importSourceKey, undefined);
  assert.equal(workspace.cues[0].importFingerprint, undefined);
});
