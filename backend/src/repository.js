'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ApiError, unavailable, conflict } = require('./errors');
const { applyChanges } = require('./workspace-changes');
const { RecordStore } = require('./record-store');
const BACKUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function backupTime(filename) {
  const match = /^Amishna_Database_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})-(\d{3})(?:_\d+)?\.sqlite$/.exec(filename);
  if (!match) return null;
  const values = match.slice(1, 8).map(Number);
  const [year, month, day, hour, minute, second, millisecond] = values;
  const date = new Date(year, month - 1, day, hour, minute, second, millisecond);
  if ([date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()]
    .some((value, index) => value !== values[index])) return null;
  return date.getTime();
}

class SQLiteRepository {
  constructor({ file, workspaceId = 'main', backupDirectory = path.join(path.dirname(file), 'Database') }) {
    if (!file || !workspaceId) throw new TypeError('A local SQLite file and workspace ID are required.');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.file = file;
    this.backupDirectory = backupDirectory;
    this.workspaceId = workspaceId;
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS workspaces (
      workspace_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL
    )`);
    this.read = this.db.prepare('SELECT revision, updated_at, data FROM workspaces WHERE workspace_id = ?');
    this.insert = this.db.prepare('INSERT INTO workspaces (workspace_id, revision, updated_at, data) VALUES (?, ?, ?, ?)');
    this.update = this.db.prepare('UPDATE workspaces SET revision = ?, updated_at = ?, data = ? WHERE workspace_id = ? AND revision = ?');
    this.records = new RecordStore(this.db, this.workspaceId);
    this.migration = null;
  }

  async health() {
    try {
      this.db.prepare('SELECT 1').get();
      return { status: 'ok', database: 'connected', storage: 'SQLite' };
    } catch { throw unavailable(); }
  }

  async get() {
    try {
      await this.ensureMigrated();
      if (this.records.exists()) return this.records.full();
      const row = this.read.get(this.workspaceId);
      return row ? { workspace: JSON.parse(row.data), revision: row.revision, updatedAt: row.updated_at }
        : { workspace: null, revision: 0 };
    } catch { throw unavailable(); }
  }

  async ensureMigrated() {
    if (this.records.exists()) return;
    if (this.migration) return this.migration;
    const row = this.read.get(this.workspaceId);
    if (!row) return;
    let workspace;
    try { workspace = JSON.parse(row.data); } catch { return; }
    if (!workspace || workspace.version !== 1 || !['works', 'projects', 'cues', 'clients', 'imports', 'exports', 'profiles', 'activity']
      .every(kind => Array.isArray(workspace[kind]))) return;
    this.migration = (async () => {
      // The old JSON row and accounts are captured before any new table is filled.
      await this.createBackup();
      this.transaction(() => this.records.writeFull(workspace, row.revision, row.updated_at));
    })();
    try { await this.migration; }
    finally { this.migration = null; }
  }

  transaction(action) {
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
      if (error instanceof ApiError) throw error;
      throw unavailable();
    }
  }

  write(workspace, expectedRevision, { metadataOnly = false } = {}) {
    const current = this.read.get(this.workspaceId);
    if ((current?.revision || 0) !== expectedRevision) throw conflict(current?.revision || 0);
    const revision = expectedRevision + 1;
    const updatedAt = new Date().toISOString();
    const data = JSON.stringify(workspace);
    if (current) this.update.run(revision, updatedAt, data, this.workspaceId, expectedRevision);
    else this.insert.run(this.workspaceId, revision, updatedAt, data);
    return metadataOnly ? { revision, updatedAt } : { workspace, revision, updatedAt };
  }

  async put(workspace, expectedRevision) {
    await this.ensureMigrated();
    if (this.records.exists() || workspace?.version === 1 && Array.isArray(workspace?.works)) {
      return this.transaction(() => {
        const current = this.records.revision();
        const currentRevision = current?.revision ?? this.read.get(this.workspaceId)?.revision ?? 0;
        if (currentRevision !== expectedRevision) throw conflict(currentRevision);
        const revision = expectedRevision + 1, updatedAt = new Date().toISOString();
        this.records.writeFull(workspace, revision, updatedAt);
        return {workspace, revision, updatedAt};
      });
    }
    return this.transaction(() => this.write(workspace, expectedRevision));
  }

  async patch(changes, expectedRevision) {
    await this.ensureMigrated();
    if (this.records.exists()) {
      return this.transaction(() => {
        const current = this.records.full();
        if (current.revision !== expectedRevision) throw conflict(current.revision);
        const workspace = applyChanges(current.workspace, changes);
        const revision = expectedRevision + 1, updatedAt = new Date().toISOString();
        this.records.writeFull(workspace, revision, updatedAt);
        return {revision, updatedAt};
      });
    }
    return this.transaction(() => {
      const current = this.read.get(this.workspaceId);
      if ((current?.revision || 0) !== expectedRevision) throw conflict(current?.revision || 0);
      if (!current) throw conflict(0);
      return this.write(applyChanges(JSON.parse(current.data), changes), expectedRevision, { metadataOnly: true });
    });
  }

  async getManifest() {
    await this.ensureMigrated();
    return this.records.exists() ? this.records.manifest()
      : {workspace: null, revision: this.read.get(this.workspaceId)?.revision || 0};
  }

  async getPage(kind, offset, limit) {
    await this.ensureMigrated();
    return this.records.page(kind, offset, limit);
  }

  async getRevision() {
    await this.ensureMigrated();
    return this.records.revision() || {revision: this.read.get(this.workspaceId)?.revision || 0};
  }

  async patchRecords(body) {
    await this.ensureMigrated();
    return this.transaction(() => this.records.patch(body));
  }

  pruneBackups(now = Date.now()) {
    if (!Number.isFinite(now)) throw new TypeError('A valid retention time is required.');
    let entries;
    try { entries = fs.readdirSync(this.backupDirectory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return { removed: 0, kept: 0 }; throw error; }
    const snapshots = entries.filter(entry => entry.isFile()).map(entry => ({ name: entry.name, time: backupTime(entry.name) }))
      .filter(entry => entry.time !== null).sort((left, right) => right.time - left.time || right.name.localeCompare(left.name));
    const newest = snapshots[0]?.name;
    let removed = 0;
    for (const snapshot of snapshots) {
      if (snapshot.name === newest || snapshot.time >= now - BACKUP_RETENTION_MS) continue;
      fs.unlinkSync(path.join(this.backupDirectory, snapshot.name));
      removed++;
    }
    return { removed, kept: snapshots.length - removed, newest: newest || null };
  }

  async createBackup() {
    const now = new Date();
    const parts = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')];
    const clock = [now.getHours(), now.getMinutes(), now.getSeconds()].map(value => String(value).padStart(2, '0'));
    const stamp = `${parts.join('-')}_${clock.join('-')}-${String(now.getMilliseconds()).padStart(3, '0')}`;
    fs.mkdirSync(this.backupDirectory, { recursive: true });
    let suffix = 0, filename;
    do { filename = `Amishna_Database_${stamp}${suffix ? '_' + suffix : ''}.sqlite`; suffix++; }
    while (fs.existsSync(path.join(this.backupDirectory, filename)));
    const destination = path.join(this.backupDirectory, filename);
    const partial = destination + '.partial';
    try {
      // VACUUM INTO makes a transactionally consistent copy, including WAL data.
      // Node's experimental async backup helper can abort the local runtime.
      this.db.prepare('VACUUM INTO ?').run(partial);
      const snapshot = new DatabaseSync(partial, { readOnly: true });
      let revision;
      try {
        if (snapshot.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Backup integrity check failed.');
        revision = snapshot.prepare('SELECT revision FROM workspace_state WHERE workspace_id = ?').get(this.workspaceId)?.revision
          ?? snapshot.prepare('SELECT revision FROM workspaces WHERE workspace_id = ?').get(this.workspaceId)?.revision ?? 0;
      } finally { snapshot.close(); }
      fs.renameSync(partial, destination);
      const result = { path: destination, filename, bytes: fs.statSync(destination).size, revision };
      try { result.retention = this.pruneBackups(now.getTime()); }
      catch { result.retentionWarning = true; }
      return result;
    } catch (error) {
      try { fs.rmSync(partial, { force: true }); } catch { /* Keep the original failure. */ }
      throw unavailable();
    }
  }

  async close() { this.db.close(); }
}

module.exports = { SQLiteRepository };
