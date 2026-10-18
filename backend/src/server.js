'use strict';

const http = require('node:http');
const path = require('node:path');
const { createApp } = require('./app');
const { SQLiteRepository } = require('./repository');

function configuration(env = process.env) {
  const port = Number(env.PORT || 4000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('PORT must be a number between 1 and 65535.');
  const frontendPort = Number(env.FRONTEND_PORT || 4175);
  if (!Number.isInteger(frontendPort) || frontendPort < 1 || frontendPort > 65535) throw Error('FRONTEND_PORT must be a number between 1 and 65535.');
  return {
    port,
    file: path.resolve(__dirname, '..', env.SQLITE_PATH || 'data/amishna.sqlite'),
    backupDirectory: path.resolve(__dirname, '../..', 'Database'),
    workspaceId: env.WORKSPACE_ID || 'main',
    frontendPort
  };
}

function start(env = process.env) {
  let settings, repository;
  try {
    settings = configuration(env);
    repository = new SQLiteRepository(settings);
  } catch {
    console.error('Backend configuration is invalid. Check the local port and database settings.');
    process.exitCode = 1;
    return null;
  }
  const trustedOrigins = ['127.0.0.1', 'localhost', '[::1]'].map(host => `http://${host}:${settings.frontendPort}`);
  const cleanOldBackups = () => {
    try { repository.pruneBackups(); }
    catch { console.warn('Old database snapshots could not be cleaned. Check the Database folder permissions.'); }
  };
  cleanOldBackups();
  const backupRetentionTimer = setInterval(cleanOldBackups, 24 * 60 * 60 * 1000);
  backupRetentionTimer.unref();
  const server = http.createServer(createApp({ repository, trustedOrigins }));
  server.requestTimeout = 120000;
  server.headersTimeout = 10000;
  server.on('error', () => {
    console.error('Backend could not listen on the configured local port. Check PORT and other running servers.');
    repository.close().catch(() => {});
    process.exitCode = 1;
  });
  let stopping = false;
  const ready = repository.ensureMigrated().then(() => {
    if (stopping) return;
    server.listen(settings.port, '127.0.0.1', () => {
      console.log(`Amishna Music API: http://127.0.0.1:${settings.port}`);
      repository.health().then(
        () => console.log(`Local SQLite database: ${settings.file}`),
        () => console.warn('Local SQLite database unavailable. Check the backend data folder.')
      );
    });
  }).catch(() => {
    console.error('The existing workspace could not be migrated safely. The original SQLite file was kept; check Database folder permissions.');
    clearInterval(backupRetentionTimer);
    repository.close().catch(() => {});
    process.exitCode = 1;
  });
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(backupRetentionTimer);
    if (server.listening) { server.close(() => repository.close().catch(() => {})); server.closeIdleConnections(); }
    else repository.close().catch(() => {});
    const timeout = setTimeout(() => { server.closeAllConnections(); repository.close().catch(() => {}); }, 10000);
    timeout.unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return { server, repository, shutdown, ready };
}

if (require.main === module) start();
module.exports = { configuration, start };
