'use strict';

const { ApiError } = require('./errors');
const { validateWorkspace } = require('./validation');

const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
const invalid = () => new ApiError(400, 'INVALID_CHANGES', 'The workspace changes are invalid. Reload the database copy and try again.');

function validateChanges(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 ||
      body.expectedRevision >= Number.MAX_SAFE_INTEGER ||
      !Array.isArray(body.changes) || body.changes.length > 10000) throw invalid();
  for (const change of body.changes) {
    if (!change || typeof change !== 'object' || Array.isArray(change) ||
        !['set', 'remove', 'splice'].includes(change.op) ||
        !Array.isArray(change.path) || !change.path.length || change.path.length > 90 ||
        change.path.some(segment => typeof segment !== 'string' && !Number.isSafeInteger(segment) ||
          typeof segment === 'string' && (unsafeKeys.has(segment) || segment.includes('\0')) ||
          typeof segment === 'number' && segment < 0)) throw invalid();
    if (change.op === 'set' && !Object.hasOwn(change, 'value')) throw invalid();
    if (change.op === 'splice' && (!Number.isSafeInteger(change.index) || change.index < 0 ||
        !Number.isSafeInteger(change.deleteCount) || change.deleteCount < 0 ||
        !Array.isArray(change.items) || change.items.length > 10000)) throw invalid();
  }
  return body;
}

function applyChanges(workspace, changes) {
  const next = structuredClone(workspace);
  const locate = path => {
    let value = next;
    for (const segment of path) {
      if (Array.isArray(value)) {
        if (typeof segment !== 'number' || segment >= value.length) throw invalid();
      } else if (!value || typeof value !== 'object' || typeof segment !== 'string' || !Object.hasOwn(value, segment)) throw invalid();
      value = value[segment];
    }
    return value;
  };
  for (const change of changes) {
    if (change.op === 'splice') {
      const target = locate(change.path);
      if (!Array.isArray(target) || change.index > target.length || change.deleteCount > target.length - change.index) throw invalid();
      const replacement = target.slice(0, change.index).concat(change.items, target.slice(change.index + change.deleteCount));
      target.length = 0;
      for (const item of replacement) target.push(item);
      continue;
    }
    const parent = locate(change.path.slice(0, -1));
    const key = change.path.at(-1);
    if (Array.isArray(parent)) {
      if (typeof key !== 'number' || key >= parent.length || change.op !== 'set') throw invalid();
    } else if (!parent || typeof parent !== 'object' || typeof key !== 'string' ||
        change.op === 'remove' && !Object.hasOwn(parent, key)) throw invalid();
    if (change.op === 'set') parent[key] = change.value;
    else delete parent[key];
  }
  return validateWorkspace(next);
}

module.exports = { validateChanges, applyChanges };
