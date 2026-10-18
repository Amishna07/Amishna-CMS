'use strict';

const { ApiError } = require('./errors');
const requiredLists = ['works', 'projects', 'cues', 'clients', 'imports', 'exports', 'profiles', 'activity'];
const optionalLists = ['members', 'repositories', 'deletedCues', 'artists'];
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
const isOptionalText = value => value == null || typeof value === 'string';
const isOptionalNumber = value => value == null || (typeof value === 'number' && Number.isFinite(value));

function invalid(message) {
  throw new ApiError(400, 'INVALID_WORKSPACE', message);
}

function validateWorkspace(workspace) {
  if (!isRecord(workspace) || workspace.version !== 1) invalid('workspace must be an object with version 1.');
  // Validate the whole JSON tree before consuming metadata. Object.assign in
  // clients must never interpret imported keys as prototype mutation requests.
  // Reject unsafe keys and excessively deep values before storing the JSON in SQLite.
  const stack = [{ value: workspace, depth: 0 }];
  while (stack.length) {
    const { value, depth } = stack.pop();
    if (depth > 90) invalid('Workspace data is nested too deeply.');
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (key.includes('\0') || ['__proto__', 'prototype', 'constructor'].includes(key)) invalid('Workspace data contains an unsafe object key.');
        if (child && typeof child === 'object') stack.push({ value: child, depth: depth + 1 });
      }
    }
  }
  for (const key of requiredLists) {
    if (!Array.isArray(workspace[key])) invalid(`workspace.${key} must be an array.`);
  }
  for (const key of optionalLists) {
    if (workspace[key] !== undefined && !Array.isArray(workspace[key])) invalid(`workspace.${key} must be an array.`);
  }
  for (const key of [...requiredLists, ...optionalLists]) {
    if (workspace[key]?.some(item => !isRecord(item))) invalid(`Every ${key} entry must be an object.`);
  }
  function optionalList(record, field, label, text = false) {
    if (record[field] === undefined) return;
    if (!Array.isArray(record[field]) || record[field].some(item => text ? typeof item !== 'string' : !isRecord(item))) {
      invalid(`${label} must be an array of ${text ? 'text values' : 'objects'}.`);
    }
  }
  function textFields(record, fields, label) {
    for (const field of fields) if (!isOptionalText(record[field])) invalid(`${label} ${field} must be text.`);
  }
  for (const key of ['works', 'projects', 'artists', 'clients', 'repositories']) {
    for (const item of workspace[key] || []) {
      optionalList(item, 'activity', `${key} activity`);
      for (const entry of item.activity || []) textFields(entry, ['text', 'date'], 'Activity');
    }
  }
  for (const work of workspace.works) {
    for (const field of ['alternateTitles', 'tags']) optionalList(work, field, `Work ${field}`, true);
    textFields(work, ['artist', 'album', 'label', 'language', 'releaseDate', 'source', 'notes', 'type', 'status'], 'Work');
  }
  for (const artist of workspace.artists || []) textFields(artist, ['email', 'phone', 'status', 'notes'], 'Artist');
  for (const client of workspace.clients) {
    for (const field of ['files', 'contacts']) optionalList(client, field, `Client ${field}`);
    textFields(client, ['contact', 'email', 'phone', 'status', 'notes'], 'Client');
    for (const item of client.files || []) textFields(item, ['name', 'url', 'notes'], 'Client reference');
  }
  for (const repository of workspace.repositories || []) {
    optionalList(repository, 'files', 'Repository files');
    optionalList(repository, 'references', 'Repository references');
    textFields(repository, ['name', 'description', 'status'], 'Repository');
    for (const item of repository.references || []) textFields(item, ['name', 'url', 'notes'], 'Repository reference');
  }
  for (const project of workspace.projects) {
    optionalList(project, 'productionHistory', 'Project productionHistory');
    optionalList(project, 'teamIds', 'Project teamIds', true);
    textFields(project, ['channel', 'language', 'productionNo', 'status', 'genre', 'serialType', 'bgComposer', 'submittedBy', 'notes'], 'Project');
  }
  if (workspace.preferences !== undefined && !isRecord(workspace.preferences)) invalid('Workspace preferences must be an object.');
  if (workspace.preferences?.exportDefaults !== undefined && !isRecord(workspace.preferences.exportDefaults)) invalid('Export defaults must be an object.');
  if (workspace.preferences?.exportDefaults) optionalList(workspace.preferences.exportDefaults, 'formats', 'Export default formats', true);
  for (const item of workspace.activity) {
    if (!isOptionalText(item.text) || !isOptionalText(item.date)) invalid('Activity text and date must be text.');
  }

  const ids = {};
  for (const key of ['works', 'projects', 'cues', 'clients', 'imports', 'exports', 'members', 'repositories', 'deletedCues', 'artists']) {
    ids[key] = new Set();
    for (const item of workspace[key] || []) {
      if (!isId(item.id)) invalid(`Every ${key} entry needs a nonempty string id of at most 256 characters.`);
      if (ids[key].has(item.id)) invalid(`Duplicate id in ${key}: ${item.id}.`);
      ids[key].add(item.id);
    }
  }

  const normalized = value => typeof value === 'string' ? value.trim().toLocaleLowerCase() : '';
  function uniqueText(entries, field, label) {
    const seen = new Set();
    for (const entry of entries) {
      const value = normalized(entry[field]);
      if (!value) continue;
      if (seen.has(value)) invalid(`Duplicate ${label}: ${entry[field]}.`);
      seen.add(value);
    }
  }
  uniqueText(workspace.works, 'isrc', 'Work ISRC');
  uniqueText(workspace.works, 'iswc', 'Work ISWC');
  uniqueText(workspace.works, 'tuneCode', 'Work Tune Code');
  uniqueText(workspace.artists || [], 'ipi', 'artist IPI');
  for (const society of ['IPRS','PRS','ASCAP']) {
    const seen = new Set();
    for (const work of workspace.works) {
      const value = normalized(work.societies?.[society]);
      if (!value) continue;
      if (seen.has(value)) invalid(`Duplicate ${society} Work Code: ${work.societies[society]}.`);
      seen.add(value);
    }
  }

  function reference(value, target, field) {
    if (!isId(value)) invalid(`${field} must be a nonempty string reference.`);
    if (!ids[target].has(value)) invalid(`${field} references a missing ${target} entry.`);
  }
  for (const artist of workspace.artists || []) {
    if (typeof artist.name !== 'string' || !artist.name.trim()) invalid('Artist name must be a nonempty string.');
    if (artist.ipi != null && typeof artist.ipi !== 'string') invalid('Artist IPI must be text to preserve leading zeros.');
    for (const field of ['roles', 'societies', 'aliases']) {
      if (artist[field] !== undefined && (!Array.isArray(artist[field]) || artist[field].some(value => typeof value !== 'string'))) {
        invalid(`Artist ${field} must be an array of text values.`);
      }
    }
  }
  for (const work of workspace.works) {
    if (typeof work.title !== 'string' || !work.title.trim()) invalid('Every Work needs a nonempty title.');
    for (const field of ['isrc','iswc','tuneCode']) if (work[field] != null && typeof work[field] !== 'string') invalid(`Work ${field} must be text.`);
    if (work.societies !== undefined && !isRecord(work.societies)) invalid('Work societies must be an object.');
    for (const society of ['IPRS','PRS','ASCAP']) if (!isOptionalText(work.societies?.[society])) invalid(`Work ${society} identifier must be text.`);
    if (work.parties !== undefined && (!Array.isArray(work.parties) || work.parties.some(party => !isRecord(party)))) invalid('Work parties must be an array of objects.');
    if (work.artistIds !== undefined) {
      if (!Array.isArray(work.artistIds)) invalid('Song artistIds must be an array.');
      for (const id of work.artistIds) reference(id, 'artists', 'Song artistIds');
    }
    if (Array.isArray(work.parties)) {
      for (const party of work.parties) {
        if (typeof party.name !== 'string' || !party.name.trim()) invalid('Every rights holder needs a nonempty name.');
        if (typeof party.role !== 'string' || !party.role.trim()) invalid('Every rights holder needs a nonempty role.');
        if (!isOptionalText(party.ipi) || !isOptionalText(party.society)) invalid('Rights-holder IPI and society values must be text.');
        if (party.share != null && (typeof party.share !== 'number' || !Number.isFinite(party.share) || party.share < 0 || party.share > 100)) invalid('Rights-holder share must be a number between 0 and 100 or null.');
        if (isRecord(party) && party.artistId != null && party.artistId !== '') reference(party.artistId, 'artists', 'Rights holder artistId');
      }
    }
  }
  for (const client of workspace.clients) {
    if (typeof client.name !== 'string' || !client.name.trim()) invalid('Every client needs a nonempty name.');
  }
  const projectsById = new Map(workspace.projects.map(project => [project.id, project]));
  const episodesByProject = new Map();
  for (const project of workspace.projects) {
    if (typeof project.title !== 'string' || !project.title.trim()) invalid('Every project needs a nonempty title.');
    if (project.type !== undefined && !['Movie', 'Series'].includes(project.type)) invalid('Project type must be Movie or Series.');
    if (project.year != null && project.year !== '' && (!Number.isInteger(project.year) || project.year < 1800 || project.year > 2500)) invalid('Project year must be a whole number from 1800 to 2500.');
    // Project details allow "No client"; only assigned relationships need a target.
    if (project.clientId != null && project.clientId !== '') reference(project.clientId, 'clients', 'Project clientId');
    if (project.episodes !== undefined && !Array.isArray(project.episodes)) invalid('Project episodes must be an array.');
    const episodeNumbers=new Set();for(const episode of project.episodes||[]){if(!isRecord(episode)||!Number.isInteger(episode.number)||episode.number<1)invalid('Project episodes need positive whole-number values.');if(episodeNumbers.has(episode.number))invalid(`Duplicate episode number in project ${project.id}: ${episode.number}.`);episodeNumbers.add(episode.number);}
    episodesByProject.set(project.id, episodeNumbers);
    for (const episode of project.episodes || []) textFields(episode, ['title', 'airdate'], 'Episode');
    if (project.type === 'Movie' && episodeNumbers.size) invalid(`Movie project ${project.id} cannot contain episode records.`);
    if (project.periods !== undefined && !Array.isArray(project.periods)) invalid('Project periods must be an array.');
    const periods = project.periods || [];
    for (const period of periods) {
      if (!isRecord(period) || !Number.isInteger(period.from) || !Number.isInteger(period.to) || period.from < 1 || period.to < period.from) invalid('Project periods need positive whole-number ranges with From less than or equal to To.');
      textFields(period, ['director', 'producer', 'company', 'cast'], 'Production period');
    }
    const orderedPeriods = [...periods].sort((left, right) => left.from - right.from);
    for (let index = 1; index < orderedPeriods.length; index++) {
      if (orderedPeriods[index].from <= orderedPeriods[index - 1].to) invalid(`Project periods overlap in project ${project.id}.`);
    }
  }
  for (const cue of workspace.cues) {
    reference(cue.projectId, 'projects', 'Cue projectId');
    reference(cue.workId, 'works', 'Cue workId');
    if (cue.episode != null && (!Number.isInteger(cue.episode) || cue.episode < 1)) invalid('Cue episode must be null or a positive whole number.');
    for (const field of ['start', 'end', 'duration']) {
      if (!isOptionalNumber(cue[field]) || (cue[field] != null && cue[field] < 0)) invalid(`Cue ${field} must be a nonnegative finite number or null.`);
    }
    if (cue.start != null && cue.end != null && cue.end < cue.start) invalid('Cue OUT time cannot be earlier than its IN time.');
    const project = projectsById.get(cue.projectId),projectType=project.type||(project.episodes?.length?'Series':'Movie');
    if (projectType === 'Movie' && cue.episode != null) invalid('Movie cues must not reference an episode.');
    if (projectType === 'Series' && !episodesByProject.get(cue.projectId).has(cue.episode)) invalid('Series cues must reference an existing episode in their project.');
    if (cue.usagePercent != null && (!Number.isFinite(cue.usagePercent) || cue.usagePercent < 0 || cue.usagePercent > 100)) invalid('Cue Music Usage % must be a number between 0 and 100 or null.');
  }
  for (const repository of workspace.repositories || []) {
    if (repository.projectIds !== undefined) {
      if (!Array.isArray(repository.projectIds)) invalid('Repository projectIds must be an array.');
      for (const id of repository.projectIds) reference(id, 'projects', 'Repository projectIds');
    }
  }
  for (const item of workspace.deletedCues || []) {
    if (!isRecord(item.cue) || !isId(item.cue.id)) invalid('Each deleted cue needs its original cue record and id.');
    if (!isId(item.cue.projectId) || !isId(item.cue.workId)) invalid('Deleted cue projectId and workId must be string references.');
  }

  // Leave valid imported history, snapshots, user metadata and future fields intact.
  return workspace;
}

function validateSave(body) {
  if (!isRecord(body)) throw new ApiError(400, 'INVALID_REQUEST', 'Send an object containing workspace and expectedRevision.');
  if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 || body.expectedRevision >= Number.MAX_SAFE_INTEGER) {
    throw new ApiError(400, 'INVALID_REVISION', 'expectedRevision must be a nonnegative safe integer.');
  }
  validateWorkspace(body.workspace);
  return body;
}

module.exports = { validateWorkspace, validateSave };
