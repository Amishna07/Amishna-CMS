'use strict';

const { Readable } = require('node:stream');
const { isCompressed } = require('../backend/src/workspace-transport');

function respond(response, status, code, message) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  });
  response.end(JSON.stringify({ error: { code, message } }));
}

function replayParsedBody(request) {
  if (!['POST', 'PUT', 'PATCH'].includes(request.method) || (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '') && !isCompressed(request))) return request;
  // Vercel may provide an already parsed body. Recreate the stream expected by
  // the local API validator, which still enforces its own JSON and size checks.
  const body = request.body;
  if (body === undefined) return request;
  if (isCompressed(request) && !Buffer.isBuffer(body)) throw new TypeError('Expected a binary workspace body.');
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const replay = Readable.from([raw]);
  replay.headers = request.headers;
  replay.method = request.method;
  replay.url = request.url;
  replay.socket = request.socket;
  return replay;
}

async function handleRequest(request, response) {
  return respond(response, 410, 'LOCAL_ONLY', 'This version runs only on your computer. Open http://127.0.0.1:4175.');
}

module.exports = { handleRequest, replayParsedBody };
