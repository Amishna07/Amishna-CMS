'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../public/dashboard.js'), 'utf8');

function importHarness() {
  const listeners = {};
  let nextId = 0;
  const context = vm.createContext({
    document: { addEventListener: (name, listener) => { listeners[name] = listener; } },
    importDefaultType: 'Movie',
    bulkImportActive: false,
    esc: value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]),
    uid: prefix => prefix + (++nextId),
  });
  vm.runInContext(source.slice(0, source.indexOf('/* data.js */')), context);
  context.D = context.CueDomain;
  vm.runInContext(source.slice(source.indexOf('const importMovieFields='), source.indexOf('function bulkColumnField(')), context);
  vm.runInContext(source.slice(source.indexOf('function bulkProject('), source.indexOf('function bulkFillMissingWork(')), context);
  return { context, listeners };
}

function session(overrides = {}) {
  return {
    filename: 'Movie.xlsx',
    raw: [['01:30:00', '10 Apr 2021', 'Sample Movie', '', 1]],
    workfile: { serialName: 'Sample Movie', episodeNumber: 1, totalDurationSeconds: 5400, date: '10 Apr 2021' },
    defaultProjectType: 'Movie',
    movieDetails: {
      genre: 'Drama', language: 'Marathi', productionNo: 'CBFC 123', airdate: '2025-04-01',
      year: '2025', duration: '02:15:30', producer: 'Producer', director: 'Director',
      company: 'Studio', cast: 'Lead One, Lead Two', bgComposer: 'Composer', submittedBy: 'Publisher',
    },
    ...overrides,
  };
}

test('new movie imports preserve all IPRS metadata and use supplied date/duration over file defaults', () => {
  const { context } = importHarness(), workspace = { projects: [] }, upload = session();
  const project = context.bulkProject(upload, workspace, new Map());
  assert.equal(project.type, 'Movie');
  assert.equal(project.title, 'Sample Movie');
  assert.equal(project.year, 2025);
  assert.equal(project.duration, '02:15:30');
  assert.equal(project.airdate, '2025-04-01');
  for (const key of ['genre', 'language', 'productionNo', 'bgComposer', 'submittedBy']) assert.equal(project[key], upload.movieDetails[key]);
  for (const key of ['producer', 'director', 'company', 'cast']) assert.equal(project.periods[0][key], upload.movieDetails[key]);
  assert.equal(upload.episode, null);
  assert.equal(upload.destinationCreated, true);
});

test('blank movie details fall back to workfile duration/date and inferred year', () => {
  const { context } = importHarness();
  const project = context.bulkProject(session({ movieDetails: {} }), { projects: [] }, new Map());
  assert.equal(project.duration, '01:30:00');
  assert.equal(project.airdate, '10 Apr 2021');
  assert.equal(project.year, 2021);
  assert.equal(project.periods[0].director, '');
});

test('reimport never overwrites existing movie metadata with batch details or fixed cells', () => {
  const { context } = importHarness(), workspace = { projects: [] };
  const project = context.bulkProject(session(), workspace, new Map());
  const before = JSON.parse(JSON.stringify(project));
  const repeat = session({ movieDetails: { year: '2026', duration: '03:00:00', director: 'Replacement', submittedBy: 'Replacement' } });
  repeat.workfile.totalDurationSeconds = 100;
  repeat.workfile.date = '20 May 2026';
  repeat.workfile.episodeNumber = 5;
  const matched = context.bulkProject(repeat, workspace, new Map());
  for (const key of ['duration', 'airdate', 'year', 'submittedBy', 'workNumber']) assert.equal(matched[key], before[key]);
  assert.deepEqual(JSON.parse(JSON.stringify(matched.periods)), before.periods);
  assert.equal(workspace.projects.length, 1);
  assert.equal(repeat.destinationCreated, false);
});

test('multi-sheet series and explicitly labelled episodes ignore movie-only batch details', () => {
  const { context } = importHarness();
  for (const upload of [session({ forceSeries: true }), session({ raw: [['', '', '', '', 'Episode 1']] })]) {
    const project = context.bulkProject(upload, { projects: [] }, new Map());
    assert.equal(project.type, 'Series');
    assert.equal(project.year, 2021);
    assert.equal(project.language, '');
    assert.equal(project.periods[0].director, '');
    assert.equal(project.bgComposer, undefined);
    assert.equal(project.episodes[0].duration, '01:30:00');
  }
});

test('movie detail inputs survive rerenders and toggling type, and stay disabled during import', () => {
  const { context, listeners } = importHarness();
  listeners.input({ target: { dataset: { workfileMovieField: 'director' }, value: 'Saved <Director>' } });
  assert.match(context.bulkMovieDetailsView(), /value="Saved &lt;Director&gt;"/);
  context.importDefaultType = 'Series';
  assert.equal(context.bulkMovieDetailsView(), '');
  context.importDefaultType = 'Movie';
  assert.match(context.bulkMovieDetailsView(), /value="Saved &lt;Director&gt;"/);
  context.bulkImportActive = true;
  listeners.change({ target: { dataset: { workfileMovieField: 'director' }, value: 'Changed while importing' } });
  assert.match(context.bulkMovieDetailsView(), /<fieldset class="form-grid" disabled>/);
  assert.match(context.bulkMovieDetailsView(), /value="Saved &lt;Director&gt;"/);
});

test('invalid optional year or movie duration blocks import; blank and valid values are accepted', () => {
  const { context } = importHarness();
  assert.match(context.bulkMovieDetailsError({ year: '99' }), /production year/);
  assert.match(context.bulkMovieDetailsError({ year: '2501' }), /production year/);
  assert.match(context.bulkMovieDetailsError({ duration: '01:70:00' }), /duration/);
  assert.match(context.bulkMovieDetailsError({ duration: '00:00:00' }), /duration/);
  assert.equal(context.bulkMovieDetailsError({}), '');
  assert.equal(context.bulkMovieDetailsError({ year: '2025', duration: '02:03:04' }), '');
});
