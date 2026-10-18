'use strict';

const JSZip = require('../../frontend/public/vendor/jszip.min.js');
const { ApiError } = require('./errors');

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_XLSX_BYTES = 10 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 24 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 2048;
const FETCH_TIMEOUT_MS = 12000;

function sheetLinkFromUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new ApiError(400, 'INVALID_GOOGLE_SHEET_URL', 'Paste a Google Sheets sharing link.');
  let url;
  try { url = new URL(value.trim()); }
  catch { throw new ApiError(400, 'INVALID_GOOGLE_SHEET_URL', 'Paste a Google Sheets sharing link.'); }
  const match = /^\/spreadsheets\/d\/([A-Za-z0-9_-]{1,256})(?:\/(?:edit|view|preview))?\/?$/.exec(url.pathname);
  if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com' || url.port || url.username || url.password || !match) {
    throw new ApiError(400, 'INVALID_GOOGLE_SHEET_URL', 'Use a link from docs.google.com/spreadsheets/d/.');
  }
  const keys = url.searchParams.getAll('resourcekey');
  if (keys.length > 1 || (keys.length && !/^[A-Za-z0-9_-]{1,256}$/.test(keys[0]))) {
    throw new ApiError(400, 'INVALID_GOOGLE_SHEET_URL', 'The Google Sheets resource key is invalid. Copy the sharing link again.');
  }
  return { sheetId: match[1], resourceKey: keys[0] || '' };
}

const sheetIdFromUrl = value => sheetLinkFromUrl(value).sheetId;

function allowedExportUrl(value) {
  let url;
  try { url = new URL(value); }
  catch { return false; }
  return url.protocol === 'https:' && !url.port && !url.username && !url.password &&
    (url.hostname === 'docs.google.com' || /(?:^|\.)googleusercontent\.com$/.test(url.hostname) ||
      /^drive-data-export(?:-eu)?\.usercontent\.google\.com$/.test(url.hostname));
}

async function validateXlsx(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    throw new ApiError(422, 'GOOGLE_SHEET_EXPORT_INVALID', 'Google did not return an Excel workbook. Check that the sheet is shared with anyone who has the link.');
  }
  let zip;
  try { zip = await JSZip.loadAsync(bytes); }
  catch { throw new ApiError(422, 'GOOGLE_SHEET_EXPORT_INVALID', 'Google returned an unreadable workbook. Try the link again.'); }
  const entries = Object.values(zip.files).filter(entry => !entry.dir);
  if (!zip.file('[Content_Types].xml') || !zip.file('xl/workbook.xml') || !entries.some(entry => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name))) {
    throw new ApiError(422, 'GOOGLE_SHEET_EXPORT_INVALID', 'Google did not return a valid Excel workbook.');
  }
  if (entries.length > MAX_ARCHIVE_ENTRIES) throw new ApiError(413, 'GOOGLE_SHEET_TOO_LARGE', 'This sheet contains too many workbook parts. Split it into smaller sheets.');
  let expanded = 0;
  for (const entry of entries) {
    const size = entry._data?.uncompressedSize;
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ENTRY_BYTES || (expanded += size) > MAX_EXPANDED_BYTES) {
      throw new ApiError(413, 'GOOGLE_SHEET_TOO_LARGE', 'This sheet is too large to import safely. Remove unused formatting or split it into smaller sheets.');
    }
  }
}

async function downloadGoogleSheet(value, { fetcher = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const { sheetId, resourceKey } = sheetLinkFromUrl(value);
  if (typeof fetcher !== 'function') throw new ApiError(503, 'GOOGLE_SHEET_UNAVAILABLE', 'Google Sheets could not be reached right now.');
  const controller = new AbortController();
  let rejectDeadline;
  const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
  const timer = setTimeout(() => {
    controller.abort();
    rejectDeadline(new ApiError(504, 'GOOGLE_SHEET_TIMEOUT', 'Google Sheets took too long to respond. Try again.'));
  }, timeoutMs);
  let url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=xlsx${resourceKey ? '&resourcekey=' + encodeURIComponent(resourceKey) : ''}`;
  try {
    for (let redirects = 0; redirects <= 4; redirects++) {
      let response;
      try {
        response = await Promise.race([fetcher(url, {
          method: 'GET', redirect: 'manual', credentials: 'omit', signal: controller.signal,
          headers: { Accept: XLSX_TYPE }
        }), deadline]);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(502, 'GOOGLE_SHEET_UNAVAILABLE', 'Google Sheets could not be reached. Try again.');
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        let next;
        try { next = location && new URL(location, url).href; } catch { next = null; }
        await response.body?.cancel().catch(() => {});
        if (!next || !allowedExportUrl(next)) throw new ApiError(403, 'GOOGLE_SHEET_NOT_SHARED', 'Set the Google Sheet to Anyone with the link → Viewer, then try again.');
        url = next;
        continue;
      }
      if (response.status === 401 || response.status === 403) throw new ApiError(403, 'GOOGLE_SHEET_NOT_SHARED', 'Set the Google Sheet to Anyone with the link → Viewer, then try again.');
      if (response.status === 404) throw new ApiError(404, 'GOOGLE_SHEET_NOT_FOUND', 'The Google Sheet was not found. Check the sharing link.');
      if (response.status === 429) throw new ApiError(429, 'GOOGLE_SHEET_RATE_LIMITED', 'Google Sheets is receiving too many requests. Try again shortly.');
      if (!response.ok) throw new ApiError(502, 'GOOGLE_SHEET_UNAVAILABLE', 'Google Sheets could not export this sheet right now. Try again.');
      if (Number(response.headers.get('content-length')) > MAX_XLSX_BYTES) throw new ApiError(413, 'GOOGLE_SHEET_TOO_LARGE', 'The Google Sheet export is larger than 10 MB. Split it into smaller sheets.');
      if (!response.body) throw new ApiError(502, 'GOOGLE_SHEET_UNAVAILABLE', 'Google Sheets returned an empty response. Try again.');
      const reader = response.body.getReader(), chunks = [];
      let length = 0;
      while (true) {
        let packet;
        try { packet = await Promise.race([reader.read(), deadline]); }
        catch (error) {
          if (error instanceof ApiError) throw error;
          throw new ApiError(502, 'GOOGLE_SHEET_UNAVAILABLE', 'The Google Sheet download was interrupted. Try again.');
        }
        if (packet.done) break;
        length += packet.value.byteLength;
        if (length > MAX_XLSX_BYTES) {
          controller.abort();
          throw new ApiError(413, 'GOOGLE_SHEET_TOO_LARGE', 'The Google Sheet export is larger than 10 MB. Split it into smaller sheets.');
        }
        chunks.push(Buffer.from(packet.value));
      }
      const bytes = Buffer.concat(chunks, length);
      return bytes;
    }
    throw new ApiError(502, 'GOOGLE_SHEET_UNAVAILABLE', 'Google Sheets redirected too many times. Try the link again.');
  } finally { clearTimeout(timer); }
}

// Inspect only small workbook metadata before selecting worksheets. The source
// may contain more tabs than one import can process; worksheet XML stays zipped.
async function inspectWorkbook(bytes) {
  if (bytes.length > MAX_XLSX_BYTES) throw new ApiError(413, 'GOOGLE_SHEET_TOO_LARGE', 'The Google Sheet export is larger than 10 MB.');
  let zip;
  try { zip = await JSZip.loadAsync(bytes); }
  catch { throw new ApiError(422, 'GOOGLE_SHEET_EXPORT_INVALID', 'Google returned an unreadable workbook.'); }
  const entries = Object.values(zip.files).filter(entry => !entry.dir);
  let expanded = 0;
  if (entries.length > 16384) throw new ApiError(413, 'GOOGLE_SHEET_TOO_LARGE', 'This spreadsheet has too many workbook parts to inspect.');
  for (const entry of entries) {
    const size = entry._data?.uncompressedSize;
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ENTRY_BYTES || (expanded += size) > 128 * 1024 * 1024) {
      throw new ApiError(413, 'GOOGLE_SHEET_TOO_LARGE', 'This spreadsheet is too large to inspect safely. Remove unused formatting or split it into smaller spreadsheets.');
    }
  }
  const metadata = async name => {
    const entry = zip.file(name);
    if (!entry || entry._data.uncompressedSize > 1024 * 1024) throw new ApiError(422, 'GOOGLE_SHEET_EXPORT_INVALID', 'Workbook tab information is missing or too large.');
    return entry.async('string');
  };
  const workbook = await metadata('xl/workbook.xml'), relationships = await metadata('xl/_rels/workbook.xml.rels');
  const decode = text => text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
    if (entity[0] !== '#') return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity] || match;
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
  const attrs = tag => Object.fromEntries([...tag.matchAll(/([\w:]+)\s*=\s*(["'])(.*?)\2/gs)].map(match => [match[1], decode(match[3])]));
  const relations = new Map([...relationships.matchAll(/<Relationship\b[^>]*\/?\s*>/g)].map(match => {
    const attr = attrs(match[0]);
    return [attr.Id, attr.Target];
  }));
  const tabs = [...workbook.matchAll(/<sheet\b[^>]*\/?\s*>/g)].map((match, index) => {
    const attr = attrs(match[0]), target = relations.get(attr['r:id']) || '';
    const path = target.startsWith('/xl/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    if (!attr.name || !/^xl\/worksheets\/[^/]+\.xml$/.test(path) || !zip.file(path)) throw new ApiError(422, 'GOOGLE_SHEET_EXPORT_INVALID', 'Workbook tab information is invalid.');
    return { number: index + 1, name: attr.name, path, relationship: attr['r:id'], tag: match[0] };
  });
  if (!tabs.length || tabs.length > 2000 || new Set(tabs.map(tab => tab.name)).size !== tabs.length) throw new ApiError(422, 'GOOGLE_SHEET_EXPORT_INVALID', 'The spreadsheet must contain between 1 and 2,000 uniquely named tabs.');
  return { zip, workbook, relationships, tabs, attrs };
}

async function listGoogleSheetTabs(value, options = {}) {
  const bytes = await downloadGoogleSheet(value, options);
  const { tabs } = await inspectWorkbook(bytes);
  return { tabs: tabs.map(({ number, name }) => ({ number, name })), maxSelected: 250, sourceBytes: bytes.length, maxFileBytes: MAX_XLSX_BYTES };
}

async function exportGoogleSheet(value, options = {}) {
  const { range } = options;
  if (range !== undefined && (!range || !Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to) || range.from < 1 || range.to < range.from || range.to - range.from >= 250)) {
    throw new ApiError(400, 'INVALID_GOOGLE_SHEET_RANGE', 'Select an ordered range of 1 to 250 tabs.');
  }
  if (range?.expectedTabs !== undefined && (!Array.isArray(range.expectedTabs) || range.expectedTabs.length > 250 || range.expectedTabs.some(name => typeof name !== 'string' || name.length > 255))) {
    throw new ApiError(400, 'INVALID_GOOGLE_SHEET_RANGE', 'Load the tab list again before choosing a range.');
  }
  let bytes = await downloadGoogleSheet(value, options);
  if (range !== undefined) {
    const { zip, workbook, relationships, tabs, attrs } = await inspectWorkbook(bytes);
    if (range.to > tabs.length || (range.expectedTabs && (range.expectedTabs.length !== range.to - range.from + 1 || range.expectedTabs.some((name, index) => name !== tabs[range.from - 1 + index].name)))) {
      throw new ApiError(409, 'GOOGLE_SHEET_TABS_CHANGED', 'The spreadsheet tabs changed. Load the tab list again before choosing a range.');
    }
    const chosen = tabs.slice(range.from - 1, range.to), keep = new Set(chosen.map(tab => tab.path)), removed = new Set();
    for (const tab of tabs) if (!keep.has(tab.path)) {
      removed.add(tab.path);
      const slash = tab.path.lastIndexOf('/');
      removed.add(tab.path.slice(0, slash + 1) + '_rels/' + tab.path.slice(slash + 1) + '.rels');
    }
    removed.add('xl/calcChain.xml');
    removed.add('xl/_rels/calcChain.xml.rels');
    for (const path of removed) zip.remove(path);
    zip.file('xl/workbook.xml', workbook.replace(/<sheets\b[^>]*>[\s\S]*?<\/sheets>/, '<sheets>' + chosen.map(tab => tab.tag).join('') + '</sheets>').replace(/<definedNames\b[^>]*>[\s\S]*?<\/definedNames>/g, ''));
    const chosenIds = new Set(chosen.map(tab => tab.relationship)), excludedIds = new Set(tabs.filter(tab => !chosenIds.has(tab.relationship)).map(tab => tab.relationship));
    zip.file('xl/_rels/workbook.xml.rels', relationships.replace(/<Relationship\b[^>]*\/?\s*>/g, tag => excludedIds.has(attrs(tag).Id) || /calcChain/.test(attrs(tag).Type || '') ? '' : tag));
    const types = zip.file('[Content_Types].xml');
    if (!types || types._data.uncompressedSize > 1024 * 1024) throw new ApiError(422, 'GOOGLE_SHEET_EXPORT_INVALID', 'Workbook content information is invalid.');
    zip.file('[Content_Types].xml', (await types.async('string')).replace(/<Override\b[^>]*\/?\s*>/g, tag => removed.has((attrs(tag).PartName || '').replace(/^\//, '')) ? '' : tag));
    bytes = Buffer.from(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
    if (bytes.length > MAX_XLSX_BYTES) throw new ApiError(413, 'GOOGLE_SHEET_TOO_LARGE', 'The selected tabs exceed 10 MB. Choose a smaller range.');
  }
  await validateXlsx(bytes);
  return bytes;
}

module.exports = { XLSX_TYPE, sheetIdFromUrl, exportGoogleSheet, listGoogleSheetTabs };
