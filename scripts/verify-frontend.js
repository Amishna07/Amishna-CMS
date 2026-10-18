'use strict';
// This distribution serves the maintained public bundle directly; no missing source build is needed.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const publicRoot = path.resolve(__dirname, '../frontend/public');
let checks = 0;
function asset(reference, from) {
  if (/^(?:data:|https?:|#)/i.test(reference)) return;
  const file = path.resolve(path.dirname(from), reference.split(/[?#]/)[0]);
  if (!file.startsWith(publicRoot + path.sep) || !fs.statSync(file).isFile()) throw new Error('Missing or invalid frontend asset: ' + reference);
  checks++;
}
try {
  const index = path.join(publicRoot, 'index.html');
  for (const match of fs.readFileSync(index, 'utf8').matchAll(/(?:src|href)="([^"]+)"/g)) asset(match[1], index);
  for (const name of fs.readdirSync(publicRoot)) {
    const file = path.join(publicRoot, name);
    if (name.endsWith('.js')) { new vm.Script(fs.readFileSync(file, 'utf8'), { filename: name }); checks++; }
    if (name.endsWith('.css')) for (const match of fs.readFileSync(file, 'utf8').matchAll(/url\(\s*['"]?([^'"\s)]+)['"]?\s*\)/g)) asset(match[1], file);
  }
  for (const name of ['IPRS-verification.xlsx', 'PRS-verification.xlsx', 'ASCAP-verification.xlsx', 'Fixed-Workfile-Template.xlsx']) asset(name, index);
  console.log('Frontend verified: ' + checks + ' syntax and local asset checks. The public bundle is ready to serve.');
} catch (error) {
  console.error('Frontend verification failed: ' + error.message);
  process.exitCode = 1;
}
