'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const source = readFileSync(join(__dirname, '../public/dashboard.js'), 'utf8'), context = vm.createContext({});
vm.runInContext(source.slice(0, source.indexOf('/* data.js */')), context);
const D = context.CueDomain;

test('startup/save usage migration keeps imported and manually edited usage and percentages unchanged', () => {
  const workspace = {
    works: [{ id: 'song', title: 'Background Opening Title' }],
    cues: [{ id: 'cue', workId: 'song', usage: 'FV', societyUsage: { IPRS: 'FV', PRS: 'V', ASCAP: 'ET' }, usagePercent: 17.875, duration: 150 }],
    deletedCues: [{ cue: { id: 'deleted', workId: 'song', usage: 'CI', societyUsage: { IPRS: 'CV', PRS: 'F', ASCAP: 'MT' }, usagePercent: 9.5 } }],
  };
  const before = JSON.stringify(workspace);
  assert.equal(D.applyTitleUsage(workspace), true);
  assert.equal(JSON.stringify(workspace.cues), JSON.stringify(JSON.parse(before).cues));
  assert.equal(JSON.stringify(workspace.deletedCues), JSON.stringify(JSON.parse(before).deletedCues));
  assert.deepEqual(JSON.parse(JSON.stringify(workspace.works[0].societyUsage)), { IPRS: 'FV', PRS: 'V', ASCAP: 'ET' });
  assert.equal(D.applyTitleUsage(workspace), false);
  workspace.works[0].title = 'A completely new song title';
  assert.equal(D.applyTitleUsage(workspace), false);
  assert.equal(JSON.stringify(workspace.cues), JSON.stringify(JSON.parse(before).cues));
});

test('a saved song reuses exact society codes in new projects instead of title defaults', () => {
  const work = { id: 'song', title: 'Background Instrumental', societyUsage: { IPRS: 'FV', PRS: 'F', ASCAP: 'VI' } };
  assert.deepEqual(JSON.parse(JSON.stringify(D.usageSetForWork(work))), work.societyUsage);
  const workspace = { works: [work], cues: [{ id: 'new-project-cue', projectId: 'new-project', workId: 'song' }] };
  D.applyTitleUsage(workspace);
  assert.deepEqual(JSON.parse(JSON.stringify(workspace.cues[0].societyUsage)), JSON.parse(JSON.stringify(work.societyUsage)));
  assert.equal(workspace.cues[0].usage, 'FV');
});

test('editing database song codes updates every live cue across projects and survives reload', () => {
  const workspace = {
    works: [{ id: 'song', title: 'Background', societyUsage: { IPRS: 'FV', PRS: 'F', ASCAP: 'VI' } }, { id: 'other', title: 'Other song' }],
    cues: [
      { id: 'one', workId: 'song', projectId: 'first', duration: 35, usagePercent: 10, usage: 'FV', societyUsage: { IPRS: 'FV', PRS: 'F', ASCAP: 'VI' } },
      { id: 'two', workId: 'song', projectId: 'second', episode: 7, duration: 200, usage: 'FV', societyUsage: { IPRS: 'FV', PRS: 'F', ASCAP: 'VI' } },
      { id: 'other-cue', workId: 'other', usage: 'CI', societyUsage: { IPRS: 'CI', PRS: 'T', ASCAP: 'ET' } },
    ],
    exports: [{ snapshot: { cues: [{ workId: 'song', societyUsage: { IPRS: 'FV', PRS: 'F', ASCAP: 'VI' } }] } }],
  };
  const previousExport = JSON.stringify(workspace.exports), unrelated = JSON.stringify(workspace.cues[2]);
  workspace.works[0].societyUsage = { IPRS: 'BI', PRS: 'B', ASCAP: 'BI' };
  assert.equal(D.applyTitleUsage(workspace), true);
  for (const cue of workspace.cues.slice(0, 2)) {
    assert.deepEqual(JSON.parse(JSON.stringify(cue.societyUsage)), JSON.parse(JSON.stringify(workspace.works[0].societyUsage)));
    assert.equal(cue.usage, 'BI');
    for (const society of ['IPRS', 'PRS', 'ASCAP']) assert.equal(D.usageFor(cue, society), workspace.works[0].societyUsage[society]);
  }
  assert.equal(workspace.cues[0].duration, 35);
  assert.equal(workspace.cues[0].usagePercent, 10);
  assert.equal(workspace.cues[1].duration, 200);
  assert.equal(JSON.stringify(workspace.cues[2]), unrelated);
  assert.equal(JSON.stringify(workspace.exports), previousExport);
  const reload = JSON.parse(JSON.stringify(workspace));
  assert.equal(D.applyTitleUsage(reload), false);
  assert.deepEqual(JSON.parse(JSON.stringify(D.usageSetForCue({ societyUsage: { IPRS: 'FV' } }, 'Background', reload.works[0]))), JSON.parse(JSON.stringify(reload.works[0].societyUsage)));
});

test('conflicting existing cue codes stay distinct and are not chosen as song defaults', () => {
  const workspace = { works: [{ id: 'song', title: 'Background Music' }], cues: [
    { workId: 'song', societyUsage: { IPRS: 'FV', PRS: 'F', ASCAP: 'VI' } },
    { workId: 'song', societyUsage: { IPRS: 'BI', PRS: 'B', ASCAP: 'BI' } },
  ] };
  const before = JSON.stringify(workspace.cues);
  D.applyTitleUsage(workspace);
  assert.ok(!workspace.works[0].societyUsage);
  assert.equal(JSON.stringify(workspace.cues.map(c=>c.societyUsage)), JSON.stringify(JSON.parse(before).map(c=>c.societyUsage)));
});

test('missing society codes derive from stored cue usage before considering the song title', () => {
  const workspace = { works: [{ id: 'song', title: 'Opening Title' }], cues: [{ workId: 'song', usage: 'BV', usagePercent: 31.25 }] };
  assert.equal(D.applyTitleUsage(workspace), true);
  assert.deepEqual(JSON.parse(JSON.stringify(workspace.cues[0])), { workId: 'song', usage: 'BV', usagePercent: 31.25, societyUsage: { IPRS: 'BV', PRS: 'B', ASCAP: 'BV' } });
  assert.equal(D.applyTitleUsage(workspace), false);
});

test('partially entered society mappings keep valid overrides and fill only missing equivalents', () => {
  const workspace = { works: [{ id: 'song', title: 'Background Music' }], cues: [{ workId: 'song', usage: '', societyUsage: { IPRS: 'FV', PRS: 'F' } }] };
  D.applyTitleUsage(workspace);
  assert.equal(workspace.cues[0].usage, 'FV');
  assert.equal(workspace.cues[0].societyUsage.IPRS, 'FV');
  assert.equal(workspace.cues[0].societyUsage.PRS, 'F');
  assert.equal(workspace.cues[0].societyUsage.ASCAP, 'VV');
});

test('new cues without usage still receive the existing title defaults', () => {
  const workspace = { works: [{ id: 'song', title: 'Opening Title' }], cues: [{ workId: 'song' }] };
  D.applyTitleUsage(workspace);
  assert.deepEqual(JSON.parse(JSON.stringify(workspace.cues[0].societyUsage)), { IPRS: 'OI', PRS: 'F', ASCAP: 'MT' });
  assert.equal(workspace.cues[0].usage, 'OI');
});

test('invalid stored society usage remains visible to validation instead of silently rewriting it', () => {
  const work = { id: 'song', title: 'Background Music', parties: [{ name: 'Writer', share: 100 }] };
  const cue = { id: 'cue', workId: 'song', duration: 60, usage: 'BI', societyUsage: { IPRS: 'BAD', PRS: 'V' } };
  D.applyTitleUsage({ works: [work], cues: [cue] });
  assert.equal(cue.societyUsage.IPRS, 'BAD');
  assert.equal(cue.societyUsage.PRS, 'V');
  assert.match(D.validateExport([cue], [work], 'IPRS', {})[0].message, /BAD.*valid IPRS mapping/);
  assert.equal(D.validateExport([cue], [work], 'PRS', {}).length, 0);
});
