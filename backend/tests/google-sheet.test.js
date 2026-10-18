'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const JSZip = require('../../frontend/public/vendor/jszip.min.js');
const { createFrontendServer } = require('../../frontend/server');
const { createApp } = require('../src/app');
const { sheetIdFromUrl, exportGoogleSheet, listGoogleSheetTabs, XLSX_TYPE } = require('../src/google-sheet');
const XLSX = require('../../frontend/public/vendor/xlsx.full.min.js');

const ID = 'abcDEF0123456789_-abcDEF0123456789';
const LINK = `https://docs.google.com/spreadsheets/d/${ID}/edit?usp=sharing#gid=0`;
const original = async () => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('xl/workbook.xml', '<workbook/>');
  zip.file('xl/worksheets/sheet1.xml', '<worksheet/>');
  return Buffer.from(await zip.generateAsync({ type: 'uint8array' }));
};
const response = (body, status = 200, headers = {}) => new Response(body, { status, headers });

let largeWorkbook;
async function manyTabs() {
  if (!largeWorkbook) largeWorkbook = (async () => {
    const workbook = XLSX.utils.book_new();
    for (let number = 1; number <= 745; number++) XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([[number, '00:01:00']]), 'Episode ' + number);
    const zip = await JSZip.loadAsync(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
    for (let index = 1; index <= 1500; index++) zip.file('xl/extra/part' + index + '.xml', '<part/>');
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  })();
  return largeWorkbook;
}

test('745-tab workbook can be listed and narrowed before ordinary import limits apply', async () => {
  const bytes = await manyTabs(), fetcher = async () => response(bytes);
  await assert.rejects(exportGoogleSheet(LINK, { fetcher }), error => error.code === 'GOOGLE_SHEET_TOO_LARGE');
  const list = await listGoogleSheetTabs(LINK, { fetcher });
  assert.equal(list.tabs.length, 745);
  assert.equal(list.maxSelected, 250);
  assert.equal(list.sourceBytes, bytes.length);
  assert.equal(list.maxFileBytes, 10 * 1024 * 1024);
  assert.deepEqual(list.tabs[699], { number: 700, name: 'Episode 700' });
  const selected = await exportGoogleSheet(LINK, { fetcher, range: { from: 700, to: 702, expectedTabs: ['Episode 700', 'Episode 701', 'Episode 702'] } });
  const workbook = XLSX.read(selected, { type: 'buffer' });
  assert.deepEqual(workbook.SheetNames, ['Episode 700', 'Episode 701', 'Episode 702']);
  assert.equal(workbook.Sheets['Episode 700'].A1.v, 700);
  assert.equal(workbook.Sheets['Episode 702'].B1.v, '00:01:00');
});

test('invalid tab ranges fail before fetch and reordered tabs require a fresh selection', async () => {
  for (const range of [null, {}, { from: 0, to: 2 }, { from: 2, to: 1 }, { from: 1, to: 251 }, { from: 1.5, to: 2 }, { from: 1, to: 2, expectedTabs: 'wrong' }]) {
    await assert.rejects(exportGoogleSheet(LINK, { range, fetcher: () => assert.fail('must not fetch') }), error => error.code === 'INVALID_GOOGLE_SHEET_RANGE');
  }
  const bytes = await manyTabs(), fetcher = async () => response(bytes);
  for (const range of [{ from: 745, to: 746 }, { from: 1, to: 1, expectedTabs: ['Renamed tab'] }]) {
    await assert.rejects(exportGoogleSheet(LINK, { range, fetcher }), error => error.code === 'GOOGLE_SHEET_TABS_CHANGED');
  }
});

test('tab-list endpoint and range export endpoint expose only the chosen workbook', async t => {
  const bytes = await manyTabs(), app = await fixture(t, async () => response(bytes));
  const post = (path, body) => fetch(app.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const list = await post('/api/google-sheet/tabs', { url: LINK });
  assert.equal(list.status, 200);
  assert.equal((await list.json()).tabs.length, 745);
  const selected = await post('/api/google-sheet/export', { url: LINK, range: { from: 745, to: 745 } });
  assert.equal(selected.status, 200);
  assert.deepEqual(XLSX.read(await selected.arrayBuffer(), { type: 'array' }).SheetNames, ['Episode 745']);
  assert.equal((await fetch(app.base + '/api/google-sheet/tabs')).status, 405);
  assert.equal((await post('/api/google-sheet/tabs', { url: LINK, extra: '' })).headers.get('cache-control'), 'no-store');
});

async function fixture(t, fetcher, options = {}) {
  const repository = { get: async () => ({ workspace: null, revision: 0 }) };
  const server = http.createServer(createApp({ repository, auth: { handle: async () => false, requireUser: async () => ({ id: 'test-user', role: 'admin' }) }, allowRemoteSheets: true, googleSheetFetch: fetcher, logger: { error() {} }, ...options }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, headers = {}) => fetch(base + '/api/google-sheet/export', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ url })
  });
  return { base, post };
}

test('only Google Sheets sharing links can become export URLs', () => {
  assert.equal(sheetIdFromUrl(LINK), ID);
  assert.equal(sheetIdFromUrl(`https://docs.google.com/spreadsheets/d/${ID}`), ID);
  assert.equal(sheetIdFromUrl(`https://docs.google.com/spreadsheets/d/${ID}/edit?resourcekey=0-AbC_123`), ID);
  for (const url of [
    `http://docs.google.com/spreadsheets/d/${ID}/edit`,
    `https://docs.google.com.evil.test/spreadsheets/d/${ID}/edit`,
    `https://docs.google.com@evil.test/spreadsheets/d/${ID}/edit`,
    `https://docs.google.com:444/spreadsheets/d/${ID}/edit`,
    `https://drive.google.com/spreadsheets/d/${ID}/edit`,
    `https://docs.google.com/spreadsheets/d/${ID}/export?format=xlsx`,
    `https://docs.google.com/spreadsheets/d/${ID}/edit?resourcekey=bad%21key`,
    'https://127.0.0.1/private',
    'garbage'
  ]) assert.throws(() => sheetIdFromUrl(url), error => error.code === 'INVALID_GOOGLE_SHEET_URL');
});

test('export endpoint returns valid XLSX bytes without changing the workspace', async t => {
  const xlsx = await original(), calls = [];
  const app = await fixture(t, async (url, options) => {
    calls.push({ url, options });
    return response(xlsx, 200, { 'Content-Type': XLSX_TYPE });
  });
  const result = await app.post(LINK);
  assert.equal(result.status, 200);
  assert.match(result.headers.get('content-type'), /spreadsheetml/);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), xlsx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://docs.google.com/spreadsheets/d/${ID}/export?format=xlsx`);
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].options.credentials, 'omit');
});

test('resource keys from link-shared Sheets are forwarded only to Google', async () => {
  const xlsx = await original(), calls = [];
  await exportGoogleSheet(`https://docs.google.com/spreadsheets/d/${ID}/edit?resourcekey=0-AbC_123`, {
    fetcher: async url => { calls.push(url); return response(xlsx); }
  });
  assert.equal(calls[0], `https://docs.google.com/spreadsheets/d/${ID}/export?format=xlsx&resourcekey=0-AbC_123`);
});

test('local frontend proxy forwards the export endpoint', async t => {
  const xlsx = await original();
  const backend = await fixture(t, async () => response(xlsx));
  const proxy = createFrontendServer({ apiTarget: backend.base });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(async () => { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); });
  const result = await fetch(`http://127.0.0.1:${proxy.address().port}/api/google-sheet/export`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: LINK })
  });
  assert.equal(result.status, 200);
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), xlsx);
});

test('hosted Vercel-style route allows same-origin requests only', async t => {
  const xlsx = await original();
  const app = await fixture(t, async () => response(xlsx), { allowPublicHost: true });
  const own = 'https://cms-example.vercel.app';
  const headers = { Host: 'cms-example.vercel.app', Origin: own, 'Sec-Fetch-Site': 'same-origin' };
  const post = extra => new Promise((resolve, reject) => {
    const body = JSON.stringify({ url: LINK });
    const request = http.request(app.base, {
      path: '/api/google-sheet/export', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...extra }
    }, reply => {
      const chunks = [];
      reply.on('data', chunk => chunks.push(chunk));
      reply.on('end', () => resolve({ status: reply.statusCode, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
    request.end(body);
  });
  const good = await post(headers);
  assert.equal(good.status, 200);
  assert.deepEqual(good.body, xlsx);
  const bad = await post({ ...headers, Origin: 'https://attacker.example' });
  assert.equal(bad.status, 403);
});

test('same-origin guard and JSON validation run before Google fetch', async t => {
  let calls = 0;
  const app = await fixture(t, async () => { calls++; throw Error('should not fetch'); });
  const badOrigin = await app.post(LINK, { Origin: 'https://attacker.example' });
  assert.equal(badOrigin.status, 403);
  assert.equal((await badOrigin.json()).error.code, 'ORIGIN_NOT_ALLOWED');
  const badLink = await app.post('https://evil.example/');
  assert.equal(badLink.status, 400);
  assert.equal((await badLink.json()).error.code, 'INVALID_GOOGLE_SHEET_URL');
  const longLink = await app.post('x'.repeat(5000));
  assert.equal(longLink.status, 413);
  assert.equal((await longLink.json()).error.code, 'GOOGLE_SHEET_URL_TOO_LONG');
  const wrongMethod = await fetch(app.base + '/api/google-sheet/export');
  assert.equal(wrongMethod.status, 405);
  assert.equal(calls, 0);
});

test('private sheet redirects and untrusted redirect targets are blocked', async t => {
  const app = await fixture(t, async () => response(null, 302, { Location: 'https://accounts.google.com/signin' }));
  const privateResult = await app.post(LINK);
  assert.equal(privateResult.status, 403);
  assert.equal((await privateResult.json()).error.code, 'GOOGLE_SHEET_NOT_SHARED');
  const unsafe = await exportGoogleSheet(LINK, { fetcher: async () => response(null, 302, { Location: 'http://127.0.0.1/admin' }) }).catch(error => error);
  assert.equal(unsafe.code, 'GOOGLE_SHEET_NOT_SHARED');
});

test('known Googleusercontent redirect is followed, but only to HTTPS', async () => {
  const xlsx = await original(), calls = [];
  const bytes = await exportGoogleSheet(LINK, { fetcher: async url => {
    calls.push(url);
    return calls.length === 1 ? response(null, 302, { Location: 'https://doc-0s-docs.googleusercontent.com/export/file' }) : response(xlsx);
  } });
  assert.deepEqual(bytes, xlsx);
  assert.equal(calls.length, 2);
  const exportCalls = [];
  await exportGoogleSheet(LINK, { fetcher: async url => {
    exportCalls.push(url);
    return exportCalls.length === 1 ? response(null, 302, { Location: 'https://drive-data-export.usercontent.google.com/export/file' }) : response(xlsx);
  } });
  assert.equal(exportCalls.length, 2);
});

test('invalid, oversized and stalled exports fail with bounded actionable errors', async () => {
  const invalid = await exportGoogleSheet(LINK, { fetcher: async () => response('<html>Sign in</html>') }).catch(error => error);
  assert.equal(invalid.code, 'GOOGLE_SHEET_EXPORT_INVALID');
  const notWorkbook = new JSZip();
  notWorkbook.file('unrelated.txt', 'hello');
  const fakeZip = await notWorkbook.generateAsync({ type: 'uint8array' });
  const badPackage = await exportGoogleSheet(LINK, { fetcher: async () => response(fakeZip) }).catch(error => error);
  assert.equal(badPackage.code, 'GOOGLE_SHEET_EXPORT_INVALID');
  const oversized = await exportGoogleSheet(LINK, { fetcher: async () => response('x', 200, { 'Content-Length': String(10 * 1024 * 1024 + 1) }) }).catch(error => error);
  assert.equal(oversized.code, 'GOOGLE_SHEET_TOO_LARGE');
  const bomb = new JSZip();
  bomb.file('[Content_Types].xml', '<Types/>');
  bomb.file('xl/workbook.xml', '<workbook/>');
  bomb.file('xl/worksheets/sheet1.xml', 'x'.repeat(24 * 1024 * 1024 + 1));
  const compact = await bomb.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 1 } });
  const expanded = await exportGoogleSheet(LINK, { fetcher: async () => response(compact) }).catch(error => error);
  assert.equal(expanded.code, 'GOOGLE_SHEET_TOO_LARGE');
  const stalled = await exportGoogleSheet(LINK, { fetcher: async () => new Promise(() => {}), timeoutMs: 20 }).catch(error => error);
  assert.equal(stalled.code, 'GOOGLE_SHEET_TIMEOUT');
});
