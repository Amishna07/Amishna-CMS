(function (root) {
  'use strict';
  const document = root.document;
  const host = document.getElementById('auth-root');
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  let loaded = false, busy = false, signingOut = false;
  const auth = root.CueAuth = {
    user: null,
    controls() {
      return `<span class="auth-user" title="${escape(auth.user?.email)}">${escape(auth.user?.name)}</span>${auth.user?.role === 'admin' ? '<button class="btn small" type="button" data-auth-action="accounts">Login accounts</button>' : ''}<button class="btn small" type="button" data-auth-action="logout">Log out</button>`;
    },
    lock() {
      auth.user = null;
      document.getElementById('auth-accounts')?.remove();
      for (const id of ['app', 'sync-root', 'modal-root', 'appearance-studio-root']) document.getElementById(id).replaceChildren();
      document.title = 'Sign in · Amishna Music';
      showGate({ setupRequired: false }, 'Your session has ended. Sign in again to continue.');
    },
  };
  async function request(path, method = 'GET', body) {
    const response = await root.fetch('/api/auth/' + path, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      if (result?.error?.code === 'AUTH_REQUIRED') root.dispatchEvent(new root.Event('amishna-auth-expired'));
      throw new Error(result?.error?.message || 'The sign-in service could not be reached. Please try again.');
    }
    return result;
  }
  function showGate(info, message = '') {
    host.hidden = false;
    for (const id of ['app', 'sync-root', 'modal-root', 'appearance-studio-root']) document.getElementById(id)?.setAttribute('hidden', '');
    const setup = info.setupRequired;
    host.innerHTML = `<main class="auth-screen"><section class="auth-card"><img class="auth-logo" src="assets/amishna-logo.png" alt="Amishna Music"><p class="auth-eyebrow">AMISHNA MUSIC CMS V5</p><h1>${setup ? 'Set up your administrator' : 'Welcome back'}</h1><p>${setup ? 'Create the account that will manage access to your workspace.' : 'Sign in to your music workspace.'}</p>${setup && !info.setupAllowed ? '<p class="auth-error">The site owner must configure AUTH_SETUP_TOKEN before administrator setup is available.</p><button class="btn" type="button" data-auth-action="retry">Check again</button>' : `<form id="auth-form" data-setup="${setup ? 'true' : 'false'}">${setup ? '<label>Name<input class="input" name="name" autocomplete="name" required maxlength="120"></label>' : ''}<label>Email<input class="input" name="email" type="email" autocomplete="username" required maxlength="254"></label><label>Password<input class="input" name="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required ${setup ? 'minlength="12"' : ''} maxlength="128"></label>${setup ? '<small>Use at least 12 characters.</small><label>Confirm password<input class="input" name="confirmPassword" type="password" autocomplete="new-password" required minlength="12" maxlength="128"></label>' : ''}${setup && info.setupTokenRequired ? '<label>Administrator setup token<input class="input" name="setupToken" type="password" autocomplete="off" required></label>' : ''}<p class="auth-error" id="auth-error" role="alert">${escape(message)}</p><button class="btn primary" type="submit">${setup ? 'Create administrator' : 'Sign in'}</button></form>`}<p class="auth-footnote">${setup ? 'Existing songs, projects, and exports will stay in your workspace.' : 'Need an account or a password reset? Contact your administrator.'}</p></section></main>`;
    host.querySelector('input')?.focus();
  }
  async function loadDashboard(user) {
    auth.user = Object.freeze(user);
    if (loaded) { root.location.reload(); return; }
    loaded = true;
    host.hidden = true;
    for (const id of ['app', 'sync-root', 'modal-root', 'appearance-studio-root']) document.getElementById(id)?.removeAttribute('hidden');
    const script = document.createElement('script');
    script.src = 'dashboard.js';
    script.onerror = () => { loaded = false; showGate({ setupRequired: false }, 'The workspace could not load. Refresh this page to try again.'); };
    document.body.appendChild(script);
  }
  async function checkSession() {
    try {
      const result = await request('session');
      if (result.user) await loadDashboard(result.user);
      else showGate(result);
    } catch (error) {
      host.hidden = false;
      document.getElementById('app').hidden = true;
      host.innerHTML = `<main class="auth-screen"><section class="auth-card"><h1>Unable to connect</h1><p class="auth-error" role="alert">${escape(error.message)}</p><button class="btn primary" data-auth-action="retry">Try again</button></section></main>`;
    }
  }
  function notify(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 6000);
  }
  async function openAccounts() {
    const result = await request('users');
    document.getElementById('auth-accounts')?.remove();
    const dialog = document.createElement('dialog');
    dialog.id = 'auth-accounts';
    dialog.className = 'auth-account-dialog';
    dialog.innerHTML = `<div class="auth-account-head"><h2>Login accounts</h2><button class="btn small" type="button" data-auth-action="close-accounts">Close</button></div><p>These accounts can sign in and edit the shared workspace. Team editor records and project assignments are managed separately.</p><div class="auth-account-list">${result.users.map(user => `<section><div><strong>${escape(user.name)}</strong><small>${escape(user.email)} · ${user.role === 'admin' ? 'Administrator' : user.active ? 'Editor' : 'Inactive'}</small></div>${user.role === 'admin' ? '' : `<button type="button" class="btn small" data-auth-action="toggle-account" data-id="${escape(user.id)}" data-active="${!user.active}">${user.active ? 'Deactivate' : 'Reactivate'}</button>`}</section>`).join('')}</div><h3>Add an editor account</h3><form id="auth-create-user"><label>Name<input class="input" name="name" required maxlength="120"></label><label>Email<input class="input" name="email" type="email" required maxlength="254"></label><label>Password<input class="input" name="password" type="password" autocomplete="new-password" required minlength="12" maxlength="128"></label><small>Share the account details privately with your editor.</small><button class="btn primary" type="submit">Create account</button></form><h3>Reset an account password</h3><form id="auth-reset-password"><label>Account<select class="input" name="id">${result.users.map(user => `<option value="${escape(user.id)}">${escape(user.name)} (${escape(user.email)})</option>`).join('')}</select></label><label>New password<input class="input" name="password" type="password" autocomplete="new-password" required minlength="12" maxlength="128"></label><small>Resetting a password logs that account out on every device.</small><button class="btn" type="submit">Reset password</button></form><p class="auth-error" id="auth-account-error" role="alert"></p>`;
    dialog.addEventListener('close', () => dialog.remove());
    document.body.appendChild(dialog);
    dialog.showModal();
  }
  document.addEventListener('submit', async event => {
    const form = event.target;
    if (!['auth-form', 'auth-create-user', 'auth-reset-password'].includes(form.id)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (busy) return;
    busy = true;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    const errorHost = document.getElementById(form.id === 'auth-form' ? 'auth-error' : 'auth-account-error');
    errorHost.textContent = '';
    try {
      const values = Object.fromEntries(new FormData(form));
      if (form.id === 'auth-form') {
        if (form.dataset.setup === 'true' && values.password !== values.confirmPassword) throw new Error('The passwords do not match.');
        const result = await request(form.dataset.setup === 'true' ? 'setup' : 'login', 'POST', values);
        await loadDashboard(result.user);
      } else if (form.id === 'auth-create-user') {
        await request('users', 'POST', values);
        await openAccounts();
        notify('Editor login account created.');
      } else {
        await request('users', 'PATCH', values);
        if (values.id === auth.user?.id) { root.dispatchEvent(new root.Event('amishna-auth-expired')); }
        else { await openAccounts(); notify('Password reset. Existing sessions were signed out.'); }
      }
    } catch (error) { errorHost.textContent = error.message; }
    finally { busy = false; button.disabled = false; }
  }, true);
  document.addEventListener('click', async event => {
    const control = event.target.closest('[data-auth-action]');
    if (!control) return;
    event.preventDefault();
    const action = control.dataset.authAction;
    try {
      if (action === 'retry') await checkSession();
      else if (action === 'accounts') await openAccounts();
      else if (action === 'close-accounts') document.getElementById('auth-accounts')?.close();
      else if (action === 'toggle-account') {
        control.disabled = true;
        await request('users', 'PATCH', { id: control.dataset.id, active: control.dataset.active === 'true' });
        await openAccounts();
      } else if (action === 'logout' && !signingOut) {
        signingOut = true;
        control.disabled = true;
        if (auth.beforeLogout && !await auth.beforeLogout()) throw new Error('Save or cancel open forms and wait for your changes to sync before logging out.');
        await request('logout', 'POST', {});
        try {
          auth.clearCache?.();
          root.localStorage.setItem('amishna-auth-state', String(Date.now()));
        } finally { root.dispatchEvent(new root.Event('amishna-auth-expired')); }
      }
    } catch (error) {
      const errorHost = document.getElementById('auth-account-error');
      if (errorHost) errorHost.textContent = error.message;
      else notify(error.message);
    } finally { signingOut = false; control.disabled = false; }
  });
  root.addEventListener('pageshow', event => { if (event.persisted) root.location.reload(); });
  root.addEventListener('storage', event => { if (event.key === 'amishna-auth-state' && loaded) root.dispatchEvent(new root.Event('amishna-auth-expired')); });
  void checkSession();
})(window);
