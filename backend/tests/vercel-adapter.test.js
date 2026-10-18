'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { replayParsedBody } = require('../../vercel/adapter');

for (const method of ['POST', 'PUT', 'PATCH']) {
  test('Vercel replays parsed ' + method + ' JSON while preserving authentication headers', async () => {
    const body = { id: 'editor', active: false };
    const headers = { 'content-type': 'application/json', cookie: 'amishna_session=test-token', origin: 'https://cms.example' };
    const request = { method, url: '/api/auth/users', headers, socket: {}, body };
    const replay = replayParsedBody(request), chunks = [];
    for await (const chunk of replay) chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), body);
    assert.equal(replay.headers, headers);
    assert.equal(replay.method, method);
    assert.equal(replay.url, request.url);
    assert.equal(replay.socket, request.socket);
  });
}

test('unparsed local requests and body-free Vercel requests keep their original streams', () => {
  const request = { method: 'PATCH', headers: { 'content-type': 'application/json' } };
  assert.equal(replayParsedBody(request), request);
  const get = { ...request, method: 'GET', body: {} };
  assert.equal(replayParsedBody(get), get);
});
