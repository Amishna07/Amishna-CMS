'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { createAuth, hashPassword, verifyPassword, digest } = require('../src/auth');
const { createApp } = require('../src/app');
const { ApiError } = require('../src/errors');
const password = 'correct horse battery staple';

class MemoryAuthStore {
  constructor() { this.users = new Map(); this.sessions = new Map(); this.attempts = new Map(); }
  async hasAdmin() { return this.users.has('admin'); }
  async createUser(user, initial = false) {
    if (initial && this.users.has('admin') || [...this.users.values()].some(record => record.email === user.email)) throw new ApiError(409, 'ACCOUNT_EXISTS', 'Account exists.');
    const record = { ...user, _id: initial ? 'admin' : randomUUID() };
    this.users.set(record._id, record); return record;
  }
  async findUser(email) { return [...this.users.values()].find(user => user.email === email); }
  async findUserId(id) { return this.users.get(id); }
  async listUsers() { return [...this.users.values()]; }
  async updateUser(id, changes) {
    Object.assign(this.users.get(id), changes);
    for (const [key, session] of this.sessions) if (session.userId === id) this.sessions.delete(key);
    return this.users.get(id);
  }
  async createSession(session) { this.sessions.set(session._id, session); }
  async findSession(id) { return this.sessions.get(id); }
  async deleteSession(id) { this.sessions.delete(id); }
  async takeAttempt(email) { const count = (this.attempts.get(email) || 0) + 1; this.attempts.set(email, count); return count <= 10; }
  async resetAttempts(email) { this.attempts.delete(email); }
}
async function fixture(t, options = {}) {
  const store = new MemoryAuthStore();
  let accesses = 0;
  const repository = { get: async () => { accesses++; return { workspace: null, revision: 0 }; }, health: async () => ({ status: 'ok' }), put: async () => { accesses++; return { revision: 1 }; } };
  const auth = createAuth({ store, allowLocalSetup: true, ...options });
  const server = http.createServer(createApp({ repository, auth, logger: { error() {} } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  async function request(path, method = 'GET', body, cookie, headers = {}) {
    return fetch(base + path, { method, headers: { Origin: base, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  async function setup() {
    const response = await request('/api/auth/setup', 'POST', { name: 'Owner', email: 'OWNER@example.com', password });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  }
  return { store, request, setup, accesses: () => accesses };
}

test('password hashes are salted scrypt values and reject incorrect passwords', async () => {
  const one = await hashPassword(password), two = await hashPassword(password);
  assert.notEqual(one, two);
  assert.ok(!one.includes(password));
  assert.equal(await verifyPassword(password, one), true);
  assert.equal(await verifyPassword('wrong password', one), false);
  assert.equal(await verifyPassword(password, 'malformed'), false);
});
test('unauthenticated and malformed-cookie requests cannot read or change private APIs', async t => {
  const app = await fixture(t);
  for (const cookie of ['', 'amishna_session=old', 'amishna_session=%bad']) {
    for (const [path, method, body] of [['/api/workspace', 'GET'], ['/api/workspace', 'PUT', {}], ['/api/workspace/validate', 'POST', {}], ['/api/google-sheet/export', 'POST', {}], ['/api/google-sheet/tabs', 'POST', {}], ['/api/health', 'GET']]) {
      assert.equal((await app.request(path, method, body, cookie)).status, 401);
    }
  }
  assert.equal(app.accesses(), 0);
});
test('first administrator setup is one-time, normalizes email and never exposes password hashes', async t => {
  const app = await fixture(t);
  assert.equal((await (await app.request('/api/auth/session')).json()).setupRequired, true);
  const cookie = await app.setup();
  assert.equal(app.store.users.get('admin').email, 'owner@example.com');
  const session = await (await app.request('/api/auth/session', 'GET', undefined, cookie)).json();
  assert.equal(session.user.role, 'admin');
  assert.equal(session.setupRequired, false);
  assert.ok(!JSON.stringify(session).includes('password'));
  assert.equal((await app.request('/api/workspace', 'GET', undefined, cookie)).status, 200);
  assert.equal((await app.request('/api/auth/setup', 'POST', { name: 'Another', email: 'other@example.com', password })).status, 409);
});
test('public administrator setup requires the configured bootstrap token', async t => {
  const app = await fixture(t, { allowLocalSetup: false, secure: true, setupToken: 'private setup token' });
  assert.equal((await app.request('/api/auth/setup', 'POST', { name: 'Owner', email: 'owner@example.com', password })).status, 403);
  const response = await app.request('/api/auth/setup', 'POST', { name: 'Owner', email: 'owner@example.com', password, setupToken: 'private setup token' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Max-Age=28800; Secure/);
  assert.ok(!JSON.stringify(await response.json()).includes('private setup token'));
});
test('simultaneous administrator setup requests create exactly one owner', async t => {
  const app = await fixture(t);
  const results = await Promise.all([1, 2].map(() => app.request('/api/auth/setup', 'POST', { name: 'Owner', email: 'owner@example.com', password })));
  assert.deepEqual(results.map(response => response.status).sort(), [200, 409]);
  assert.equal(app.store.users.size, 1);
});
test('login rejects wrong passwords, succeeds case-insensitively and stores only token hashes', async t => {
  const app = await fixture(t); await app.setup();
  assert.equal((await app.request('/api/auth/login', 'POST', { email: 'owner@example.com', password: 'wrong' })).status, 401);
  const response = await app.request('/api/auth/login', 'POST', { email: 'OWNER@example.com', password });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0], token = cookie.split('=')[1];
  assert.ok(app.store.sessions.has(digest(token)));
  assert.ok(!JSON.stringify([...app.store.sessions.values()]).includes(token));
  assert.equal((await app.request('/api/workspace', 'GET', undefined, cookie)).status, 200);
});
test('logout clears the cookie and a copied old session token immediately stops working', async t => {
  const app = await fixture(t), cookie = await app.setup();
  const response = await app.request('/api/auth/logout', 'POST', {}, cookie);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await app.request('/api/workspace', 'GET', undefined, cookie)).status, 401);
  assert.equal((await app.request('/api/auth/logout', 'POST', {})).status, 200);
});
test('expired sessions fail even before database cleanup removes them', async t => {
  const app = await fixture(t), cookie = await app.setup();
  for (const session of app.store.sessions.values()) session.expiresAt = new Date(Date.now() - 1000);
  assert.equal((await app.request('/api/workspace', 'GET', undefined, cookie)).status, 401);
  assert.equal((await (await app.request('/api/auth/session', 'GET', undefined, cookie)).json()).user, null);
});
test('admin can create editors; editors cannot create accounts or deactivate the owner', async t => {
  const app = await fixture(t), cookie = await app.setup();
  const response = await app.request('/api/auth/users', 'POST', { name: 'Editor', email: 'editor@example.com', password, role: 'admin' }, cookie);
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.user.role, 'editor');
  assert.ok(!JSON.stringify(created).includes('password'));
  const login = await app.request('/api/auth/login', 'POST', { email: 'editor@example.com', password });
  const editorCookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await app.request('/api/auth/users', 'GET', undefined, editorCookie)).status, 403);
  assert.equal((await app.request('/api/auth/users', 'POST', { name: 'Hacker', email: 'hacker@example.com', password }, editorCookie)).status, 403);
  assert.equal((await app.request('/api/workspace', 'GET', undefined, editorCookie)).status, 200);
  assert.equal((await app.request('/api/auth/users', 'PATCH', { id: 'admin', active: false }, cookie)).status, 400);
});
test('deactivation and password resets revoke every existing editor session', async t => {
  const app = await fixture(t), owner = await app.setup();
  const user = (await (await app.request('/api/auth/users', 'POST', { name: 'Editor', email: 'editor@example.com', password }, owner)).json()).user;
  const login = async () => (await app.request('/api/auth/login', 'POST', { email: user.email, password })).headers.get('set-cookie')?.split(';')[0];
  const first = await login(), second = await login();
  await app.request('/api/auth/users', 'PATCH', { id: user.id, active: false }, owner);
  for (const cookie of [first, second]) assert.equal((await app.request('/api/workspace', 'GET', undefined, cookie)).status, 401);
  assert.equal((await app.request('/api/auth/login', 'POST', { email: user.email, password })).status, 401);
  await app.request('/api/auth/users', 'PATCH', { id: user.id, active: true }, owner);
  const third = await login();
  await app.request('/api/auth/users', 'PATCH', { id: user.id, password: 'a new strong password' }, owner);
  assert.equal((await app.request('/api/workspace', 'GET', undefined, third)).status, 401);
  assert.equal((await app.request('/api/auth/login', 'POST', { email: user.email, password })).status, 401);
});
test('login attempts are bounded and authentication mutations reject missing or hostile origins', async t => {
  const app = await fixture(t); await app.setup();
  app.store.attempts.set('owner@example.com', 10);
  assert.equal((await app.request('/api/auth/login', 'POST', { email: 'owner@example.com', password })).status, 429);
  for (const Origin of ['', 'https://attacker.example']) {
    assert.equal((await app.request('/api/auth/logout', 'POST', {}, undefined, { Origin })).status, 403);
  }
  assert.equal((await app.request('/api/auth/setup', 'POST', { name: 'Owner', email: 'owner@example.com', password }, undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
});
test('short passwords and duplicate email accounts are rejected', async t => {
  const app = await fixture(t);
  assert.equal((await app.request('/api/auth/setup', 'POST', { name: 'Owner', email: 'owner@example.com', password: 'short' })).status, 400);
  const owner = await app.setup();
  assert.equal((await app.request('/api/auth/users', 'POST', { name: 'Duplicate', email: 'OWNER@example.com', password }, owner)).status, 409);
});
