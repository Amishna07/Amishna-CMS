'use strict';
const { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const { ApiError } = require('./errors');
const derive = promisify(scrypt);
const COOKIE = 'amishna_session';
const SESSION_MS = 8 * 60 * 60 * 1000;
const HASH_OPTIONS = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const digest = value => createHash('sha256').update(value).digest('hex');
const publicUser = user => ({ id: user._id, name: user.name, email: user.email, role: user.role, active: user.active });

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64, HASH_OPTIONS);
  return `scrypt$${salt}$${key.toString('hex')}`;
}
async function verifyPassword(password, encoded) {
  const [algorithm, salt, hash] = String(encoded || '').split('$');
  if (algorithm !== 'scrypt' || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(hash)) return false;
  const key = await derive(password, salt, 64, HASH_OPTIONS);
  return timingSafeEqual(key, Buffer.from(hash, 'hex'));
}
function account(body, role = 'editor') {
  const email = String(body?.email || '').trim().toLowerCase(), name = String(body?.name || '').trim();
  const password = body?.password;
  if (!name || name.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new ApiError(400, 'INVALID_ACCOUNT', 'Enter a name and valid email address.');
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw new ApiError(400, 'INVALID_PASSWORD', 'Use a password between 12 and 128 characters.');
  return { name, email, password, role, active: true };
}

class SQLiteAuthStore {
  constructor(repository) {
    this.workspaceId = repository.workspaceId;
    this.db = repository.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS auth_users (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
      email TEXT NOT NULL, role TEXT NOT NULL, active INTEGER NOT NULL,
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE (workspace_id, email)
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions (expires_at);
    CREATE TABLE IF NOT EXISTS auth_attempts (
      id TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at TEXT NOT NULL
    );`);
  }
  user(row) {
    return row && { _id: row.id, name: row.name, email: row.email, role: row.role,
      active: !!row.active, passwordHash: row.password_hash, createdAt: row.created_at };
  }
  async hasAdmin() { return !!this.db.prepare('SELECT 1 FROM auth_users WHERE id = ? AND workspace_id = ?').get(this.workspaceId + ':admin', this.workspaceId); }
  async createUser(user, initial = false) {
    const record = { ...user, _id: initial ? this.workspaceId + ':admin' : randomUUID(), createdAt: new Date().toISOString() };
    try {
      this.db.prepare('INSERT INTO auth_users (id, workspace_id, name, email, role, active, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(record._id, this.workspaceId, record.name, record.email, record.role, Number(record.active), record.passwordHash, record.createdAt);
    } catch (error) {
      if (error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(error.message))
        throw new ApiError(409, 'ACCOUNT_EXISTS', initial ? 'Administrator setup is already complete. Sign in instead.' : 'An account with this email already exists.');
      throw error;
    }
    return record;
  }
  async findUser(email) { return this.user(this.db.prepare('SELECT * FROM auth_users WHERE workspace_id = ? AND email = ?').get(this.workspaceId, email)); }
  async findUserId(id) { return this.user(this.db.prepare('SELECT * FROM auth_users WHERE workspace_id = ? AND id = ?').get(this.workspaceId, id)); }
  async listUsers() { return this.db.prepare('SELECT * FROM auth_users WHERE workspace_id = ? ORDER BY created_at, id').all(this.workspaceId).map(row => this.user(row)); }
  async updateUser(id, changes) {
    const user = await this.findUserId(id);
    if (!user) return null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE auth_users SET active = ?, password_hash = ? WHERE workspace_id = ? AND id = ?')
        .run(Number(changes.active ?? user.active), changes.passwordHash ?? user.passwordHash, this.workspaceId, id);
      this.db.prepare('DELETE FROM auth_sessions WHERE workspace_id = ? AND user_id = ?').run(this.workspaceId, id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.findUserId(id);
  }
  async createSession(session) {
    this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(new Date().toISOString());
    this.db.prepare('INSERT INTO auth_sessions (id, workspace_id, user_id, expires_at) VALUES (?, ?, ?, ?)')
      .run(session._id, this.workspaceId, session.userId, session.expiresAt.toISOString());
  }
  async findSession(id) {
    const row = this.db.prepare('SELECT user_id, expires_at FROM auth_sessions WHERE id = ? AND workspace_id = ? AND expires_at > ?')
      .get(id, this.workspaceId, new Date().toISOString());
    return row && { _id: id, userId: row.user_id, expiresAt: row.expires_at };
  }
  async deleteSession(id) { this.db.prepare('DELETE FROM auth_sessions WHERE id = ? AND workspace_id = ?').run(id, this.workspaceId); }
  async takeAttempt(email) {
    const id = this.workspaceId + ':' + digest(email), now = new Date().toISOString();
    const previous = this.db.prepare('SELECT count, expires_at FROM auth_attempts WHERE id = ?').get(id);
    const count = previous && previous.expires_at > now ? previous.count + 1 : 1;
    const expiresAt = previous && previous.expires_at > now ? previous.expires_at : new Date(Date.now() + 15 * 60 * 1000).toISOString();
    this.db.prepare('INSERT INTO auth_attempts (id, count, expires_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET count = excluded.count, expires_at = excluded.expires_at')
      .run(id, count, expiresAt);
    return count <= 10;
  }
  async resetAttempts(email) { this.db.prepare('DELETE FROM auth_attempts WHERE id = ?').run(this.workspaceId + ':' + digest(email)); }
}

function createAuth({ store, secure = false, allowLocalSetup = false, setupToken = '', sessionMs = SESSION_MS }) {
  let dummyHash;
  const tokenFrom = request => String(request.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1) || '';
  const cookie = (token, maxAge = sessionMs / 1000) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  async function requireUser(request) {
    const token = tokenFrom(request);
    if (!/^[a-f0-9]{64}$/.test(token)) throw new ApiError(401, 'AUTH_REQUIRED', 'Please sign in to continue.');
    const session = await store.findSession(digest(token));
    const user = session && await store.findUserId(session.userId);
    if (!user?.active || !session || new Date(session.expiresAt).getTime() <= Date.now()) throw new ApiError(401, 'AUTH_REQUIRED', 'Your session has expired. Please sign in again.');
    return publicUser(user);
  }
  async function signIn(user, response, respond) {
    const token = randomBytes(32).toString('hex');
    await store.createSession({ _id: digest(token), userId: user._id, expiresAt: new Date(Date.now() + sessionMs) });
    respond(response, 200, { user: publicUser(user) }, { 'Set-Cookie': cookie(token) });
  }
  async function handle(request, response, pathname, { readJson, respond }) {
    if (!pathname.startsWith('/api/auth/')) return false;
    const method = request.method;
    if (['POST', 'PATCH'].includes(method) && !request.headers.origin) throw new ApiError(403, 'ORIGIN_REQUIRED', 'Open the sign-in screen in your browser.');
    if (pathname === '/api/auth/session' && method === 'GET') {
      let user = null;
      try { user = await requireUser(request); } catch (error) { if (error.status !== 401) throw error; }
      const setupRequired = !await store.hasAdmin();
      respond(response, 200, { user, setupRequired, setupAllowed: allowLocalSetup || !!setupToken, setupTokenRequired: !allowLocalSetup });
    } else if (pathname === '/api/auth/setup' && method === 'POST') {
      const body = await readJson(request, 4096);
      if (await store.hasAdmin()) throw new ApiError(409, 'SETUP_COMPLETE', 'Administrator setup is already complete. Sign in instead.');
      if (!allowLocalSetup && (!setupToken || typeof body.setupToken !== 'string' || !timingSafeEqual(Buffer.from(digest(body.setupToken)), Buffer.from(digest(setupToken))))) throw new ApiError(403, 'SETUP_FORBIDDEN', 'Enter the administrator setup token configured by the site owner.');
      const { password, ...details } = account(body, 'admin');
      const user = await store.createUser({ ...details, passwordHash: await hashPassword(password) }, true);
      await signIn(user, response, respond);
    } else if (pathname === '/api/auth/login' && method === 'POST') {
      const body = await readJson(request, 4096), email = String(body?.email || '').trim().toLowerCase(), password = body?.password;
      if (!email || email.length > 254 || typeof password !== 'string' || password.length > 128) throw new ApiError(400, 'INVALID_LOGIN', 'Enter your email and password.');
      if (!await store.takeAttempt(email)) throw new ApiError(429, 'LOGIN_LIMIT', 'Too many sign-in attempts. Try again in 15 minutes.');
      const user = await store.findUser(email);
      dummyHash ||= hashPassword(randomBytes(32).toString('hex'));
      const valid = await verifyPassword(password, user?.passwordHash || await dummyHash);
      if (!valid || !user?.active) throw new ApiError(401, 'INVALID_LOGIN', 'Email or password is incorrect.');
      await store.resetAttempts(email);
      await signIn(user, response, respond);
    } else if (pathname === '/api/auth/logout' && method === 'POST') {
      const token = tokenFrom(request);
      if (/^[a-f0-9]{64}$/.test(token)) await store.deleteSession(digest(token));
      respond(response, 200, { signedOut: true }, { 'Set-Cookie': cookie('', 0) });
    } else if (pathname === '/api/auth/users' && ['GET', 'POST', 'PATCH'].includes(method)) {
      const actor = await requireUser(request);
      if (actor.role !== 'admin') throw new ApiError(403, 'ADMIN_REQUIRED', 'Only an administrator can manage sign-in accounts.');
      if (method === 'GET') respond(response, 200, { users: (await store.listUsers()).map(publicUser) });
      else if (method === 'POST') {
        const body = await readJson(request, 4096), { password, ...details } = account(body);
        const user = await store.createUser({ ...details, passwordHash: await hashPassword(password) });
        respond(response, 201, { user: publicUser(user) });
      } else {
        const body = await readJson(request, 4096), id = typeof body?.id === 'string' ? body.id : '';
        const user = await store.findUserId(id);
        if (!user) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', 'Account not found.');
        const changes = {};
        if (typeof body.active === 'boolean') {
          if (user.role === 'admin') throw new ApiError(400, 'ADMIN_PROTECTED', 'The administrator account cannot be deactivated.');
          changes.active = body.active;
        }
        if (body.password !== undefined) {
          if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128) throw new ApiError(400, 'INVALID_PASSWORD', 'Use a password between 12 and 128 characters.');
          changes.passwordHash = await hashPassword(body.password);
        }
        if (!Object.keys(changes).length) throw new ApiError(400, 'INVALID_ACCOUNT', 'Choose an account status or enter a new password.');
        respond(response, 200, { user: publicUser(await store.updateUser(id, changes)) });
      }
    } else throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'This sign-in action does not support that request method.');
    return true;
  }
  return { handle, requireUser };
}
module.exports = { createAuth, SQLiteAuthStore, hashPassword, verifyPassword, digest, COOKIE };
