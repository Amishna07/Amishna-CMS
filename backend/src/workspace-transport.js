'use strict';

const { gunzip } = require('node:zlib');
const { promisify } = require('node:util');
const { ApiError } = require('./errors');

const unzip = promisify(gunzip);
const MAX_JSON_BYTES = 12 * 1024 * 1024;
const MAX_LOCAL_JSON_BYTES = 64 * 1024 * 1024;
const MAX_ONLINE_BYTES = 4 * 1024 * 1024;
const isCompressed = request => /^application\/octet-stream(?:\s*;|$)/i.test(request.headers['content-type'] || '') && request.headers['x-workspace-encoding'] === 'gzip';

async function decodeWorkspaceBody(raw, maxBytes) {
  try {
    return await unzip(raw, { maxOutputLength: maxBytes });
  } catch (error) {
    if (error.code === 'ERR_BUFFER_TOO_LARGE') throw new ApiError(413, 'WORKSPACE_TOO_LARGE', `The workspace request exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB saving limit. Download a backup before reducing its size.`);
    throw new ApiError(400, 'INVALID_COMPRESSION', 'The compressed workspace could not be read. Try saving again.');
  }
}

// Streaming avoids the hosted buffered-response limit for workspace reads and
// save acknowledgements. Encode first so multibyte text is never split badly.
async function respondWorkspace(response, body) {
  const raw = Buffer.from(JSON.stringify(body));
  response.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer'
  });
  for (let offset = 0; offset < raw.length; offset += 64 * 1024) {
    if (response.destroyed) return;
    if (!response.write(raw.subarray(offset, offset + 64 * 1024))) {
      await new Promise(resolve => {
        const ready = () => { response.off('drain', ready); response.off('close', ready); resolve(); };
        response.once('drain', ready);
        response.once('close', ready);
      });
    }
  }
  if (!response.destroyed) response.end();
}

module.exports = { MAX_JSON_BYTES, MAX_LOCAL_JSON_BYTES, MAX_ONLINE_BYTES, isCompressed, decodeWorkspaceBody, respondWorkspace };
