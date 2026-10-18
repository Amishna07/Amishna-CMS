'use strict';

const { ApiError, conflict } = require('./errors');
const { validateWorkspace } = require('./validation');
const { createHash } = require('node:crypto');

const LISTS = ['works', 'projects', 'cues', 'clients', 'imports', 'exports', 'profiles', 'activity', 'members', 'repositories', 'deletedCues', 'artists'];
const ID_LISTS = new Set(LISTS.filter(kind => !['profiles', 'activity'].includes(kind)));
const INVALID = () => new ApiError(400, 'INVALID_RECORDS', 'The record changes are invalid. Refresh the database and try again.');
const cleanId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !value.includes('\0');
function safeTree(value) {
  const pending = [{value, depth: 0}];
  while (pending.length) {
    const item = pending.pop();
    if (item.depth > 90) throw INVALID();
    if (item.value && typeof item.value === 'object') for (const [key, child] of Object.entries(item.value)) {
      if (key.includes('\0') || key === '__proto__' || key === 'constructor' || key === 'prototype') throw INVALID();
      if (child && typeof child === 'object') pending.push({value: child, depth: item.depth + 1});
    }
  }
}
function validateValue(record) {
  if (record.value === null) return;
  const value = record.value;
  if (record.kind === 'projects' &&
      (typeof value.title !== 'string' || !value.title.trim() || value.type !== undefined && !['Movie', 'Series'].includes(value.type) ||
       Object.hasOwn(value, 'episodes') || value.clientId != null && value.clientId !== '' && !cleanId(value.clientId))) throw INVALID();
  if (record.kind === 'episodes' && (typeof value.title !== 'undefined' && typeof value.title !== 'string')) throw INVALID();
  if (record.kind === 'works' && (typeof value.title !== 'string' || !value.title.trim())) throw INVALID();
  if (record.kind === 'clients' && (typeof value.name !== 'string' || !value.name.trim())) throw INVALID();
  if (record.kind === 'cues') {
    if (!cleanId(value.projectId) || !cleanId(value.workId) ||
        value.episode != null && (!Number.isInteger(value.episode) || value.episode < 1)) throw INVALID();
    for (const field of ['start', 'end', 'duration'])
      if (value[field] != null && (typeof value[field] !== 'number' || !Number.isFinite(value[field]) || value[field] < 0)) throw INVALID();
    if (value.start != null && value.end != null && value.end < value.start) throw INVALID();
  }
}

class RecordStore {
  constructor(db, workspaceId) {
    this.db = db;
    this.workspaceId = workspaceId;
    db.exec(`CREATE TABLE IF NOT EXISTS workspace_state (
      workspace_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_records (
      workspace_id TEXT NOT NULL, kind TEXT NOT NULL, record_id TEXT NOT NULL,
      sort_key REAL NOT NULL, project_id TEXT, episode_number INTEGER, work_id TEXT, data TEXT NOT NULL,
      PRIMARY KEY (workspace_id, kind, record_id)
    );
    CREATE INDEX IF NOT EXISTS workspace_records_page ON workspace_records(workspace_id, kind, sort_key, record_id);
    CREATE INDEX IF NOT EXISTS workspace_cues_content ON workspace_records(workspace_id, kind, project_id, episode_number);
    CREATE TABLE IF NOT EXISTS workspace_episodes (
      workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, episode_number INTEGER NOT NULL,
      sort_key REAL NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY (workspace_id, project_id, episode_number)
    );
    CREATE INDEX IF NOT EXISTS workspace_episodes_page ON workspace_episodes(workspace_id, project_id, sort_key);
    CREATE TABLE IF NOT EXISTS workspace_mutations (
      workspace_id TEXT NOT NULL, operation_id TEXT NOT NULL, revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL, payload_hash TEXT NOT NULL DEFAULT '', PRIMARY KEY(workspace_id, operation_id)
    );`);
    if (!db.prepare('PRAGMA table_info(workspace_records)').all().some(column => column.name === 'work_id'))
      db.exec('ALTER TABLE workspace_records ADD COLUMN work_id TEXT');
    if (!db.prepare('PRAGMA table_info(workspace_mutations)').all().some(column => column.name === 'payload_hash'))
      db.exec("ALTER TABLE workspace_mutations ADD COLUMN payload_hash TEXT NOT NULL DEFAULT ''");
    this.state = db.prepare('SELECT revision, updated_at, data FROM workspace_state WHERE workspace_id = ?');
    this.upsertState = db.prepare(`INSERT INTO workspace_state(workspace_id, revision, updated_at, data) VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET revision=excluded.revision, updated_at=excluded.updated_at, data=excluded.data`);
    this.putRecord = db.prepare(`INSERT INTO workspace_records(workspace_id, kind, record_id, sort_key, project_id, episode_number, work_id, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, kind, record_id) DO UPDATE SET
      sort_key=excluded.sort_key, project_id=excluded.project_id, episode_number=excluded.episode_number,
      work_id=excluded.work_id, data=excluded.data`);
    this.deleteRecord = db.prepare('DELETE FROM workspace_records WHERE workspace_id=? AND kind=? AND record_id=?');
    this.putEpisode = db.prepare(`INSERT INTO workspace_episodes(workspace_id, project_id, episode_number, sort_key, data)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id, project_id, episode_number) DO UPDATE SET sort_key=excluded.sort_key, data=excluded.data`);
    this.deleteEpisode = db.prepare('DELETE FROM workspace_episodes WHERE workspace_id=? AND project_id=? AND episode_number=?');
  }

  exists() { return !!this.state.get(this.workspaceId); }
  revision() { const row = this.state.get(this.workspaceId); return row && {revision: row.revision, updatedAt: row.updated_at}; }

  writeFull(workspace, revision, updatedAt) {
    validateWorkspace(workspace);
    const meta = {...workspace};
    for (const kind of LISTS) delete meta[kind];
    this.db.prepare('DELETE FROM workspace_records WHERE workspace_id=?').run(this.workspaceId);
    this.db.prepare('DELETE FROM workspace_episodes WHERE workspace_id=?').run(this.workspaceId);
    for (const kind of LISTS) {
      const list = workspace[kind] || [];
      for (let index = 0; index < list.length; index++) {
        const item = list[index];
        const id = ID_LISTS.has(kind) ? item.id : String(index);
        const value = kind === 'projects' ? {...item} : item;
        if (kind === 'projects') {
          delete value.episodes;
          for (let episodeIndex = 0; episodeIndex < (item.episodes || []).length; episodeIndex++) {
            const episode = item.episodes[episodeIndex];
            this.putEpisode.run(this.workspaceId, item.id, episode.number, episodeIndex, JSON.stringify(episode));
          }
        }
        this.putRecord.run(this.workspaceId, kind, id, index,
          kind === 'cues' ? item.projectId : null, kind === 'cues' ? item.episode : null,
          kind === 'cues' ? item.workId : null, JSON.stringify(value));
      }
    }
    this.upsertState.run(this.workspaceId, revision, updatedAt, JSON.stringify(meta));
  }

  manifest() {
    const row = this.state.get(this.workspaceId);
    if (!row) return {workspace: null, revision: 0};
    const counts = Object.fromEntries(LISTS.map(kind => [kind, 0]));
    for (const entry of this.db.prepare('SELECT kind, COUNT(*) AS count FROM workspace_records WHERE workspace_id=? GROUP BY kind').all(this.workspaceId)) counts[entry.kind] = entry.count;
    counts.episodes = this.db.prepare('SELECT COUNT(*) AS count FROM workspace_episodes WHERE workspace_id=?').get(this.workspaceId).count;
    return {workspace: JSON.parse(row.data), revision: row.revision, updatedAt: row.updated_at, counts};
  }

  page(kind, offset = 0, limit = 500) {
    if (kind !== 'episodes' && !LISTS.includes(kind) || !Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw INVALID();
    const rows = kind === 'episodes'
      ? this.db.prepare('SELECT project_id, episode_number, sort_key, data FROM workspace_episodes WHERE workspace_id=? ORDER BY project_id, sort_key, episode_number LIMIT ? OFFSET ?').all(this.workspaceId, limit, offset)
      : this.db.prepare('SELECT record_id, sort_key, data FROM workspace_records WHERE workspace_id=? AND kind=? ORDER BY sort_key, record_id LIMIT ? OFFSET ?').all(this.workspaceId, kind, limit, offset);
    return {kind, offset, records: rows.map(row => kind === 'episodes'
      ? {projectId: row.project_id, number: row.episode_number, position: row.sort_key, value: JSON.parse(row.data)}
      : {id: row.record_id, position: row.sort_key, value: JSON.parse(row.data)})};
  }

  full() {
    const manifest = this.manifest();
    if (manifest.workspace === null) return {workspace: null, revision: 0};
    const workspace = manifest.workspace;
    for (const kind of LISTS) {
      workspace[kind] = [];
      for (let offset = 0; offset < manifest.counts[kind]; offset += 1000)
        workspace[kind].push(...this.page(kind, offset, 1000).records.map(row => row.value));
    }
    const projects = new Map(workspace.projects.map(project => [project.id, project]));
    for (const project of projects.values()) project.episodes = [];
    for (let offset = 0; offset < manifest.counts.episodes; offset += 1000) {
      for (const row of this.page('episodes', offset, 1000).records) projects.get(row.projectId)?.episodes.push(row.value);
    }
    return {workspace, revision: manifest.revision, updatedAt: manifest.updatedAt};
  }

  validateMutation(body) {
    if (!body || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 ||
        typeof body.operationId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(body.operationId) ||
        !Array.isArray(body.records) || body.records.length > 5000 ||
        body.meta !== undefined && (!body.meta || typeof body.meta !== 'object' || Array.isArray(body.meta))) throw INVALID();
    for (const record of body.records) {
      if (!record || (record.kind !== 'episodes' && !LISTS.includes(record.kind)) ||
          !cleanId(record.id) || record.kind === 'episodes' && (!cleanId(record.projectId) || !Number.isInteger(record.number) || record.number < 1) ||
          record.value !== null && (!record.value || typeof record.value !== 'object' || Array.isArray(record.value)) ||
          record.value !== null && (!Number.isFinite(record.position) || Math.abs(record.position) > 1e15) ||
          record.value !== null && record.kind !== 'episodes' && ID_LISTS.has(record.kind) && record.value.id !== record.id ||
          record.value !== null && record.kind === 'episodes' && record.value.number !== record.number) throw INVALID();
      if (record.value !== null) safeTree(record.value);
      validateValue(record);
    }
    if (body.meta !== undefined) {
      safeTree(body.meta);
      if (body.meta.version !== 1) throw INVALID();
    }
    return body;
  }

  patch(body) {
    this.validateMutation(body);
    const payloadHash = createHash('sha256').update(JSON.stringify([body.expectedRevision, body.records, body.meta])).digest('hex');
    const duplicate = this.db.prepare('SELECT revision, updated_at, payload_hash FROM workspace_mutations WHERE workspace_id=? AND operation_id=?')
      .get(this.workspaceId, body.operationId);
    if (duplicate) {
      if (duplicate.payload_hash && duplicate.payload_hash !== payloadHash) throw INVALID();
      return {revision: duplicate.revision, updatedAt: duplicate.updated_at, replayed: true};
    }
    const row = this.state.get(this.workspaceId);
    if (!row || row.revision !== body.expectedRevision) throw conflict(row?.revision || 0);
    const meta = body.meta === undefined ? JSON.parse(row.data) : body.meta;
    for (const kind of LISTS) if (Object.hasOwn(meta, kind)) throw INVALID();
    for (const record of body.records) {
      if (record.kind === 'episodes') {
        if (record.value === null) this.deleteEpisode.run(this.workspaceId, record.projectId, record.number);
        else this.putEpisode.run(this.workspaceId, record.projectId, record.number, record.position, JSON.stringify(record.value));
      } else if (record.value === null) this.deleteRecord.run(this.workspaceId, record.kind, record.id);
      else this.putRecord.run(this.workspaceId, record.kind, record.id, record.position,
        record.kind === 'cues' ? record.value.projectId : null,
        record.kind === 'cues' ? record.value.episode : null,
        record.kind === 'cues' ? record.value.workId : null, JSON.stringify(record.value));
    }
    // Indexed checks keep ordinary saves bounded to changed rows while catching
    // dangling content references from batch deletions and imports.
    const dangling = this.db.prepare(`SELECT c.record_id FROM workspace_records c
      LEFT JOIN workspace_records p ON p.workspace_id=c.workspace_id AND p.kind='projects' AND p.record_id=c.project_id
      LEFT JOIN workspace_records w ON w.workspace_id=c.workspace_id AND w.kind='works' AND w.record_id=c.work_id
      WHERE c.workspace_id=? AND c.kind='cues' AND (p.record_id IS NULL OR w.record_id IS NULL) LIMIT 1`).get(this.workspaceId);
    if (dangling) throw INVALID();
    const missingEpisode = this.db.prepare(`SELECT c.record_id FROM workspace_records c
      LEFT JOIN workspace_episodes e ON e.workspace_id=c.workspace_id AND e.project_id=c.project_id AND e.episode_number=c.episode_number
      WHERE c.workspace_id=? AND c.kind='cues' AND c.episode_number IS NOT NULL AND e.project_id IS NULL LIMIT 1`).get(this.workspaceId);
    if (missingEpisode) throw INVALID();
    const orphanEpisode = this.db.prepare(`SELECT e.project_id FROM workspace_episodes e
      LEFT JOIN workspace_records p ON p.workspace_id=e.workspace_id AND p.kind='projects' AND p.record_id=e.project_id
      WHERE e.workspace_id=? AND p.record_id IS NULL LIMIT 1`).get(this.workspaceId);
    if (orphanEpisode) throw INVALID();
    const wrongEpisodeProject = this.db.prepare(`SELECT e.project_id FROM workspace_episodes e
      JOIN workspace_records p ON p.workspace_id=e.workspace_id AND p.kind='projects' AND p.record_id=e.project_id
      WHERE e.workspace_id=? AND json_extract(p.data,'$.type')='Movie' LIMIT 1`).get(this.workspaceId);
    if (wrongEpisodeProject) throw INVALID();
    const missingClient = this.db.prepare(`SELECT p.record_id FROM workspace_records p
      LEFT JOIN workspace_records c ON c.workspace_id=p.workspace_id AND c.kind='clients' AND c.record_id=json_extract(p.data,'$.clientId')
      WHERE p.workspace_id=? AND p.kind='projects' AND json_extract(p.data,'$.clientId') IS NOT NULL AND
        json_extract(p.data,'$.clientId')<>'' AND c.record_id IS NULL LIMIT 1`).get(this.workspaceId);
    if (missingClient) throw INVALID();
    const wrongContent = this.db.prepare(`SELECT c.record_id FROM workspace_records c
      JOIN workspace_records p ON p.workspace_id=c.workspace_id AND p.kind='projects' AND p.record_id=c.project_id
      WHERE c.workspace_id=? AND c.kind='cues' AND
      ((json_extract(p.data,'$.type')='Movie' AND c.episode_number IS NOT NULL) OR
       (json_extract(p.data,'$.type')='Series' AND c.episode_number IS NULL)) LIMIT 1`).get(this.workspaceId);
    if (wrongContent) throw INVALID();
    const revision = row.revision + 1, updatedAt = new Date().toISOString();
    this.upsertState.run(this.workspaceId, revision, updatedAt, JSON.stringify(meta));
    this.db.prepare('INSERT INTO workspace_mutations(workspace_id, operation_id, revision, updated_at, payload_hash) VALUES (?, ?, ?, ?, ?)')
      .run(this.workspaceId, body.operationId, revision, updatedAt, payloadHash);
    return {revision, updatedAt};
  }
}

module.exports = { RecordStore, LISTS };
