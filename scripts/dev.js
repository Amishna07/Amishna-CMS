'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error('Node.js 24 or newer is required for the local SQLite database.');
  process.exit(1);
}
const root = path.resolve(__dirname, '..');
const mode = process.argv[2] || 'all';
if (!['all', 'frontend', 'backend'].includes(mode)) {
  console.error('Use: node scripts/dev.js [all|frontend|backend]');
  process.exit(1);
}

const children = [];
let stopping = false;
function launch(directory, entry) {
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', entry], {
    cwd: path.join(root, directory), stdio: 'inherit', windowsHide: true, env: process.env
  });
  children.push(child);
  child.on('error', error => { console.error(`Could not start ${directory}: ${error.message}`); stop(1); });
  child.on('exit', (code, signal) => {
    if (!stopping) { console.error(`${directory} stopped${signal ? ` (${signal})` : '.'}`); stop(code || 1); }
  });
}
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
}
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
if (mode !== 'frontend') launch('backend', 'src/server.js');
if (mode !== 'backend') launch('frontend', 'server.js');
