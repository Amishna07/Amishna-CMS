'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { SQLiteRepository } = require('../backend/src/repository');
const { configuration } = require('../backend/src/server');

const root = path.resolve(__dirname, '..');
const transferRoot = path.join(root, 'Manual-Transfer');
const backendEnv = path.join(root, 'backend', '.env');
const frontendEnv = path.join(root, 'frontend', '.env');
const sevenDays = 7 * 24 * 60 * 60 * 1000;
const snapshotName = /^Amishna_Database_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}(?:_\d+)?\.sqlite$/;

function copyLocalConfig(source, target) {
  if (!fs.existsSync(source)) {
    // Remove an earlier generated copy so the transfer kit matches current settings.
    fs.rmSync(target, { force: true });
    return false;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o600);
  return true;
}

function pruneTransferSnapshots(directory, now = Date.now()) {
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && snapshotName.test(entry.name))
    .map(entry => ({ name: entry.name, modified: fs.statSync(path.join(directory, entry.name)).mtimeMs }))
    .sort((left, right) => right.modified - left.modified || right.name.localeCompare(left.name));
  for (const entry of entries.slice(1)) {
    if (entry.modified < now - sevenDays) fs.unlinkSync(path.join(directory, entry.name));
  }
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or later is required.');
  if (fs.existsSync(backendEnv)) process.loadEnvFile(backendEnv);
  const settings = configuration(process.env);
  if (!fs.existsSync(settings.file)) throw new Error(`No local SQLite database found at ${settings.file}. Start the app and save the workspace first.`);

  const repository = new SQLiteRepository(settings);
  let snapshot;
  try {
    await repository.ensureMigrated();
    snapshot = await repository.createBackup();
  } finally {
    await repository.close();
  }

  const transferDatabase = path.join(transferRoot, 'Database');
  fs.mkdirSync(transferDatabase, { recursive: true });
  const destination = path.join(transferDatabase, snapshot.filename);
  fs.copyFileSync(snapshot.path, destination);
  fs.chmodSync(destination, 0o600);
  pruneTransferSnapshots(transferDatabase);

  const config = path.join(transferRoot, 'Config');
  const copied = [
    copyLocalConfig(backendEnv, path.join(config, 'backend.env')) && 'backend/.env',
    copyLocalConfig(frontendEnv, path.join(config, 'frontend.env')) && 'frontend/.env'
  ].filter(Boolean);
  console.log(`Transfer database: ${destination}`);
  console.log(`SQLite revision: ${snapshot.revision}; size: ${snapshot.bytes} bytes`);
  console.log(`Custom settings copied: ${copied.length ? copied.join(', ') : 'none (defaults are used)'}`);
  console.log('Copy the Manual-Transfer folder privately. Its data is excluded from GitHub.');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
