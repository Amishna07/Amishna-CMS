'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const source = readFileSync(join(__dirname, '../public/auth.js'), 'utf8');

async function screen(result, status = 200) {
  const scripts = [], listeners = new Map(), nodes = new Map();
  for (const id of ['auth-root', 'app', 'sync-root', 'modal-root', 'appearance-studio-root', 'toast']) nodes.set(id, {
    hidden: false, innerHTML: '', textContent: '', querySelector: () => null,
    setAttribute(name) { if (name === 'hidden') this.hidden = true; },
    removeAttribute(name) { if (name === 'hidden') this.hidden = false; },
    replaceChildren() { this.innerHTML = ''; this.textContent = ''; },
    classList: { add() {}, remove() {} },
  });
  const document = {
    getElementById: id => nodes.get(id), createElement: () => ({}),
    body: { appendChild: script => scripts.push(script) }, addEventListener() {}, title: 'Amishna',
  };
  const context = {
    document, setTimeout: () => 0, location: { reload() {} },
    fetch: async () => ({ ok: status === 200, status, json: async () => result }),
    addEventListener: (name, callback) => listeners.set(name, callback),
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  return { context, nodes, scripts, listeners };
}

test('signed-out visitors see a login form and never load the workspace bundle', async () => {
  const app = await screen({ user: null, setupRequired: false });
  assert.match(app.nodes.get('auth-root').innerHTML, /Welcome back/);
  assert.match(app.nodes.get('auth-root').innerHTML, /type="password"/);
  assert.equal(app.nodes.get('app').hidden, true);
  assert.equal(app.scripts.length, 0);
});
test('administrator setup shows confirmation and requires a token only on hosted deployments', async () => {
  const local = await screen({ user: null, setupRequired: true, setupAllowed: true, setupTokenRequired: false });
  assert.match(local.nodes.get('auth-root').innerHTML, /Confirm password/);
  assert.doesNotMatch(local.nodes.get('auth-root').innerHTML, /name="setupToken"/);
  const hosted = await screen({ user: null, setupRequired: true, setupAllowed: true, setupTokenRequired: true });
  assert.match(hosted.nodes.get('auth-root').innerHTML, /name="setupToken"/);
  const unconfigured = await screen({ user: null, setupRequired: true, setupAllowed: false, setupTokenRequired: true });
  assert.match(unconfigured.nodes.get('auth-root').innerHTML, /configure AUTH_SETUP_TOKEN/);
  assert.doesNotMatch(unconfigured.nodes.get('auth-root').innerHTML, /id="auth-form"/);
});
test('verified sessions load the dashboard, escape account names and restrict admin controls', async () => {
  const editor = await screen({ user: { id: 'editor', name: '<script>bad</script>', email: 'editor@example.com', role: 'editor' } });
  assert.equal(editor.scripts[0].src, 'dashboard.js');
  assert.equal(editor.nodes.get('auth-root').hidden, true);
  assert.match(editor.context.CueAuth.controls(), /&lt;script&gt;/);
  assert.match(editor.context.CueAuth.controls(), /Log out/);
  assert.doesNotMatch(editor.context.CueAuth.controls(), /Login accounts/);
  const owner = await screen({ user: { id: 'owner', name: 'Owner', email: 'owner@example.com', role: 'admin' } });
  assert.match(owner.context.CueAuth.controls(), /Login accounts/);
});
test('session expiry removes private workspace content and returns to sign-in', async () => {
  const app = await screen({ user: { id: 'owner', name: 'Owner', email: 'owner@example.com', role: 'admin' } });
  for (const id of ['app', 'sync-root', 'modal-root']) app.nodes.get(id).innerHTML = 'Private data';
  app.context.CueAuth.lock();
  assert.equal(app.context.CueAuth.user, null);
  for (const id of ['app', 'sync-root', 'modal-root']) assert.equal(app.nodes.get(id).innerHTML, '');
  assert.match(app.nodes.get('auth-root').innerHTML, /session has ended/);
});
test('unavailable authentication fails closed without loading cached workspace content', async () => {
  const app = await screen({ error: { message: 'Database unavailable' } }, 503);
  assert.match(app.nodes.get('auth-root').innerHTML, /Unable to connect/);
  assert.equal(app.nodes.get('app').hidden, true);
  assert.equal(app.scripts.length, 0);
});
