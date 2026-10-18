'use strict';

const fs = require('node:fs');
const { ApiError, tooLarge } = require('./errors');
const { validateSave, validateWorkspace } = require('./validation');
const { XLSX_TYPE, exportGoogleSheet, listGoogleSheetTabs } = require('./google-sheet');
const { createAuth, SQLiteAuthStore } = require('./auth');
const { MAX_JSON_BYTES, MAX_LOCAL_JSON_BYTES, MAX_ONLINE_BYTES, isCompressed, decodeWorkspaceBody, respondWorkspace } = require('./workspace-transport');
const { validateChanges } = require('./workspace-changes');
const MAX_BODY_BYTES = MAX_JSON_BYTES;
const loopbackNames = new Set(['localhost', '127.0.0.1', '[::1]']);
const loopbackHost = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;
const publicHost = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/i;

function respond(response, status, body, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    ...headers
  });
  response.end(JSON.stringify(body));
}

function allowedOrigin(origin, request, trustedOrigins, allowPublicHost) {
  const host = request.headers.host || '';
  const local = loopbackHost.test(host);
  // A public write must come from the dashboard in a browser. Vercel's
  // deployment protection adds an outer gate; the API also validates its session.
  if (!origin) return local || !allowPublicHost || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method);
  try {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    if (local) {
      const ownOrigin = `${request.socket.encrypted ? 'https' : 'http'}://${host}`;
      return loopbackNames.has(url.hostname) && (origin === ownOrigin || trustedOrigins.includes(origin));
    }
    return allowPublicHost && origin === `https://${host}`;
  } catch {
    return false;
  }
}

async function readJson(request, maxBodyBytes, tooLargeError = tooLarge, { compressed = false, maxWireBytes = maxBodyBytes } = {}) {
  const zipped = compressed && isCompressed(request);
  if (!zipped && !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    throw new ApiError(415, 'JSON_REQUIRED', 'Use Content-Type: application/json.');
  }
  const wireLimit = zipped ? maxWireBytes : Math.min(maxBodyBytes, maxWireBytes);
  if (Number(request.headers['content-length']) > wireLimit) {
    request.resume();
    throw tooLargeError();
  }
  const chunks = [];
  let length = 0;
  // Event listeners keep the response socket alive for a readable 413 response.
  let raw = await new Promise((resolve, reject) => {
    const clean = () => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onAborted);
    };
    const onData = chunk => {
      length += chunk.length;
      if (length > wireLimit) {
        clean();
        request.resume();
        reject(tooLargeError());
      } else chunks.push(chunk);
    };
    const onEnd = () => { clean(); resolve(Buffer.concat(chunks)); };
    const onError = () => { clean(); reject(new ApiError(400, 'INVALID_REQUEST', 'The request could not be read.')); };
    const onAborted = () => { clean(); reject(new ApiError(400, 'INVALID_REQUEST', 'The request was interrupted.')); };
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onAborted);
  });
  if (zipped) raw = await decodeWorkspaceBody(raw, maxBodyBytes);
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'The request body must contain valid JSON.');
  }
}

function createApp({ repository, auth, setupToken = process.env.AUTH_SETUP_TOKEN || '', maxBodyBytes, logger = console, trustedOrigins = ['http://127.0.0.1:4175', 'http://localhost:4175', 'http://[::1]:4175'], allowPublicHost = false, allowRemoteSheets = false, googleSheetFetch = globalThis.fetch }) {
  if (!repository) throw new TypeError('A workspace repository is required.');
  maxBodyBytes ??= allowPublicHost ? MAX_BODY_BYTES : MAX_LOCAL_JSON_BYTES;
  auth ||= createAuth({ store: new SQLiteAuthStore(repository), secure: allowPublicHost, allowLocalSetup: !allowPublicHost, setupToken });
  const readWorkspace = request => readJson(request, maxBodyBytes, tooLarge, { compressed: true, maxWireBytes: allowPublicHost ? MAX_ONLINE_BYTES : maxBodyBytes });
  return async function app(request, response) {
    try {
      if (!allowedOrigin(request.headers.origin, request, trustedOrigins, allowPublicHost) || request.headers['sec-fetch-site'] === 'cross-site') {
        throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'Access this API through the local dashboard.');
      }
      if (!loopbackHost.test(request.headers.host || '') && !(allowPublicHost && publicHost.test(request.headers.host || ''))) throw new ApiError(403, 'HOST_NOT_ALLOWED', 'Access this API through the local dashboard.');
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (await auth.handle(request, response, pathname, { readJson, respond })) return;
      const actor = await auth.requireUser(request);
      if (!allowRemoteSheets && pathname.startsWith('/api/google-sheet/'))
        throw new ApiError(410, 'LOCAL_ONLY', 'Google Sheets are disabled in the offline app. Download the workbook and import the XLSX file.');
      if (pathname === '/api/google-sheet/tabs') {
        if (request.method !== 'POST') return respond(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST for this endpoint.' } }, { Allow: 'POST' });
        const body = await readJson(request, 4096);
        return respond(response, 200, await listGoogleSheetTabs(body?.url, { fetcher: googleSheetFetch }));
      }
      if (pathname === '/api/google-sheet/export') {
        if (request.method !== 'POST') return respond(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST for this endpoint.' } }, { Allow: 'POST' });
        const body = await readJson(request, 64 * 1024, () => new ApiError(413, 'GOOGLE_SHEET_URL_TOO_LONG', 'The Google Sheets request is too long. Choose a smaller tab range.'));
        if (typeof body?.url === 'string' && body.url.length > 2048) throw new ApiError(413, 'GOOGLE_SHEET_URL_TOO_LONG', 'The Google Sheets sharing link is too long. Copy the direct sharing link again.');
        const bytes = await exportGoogleSheet(body?.url, { fetcher: googleSheetFetch, range: body?.range });
        response.writeHead(200, {
          'Content-Type': XLSX_TYPE,
          'Content-Disposition': 'attachment; filename="google-sheet.xlsx"',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
          'Referrer-Policy': 'no-referrer'
        });
        // Stream the validated workbook in bounded chunks. Vercel's ordinary
        // buffered Function response limit is smaller than the XLSX import cap.
        for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
          if (response.destroyed) return;
          if (!response.write(bytes.subarray(offset, offset + 64 * 1024))) {
            await new Promise(resolve => {
              const ready = () => { response.off('drain', ready); response.off('close', ready); resolve(); };
              response.once('drain', ready);
              response.once('close', ready);
            });
          }
        }
        if (!response.destroyed) return response.end();
        return;
      }
      if (pathname === '/api/workspace/validate') {
        if (request.method !== 'POST') return respond(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST for this endpoint.' } }, { Allow: 'POST' });
        const body = await readWorkspace(request);
        validateWorkspace(body?.workspace);
        return respond(response, 200, { valid: true });
      }
      if (pathname === '/api/health') {
        if (request.method !== 'GET') return respond(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET for this endpoint.' } }, { Allow: 'GET' });
        try {
          return respond(response, 200, await repository.health());
        } catch {
          logger.warn?.('Database health check failed.');
          return respond(response, 503, { status: 'unavailable', database: 'disconnected', error: { code: 'DATABASE_UNAVAILABLE', message: 'The local database is unavailable. Check the backend data folder.' } });
        }
      }
      if (pathname === '/api/database/backup') {
        if (request.method !== 'POST') return respond(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST for this endpoint.' } }, { Allow: 'POST' });
        if (actor.role !== 'admin') throw new ApiError(403, 'ADMIN_REQUIRED', 'Only an administrator can download the SQLite database.');
        if (allowPublicHost || typeof repository.createBackup !== 'function') throw new ApiError(410, 'LOCAL_ONLY', 'SQLite downloads are available in the local app.');
        const snapshot = await repository.createBackup();
        response.writeHead(200, {
          'Content-Type': 'application/vnd.sqlite3',
          'Content-Length': snapshot.bytes,
          'Content-Disposition': `attachment; filename="${snapshot.filename}"`,
          'X-Database-Backup-Name': snapshot.filename,
          'X-Database-Revision': String(snapshot.revision),
          ...(snapshot.retentionWarning ? { 'X-Database-Retention-Warning': 'cleanup-failed' } : {}),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
          'Referrer-Policy': 'no-referrer'
        });
        const stream = fs.createReadStream(snapshot.path);
        stream.on('error', () => response.destroy());
        response.on('close', () => stream.destroy());
        stream.pipe(response);
        return;
      }
      if (!allowPublicHost && pathname === '/api/workspace/manifest') {
        if (request.method !== 'GET') return respond(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET for this endpoint.' } }, { Allow: 'GET' });
        return respond(response, 200, await repository.getManifest());
      }
      if (!allowPublicHost && pathname === '/api/workspace/revision') {
        if (request.method !== 'GET') return respond(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET for this endpoint.' } }, { Allow: 'GET' });
        return respond(response, 200, await repository.getRevision());
      }
      if (!allowPublicHost && pathname === '/api/workspace/records') {
        if (request.method === 'GET') {
          const query = new URL(request.url, 'http://localhost').searchParams;
          return respond(response, 200, await repository.getPage(query.get('kind'), Number(query.get('offset') || 0), Number(query.get('limit') || 500)));
        }
        if (request.method === 'PATCH') {
          const body = await readJson(request, 8 * 1024 * 1024);
          return respond(response, 200, await repository.patchRecords(body));
        }
        return respond(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or PATCH for this endpoint.' } }, { Allow: 'GET, PATCH' });
      }
      if (pathname !== '/api/workspace') throw new ApiError(404, 'NOT_FOUND', 'API endpoint not found.');
      if (request.method === 'GET') return await respondWorkspace(response, await repository.get());
      if (request.method === 'PUT') {
        const { workspace, expectedRevision } = validateSave(await readWorkspace(request));
        const result=await repository.put(workspace, expectedRevision);
        const latest=workspace.activity?.[0]?.text||'';
        if(latest.startsWith('Database import ·'))logger.info?.('Database import saved.',{revision:result.revision});
        return await respondWorkspace(response, result);
      }
      if (request.method === 'PATCH') {
        const { changes, expectedRevision } = validateChanges(await readWorkspace(request));
        return respond(response, 200, await repository.patch(changes, expectedRevision));
      }
      return respond(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET, PUT or PATCH for this endpoint.' } }, { Allow: 'GET, PUT, PATCH' });
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) { response.destroy(); return; }
      const known = error instanceof ApiError;
      if(!known||error.status>=500)logger.error?.('API request failed.',{code:known?error.code:'INTERNAL_ERROR',status:known?error.status:500,method:request.method});
      respond(response, known ? error.status : 500, {
        error: {
          code: known ? error.code : 'INTERNAL_ERROR',
          message: known ? error.message : 'The request could not be completed.',
          ...(known ? error.details : {})
        }
      });
    }
  };
}

module.exports = { createApp, MAX_BODY_BYTES };
