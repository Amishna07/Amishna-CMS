/* Local SQLite record transport. The dashboard's public workspace shape stays unchanged. */
(function (global) {
  'use strict';
  const KINDS = ['clients', 'projects', 'works', 'artists', 'cues', 'imports', 'exports', 'profiles', 'activity', 'members', 'repositories', 'deletedCues'];
  const INDEXED = new Set(['profiles', 'activity']);
  const PAGE_SIZE = 1000;
  const clone = value => structuredClone(value);
  const keyOf = (kind, item, index) => INDEXED.has(kind) ? String(index) : item.id;
  const positionKey = (kind, id) => kind + '\0' + id;
  const episodeKey = (projectId, number) => projectId + '\0' + number;
  const projectValue = project => { const value = {...project}; delete value.episodes; return value; };
  const metaOf = workspace => {
    const meta = {...workspace};
    for (const kind of KINDS) delete meta[kind];
    return meta;
  };
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

  function plannedPositions(items, kind, oldPositions, idFor = (item, index) => keyOf(kind, item, index)) {
    const known = items.map((item, index) => oldPositions.get(positionKey(kind, idFor(item, index))));
    const result = new Array(items.length);
    for (let index = 0; index < items.length;) {
      if (known[index] !== undefined) { result[index] = known[index]; index++; continue; }
      let end = index;
      while (end < items.length && known[end] === undefined) end++;
      const left = index ? result[index - 1] : undefined, right = known[end];
      for (let step = index; step < end; step++) {
        const count = end - index;
        result[step] = left !== undefined && right !== undefined
          ? left + (right - left) * (step - index + 1) / (count + 1)
          : right !== undefined ? right - count + step - index
            : left !== undefined ? left + step - index + 1 : step;
      }
      index = end;
    }
    // A rare manual reorder or exhausted floating point gap is rebuilt in order.
    if (result.some((value, index) => index && value <= result[index - 1])) return items.map((_, index) => index);
    return result;
  }

  function difference(base, current, positions) {
    const records = [];
    for (const kind of KINDS) {
      const before = base[kind] || [], after = current[kind] || [];
      const old = new Map(before.map((item, index) => [keyOf(kind, item, index), kind === 'projects' ? projectValue(item) : item]));
      const next = new Set(after.map((item, index) => keyOf(kind, item, index)));
      const order = plannedPositions(after, kind, positions);
      for (let index = 0; index < after.length; index++) {
        const item = after[index], id = keyOf(kind, item, index), value = kind === 'projects' ? projectValue(item) : item;
        if (!same(old.get(id), value) || positions.get(positionKey(kind, id)) !== order[index])
          records.push({kind, id, position: order[index], value});
      }
      for (const [id] of old) if (!next.has(id)) records.push({kind, id, value: null});
    }
    const oldEpisodes = new Map(), afterEpisodes = [];
    for (const project of base.projects || []) for (const episode of project.episodes || []) oldEpisodes.set(episodeKey(project.id, episode.number), episode);
    for (const project of current.projects || []) for (const episode of project.episodes || []) afterEpisodes.push({projectId: project.id, episode});
    const nextEpisodes = new Set(afterEpisodes.map(({projectId, episode}) => episodeKey(projectId, episode.number)));
    const grouped = new Map();
    for (const {projectId, episode} of afterEpisodes) {
      if (!grouped.has(projectId)) grouped.set(projectId, []);
      grouped.get(projectId).push(episode);
    }
    for (const [projectId, episodes] of grouped) {
      const order = plannedPositions(episodes, 'episodes', positions, episode => episodeKey(projectId, episode.number));
      for (let index = 0; index < episodes.length; index++) {
        const episode = episodes[index], id = episodeKey(projectId, episode.number);
        if (!same(oldEpisodes.get(id), episode) || positions.get(positionKey('episodes', id)) !== order[index])
          records.push({kind: 'episodes', id: projectId + '|' + episode.number, projectId, number: episode.number, position: order[index], value: episode});
      }
    }
    for (const [id] of oldEpisodes) if (!nextEpisodes.has(id)) {
      const split = id.lastIndexOf('\0');
      const projectId = id.slice(0, split), number = Number(id.slice(split + 1));
      records.push({kind: 'episodes', id: projectId + '|' + number, projectId, number, value: null});
    }
    // Each HTTP batch must leave SQLite internally consistent. New parents
    // precede their cues; deleted cues precede removed parents.
    const insertOrder = ['clients', 'artists', 'works', 'projects', 'episodes', 'cues', 'imports', 'exports', 'profiles', 'activity', 'members', 'repositories', 'deletedCues'];
    const deleteOrder = ['cues', 'episodes', 'projects', 'works', 'artists', 'clients', 'imports', 'exports', 'profiles', 'activity', 'members', 'repositories', 'deletedCues'];
    records.sort((left, right) => {
      const leftDelete = left.value === null, rightDelete = right.value === null;
      if (leftDelete !== rightDelete) return leftDelete ? 1 : -1;
      return (leftDelete ? deleteOrder : insertOrder).indexOf(left.kind) -
        (rightDelete ? deleteOrder : insertOrder).indexOf(right.kind);
    });
    const beforeMeta = metaOf(base), afterMeta = metaOf(current);
    return {records, meta: same(beforeMeta, afterMeta) ? undefined : afterMeta};
  }

  function apply(target, records, meta, positions) {
    if (meta) for (const key of Object.keys(meta)) target[key] = clone(meta[key]);
    const groups = new Map();
    for (const record of records) {
      if (!groups.has(record.kind)) groups.set(record.kind, []);
      groups.get(record.kind).push(record);
    }
    for (const [kind, changes] of groups) {
      if (kind === 'episodes') {
        const projects = new Map(target.projects.map(project => [project.id, project]));
        const touched = new Set(changes.map(change => change.projectId));
        for (const projectId of touched) {
          const project = projects.get(projectId);
          if (!project) continue;
          const values = new Map((project.episodes || []).map(episode => [episodeKey(projectId, episode.number), episode]));
          for (const change of changes.filter(item => item.projectId === projectId)) {
            const id = episodeKey(change.projectId, change.number);
            if (change.value === null) { values.delete(id); positions.delete(positionKey(kind, id)); }
            else { values.set(id, clone(change.value)); positions.set(positionKey(kind, id), change.position); }
          }
          project.episodes = [...values].sort((left, right) =>
            positions.get(positionKey(kind, left[0])) - positions.get(positionKey(kind, right[0]))).map(([, value]) => value);
        }
        continue;
      }
      const values = new Map((target[kind] || []).map((item, index) => [keyOf(kind, item, index), item]));
      for (const change of changes) {
        if (change.value === null) { values.delete(change.id); positions.delete(positionKey(kind, change.id)); }
        else {
          const value = clone(change.value);
          if (kind === 'projects') value.episodes = values.get(change.id)?.episodes || [];
          values.set(change.id, value);
          positions.set(positionKey(kind, change.id), change.position);
        }
      }
      target[kind] = [...values].sort((left, right) =>
        positions.get(positionKey(kind, left[0])) - positions.get(positionKey(kind, right[0]))).map(([, value]) => value);
    }
    return target;
  }

  function create(options = {}) {
    const key = options.key || 'cue-rights-local-sqlite-v1';
    const queueKey = key + ':record-queue', journalKey = key + ':record-journal';
    const storage = options.storage || global.localStorage;
    const fetcher = options.fetch || global.fetch.bind(global);
    const pack = raw => global.CuePersistence?.encodeCache?.(raw) || raw;
    const unpack = raw => raw && global.CuePersistence?.decodeCache ? global.CuePersistence.decodeCache(raw) : raw;
    const readStored = name => JSON.parse(unpack(storage.getItem(name)) || 'null');
    const writeStored = (name, value) => storage.setItem(name, pack(JSON.stringify(value)));
    const debounceMs = options.debounceMs ?? 300, pollMs = options.pollMs ?? 15000;
    let base = null, current = null, positions = new Map(), revision = 0, pending = null;
    let loaded = false, destroyed = false, conflict = false, externalChange = false, running = null;
    let timer = null, retryTimer = null, pollTimer = null, root = null, draft = false, serverReachable = null;
    let status = {kind: 'loading', message: 'Opening your local database…', pending: false};
    const listeners = new Set();
    const presented = () => ({...status, draft, serverReachable, databaseMessage: status.message,
      message: draft && status.kind !== 'loading' ? 'Unsaved form changes — save the form to sync. ' + status.message : status.message});
    const report = (kind, message, extra = {}) => {
      status = {kind, message, pending: !!pending, revision, ...extra};
      for (const listener of listeners) { try { listener(presented()); } catch (_) {} }
      render();
    };
    const synced = updatedAt => report('synced', 'Saved to local database · Revision ' + revision, {updatedAt});
    const pendingStatus = () => report('pending', 'Saved on this device · Updating local database…');
    const fail = error => {
      report('offline', (pending ? 'Pending edits kept on this device · ' : 'Local database unavailable · ') +
        (error?.message || 'Start the local database and retry.'));
      clearTimeout(retryTimer);
      if (loaded && pending && !destroyed) retryTimer = setTimeout(() => retry(), 5000);
    };
    const block = () => { conflict = true; report('conflict', 'Another tab or database revision changed. Download this copy or load the database copy.'); };
    async function request(path, method = 'GET', body) {
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 30000);
      try {
        const response = await fetcher(path, {method, cache: 'no-store', signal: controller.signal,
          headers: {'Accept': 'application/json', ...(body ? {'Content-Type': 'application/json'} : {})},
          ...(body ? {body: JSON.stringify(body)} : {})});
        serverReachable = true;
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          if (response.status === 401 && global.Event) global.dispatchEvent?.(new global.Event('amishna-auth-expired'));
          const error = new Error(payload?.error?.message || 'Database request failed (HTTP ' + response.status + ')');
          error.status = response.status;
          throw error;
        }
        return payload;
      } catch (error) {
        if (error.name === 'AbortError') throw new Error('The local database request timed out.');
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }
    async function loadRemote(seedFactory) {
      let manifest = await request('/api/workspace/manifest');
      if (manifest.workspace === null) {
        if (manifest.revision !== 0) throw new Error('The existing database needs repair before a new workspace can be created.');
        const workspace = seedFactory();
        await request('/api/workspace', 'PUT', {workspace, expectedRevision: 0});
        manifest = await request('/api/workspace/manifest');
      }
      const next = manifest.workspace, nextPositions = new Map();
      for (const kind of KINDS) next[kind] = [];
      for (const kind of [...KINDS, 'episodes']) {
        const count = manifest.counts[kind] || 0;
        for (let offset = 0; offset < count; offset += PAGE_SIZE) {
          const page = await request('/api/workspace/records?kind=' + kind + '&offset=' + offset + '&limit=' + PAGE_SIZE);
          if (!page || page.records.length !== Math.min(PAGE_SIZE, count - offset)) throw new Error('The database page changed during loading. Refresh to retry.');
          for (const record of page.records) {
            const id = kind === 'episodes' ? episodeKey(record.projectId, record.number) : record.id;
            nextPositions.set(positionKey(kind, id), record.position);
            if (kind === 'episodes') {
              const project = next.projects.find(item => item.id === record.projectId);
              if (!project) throw new Error('An episode references a missing project.');
              (project.episodes ||= []).push(record.value);
            } else next[kind].push(record.value);
          }
        }
      }
      for (const project of next.projects) project.episodes ||= [];
      const latest = await request('/api/workspace/revision');
      if (latest.revision !== manifest.revision) throw new Error('The database changed while loading. Refresh to retry.');
      return {workspace: next, positions: nextPositions, revision: manifest.revision, updatedAt: manifest.updatedAt};
    }
    async function load(seedFactory) {
      if (loaded) return current;
      let savedQueue;
      try { savedQueue = readStored(queueKey); }
      catch { block(); }
      try {
        const journal = readStored(journalKey);
        if (journal) await request('/api/workspace/records', 'PATCH', journal);
        const remote = await loadRemote(seedFactory);
        base = remote.workspace; positions = remote.positions; revision = remote.revision;
        current = clone(base);
        if (savedQueue) {
          if (savedQueue.version !== 2 || !Array.isArray(savedQueue.records) ||
              savedQueue.baseRevision > revision || savedQueue.baseRevision < revision - (journal ? 1 : 0)) block();
          else {
            const desiredPositions = new Map(positions);
            apply(current, savedQueue.records, savedQueue.meta, desiredPositions);
            pending = difference(base, current, positions);
            if (!pending.records.length && !pending.meta) { pending = null; storage.removeItem(queueKey); }
            else writeStored(queueKey, {version: 2, baseRevision: revision, ...pending});
          }
        }
        storage.removeItem(journalKey);
        // The old full browser cache is safe to discard only after SQLite is read.
        const oldMeta = JSON.parse(storage.getItem(key + ':sync') || 'null');
        if (!oldMeta?.pending) { storage.removeItem(key); storage.removeItem(key + ':sync'); }
        loaded = true;
        if (conflict) block();
        else if (pending) { pendingStatus(); schedule(); }
        else synced(remote.updatedAt);
        schedulePoll();
        return current;
      } catch (error) {
        serverReachable = false;
        fail(error);
        throw error;
      }
    }
    function save(workspace) {
      if (!loaded || destroyed || conflict || externalChange) { block(); return false; }
      try {
        const next = difference(base, workspace, positions);
        const raw = JSON.stringify({version: 2, baseRevision: revision, ...next});
        const savedCopy = clone(workspace);
        storage.setItem(queueKey, pack(raw));
        current = savedCopy;
        pending = next.records.length || next.meta ? next : null;
        if (!pending) storage.removeItem(queueKey);
        if (pending) { pendingStatus(); schedule(); }
        else synced();
        return true;
      } catch (error) {
        report('local-error', error?.name === 'QuotaExceededError'
          ? 'Pending import is too large for browser recovery storage. Import fewer worksheets at once.'
          : 'The browser could not keep this change. Check site storage and retry.');
        return false;
      }
    }
    function schedule() { clearTimeout(timer); if (!destroyed && pending && !conflict) timer = setTimeout(() => sync(), debounceMs); }
    function sync() {
      if (!loaded || destroyed || conflict) return Promise.resolve(false);
      if (running) return running;
      clearTimeout(timer);
      clearTimeout(retryTimer);
      running = (async () => {
        try {
          while (pending && !destroyed && !conflict) {
            const snapshot = pending;
            let body = readStored(journalKey);
            if (!body) {
              const latest = await request('/api/workspace/revision');
              if (latest.revision !== revision) { block(); return false; }
              let batch = [], bytes = 0;
              for (const record of snapshot.records) {
                const size = JSON.stringify(record).length;
                if (batch.length && (bytes + size > 512 * 1024 || batch.length >= 500)) break;
                batch.push(record); bytes += size;
              }
              body = {operationId: global.crypto?.randomUUID?.() || String(Date.now()) + '-' + Math.random().toString(36).slice(2),
                expectedRevision: revision, records: batch, ...(snapshot.meta ? {meta: snapshot.meta} : {})};
              writeStored(journalKey, body);
            }
            if (body.expectedRevision !== revision) { block(); return false; }
            report('syncing', 'Saving changed records to local database…');
            const result = await request('/api/workspace/records', 'PATCH', body);
            if (result.revision !== revision + 1) throw new Error('Unexpected database revision.');
            apply(base, body.records, body.meta, positions);
            revision = result.revision;
            pending = difference(base, current, positions);
            if (!pending.records.length && !pending.meta) { pending = null; storage.removeItem(queueKey); }
            else writeStored(queueKey, {version: 2, baseRevision: revision, ...pending});
            storage.removeItem(journalKey);
            if (!pending) synced(result.updatedAt);
          }
          return true;
        } catch (error) {
          if (error.status === 409) block();
          else if (error.status === 400 || error.status === 413) {
            storage.removeItem(journalKey);
            report('error', 'Pending edits kept on this device · ' + error.message);
          }
          else { serverReachable = false; fail(error); }
          return false;
        } finally { running = null; }
      })();
      return running;
    }
    function retry() { if (conflict) return Promise.resolve(false); return sync(); }
    async function checkForUpdates() {
      if (!loaded || destroyed || conflict || pending || running) return false;
      try {
        const latest = await request('/api/workspace/revision');
        if (latest.revision !== revision) {
          conflict = true;
          report('update-available', 'The local database has newer changes. Load the database copy when your form is finished.');
          return false;
        }
        synced(latest.updatedAt);
        return true;
      } catch (error) { serverReachable = false; fail(error); return false; }
    }
    function schedulePoll() { clearTimeout(pollTimer); if (pollMs > 0 && !destroyed) pollTimer = setTimeout(async () => { await checkForUpdates(); schedulePoll(); }, pollMs); }
    function previousRaw() {
      try { const entries = JSON.parse(storage.getItem(key + ':backups') || '[]'); return Array.isArray(entries) ? entries.at(-1)?.raw : null; }
      catch { return null; }
    }
    function downloadBackup(previous = false) {
      const raw = previous ? previousRaw() : current && JSON.stringify(current);
      if (!raw) return false;
      if (options.download) { options.download(raw, previous); return true; }
      const blob = new Blob([raw], {type: 'application/json'});
      const url = URL.createObjectURL(blob), anchor = document.createElement('a');
      anchor.href = url; anchor.download = 'Amishna_' + (previous ? 'Previous_Copy_' : 'Device_Copy_') + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    }
    async function useDatabase() {
      if (pending) downloadBackup();
      try {
        const remote = await loadRemote(() => base);
        base = remote.workspace; current = clone(base); positions = remote.positions; revision = remote.revision;
        pending = null; conflict = externalChange = false;
        storage.removeItem(queueKey); storage.removeItem(journalKey);
        synced(remote.updatedAt); options.onReplace?.(clone(current));
        return true;
      } catch (error) { fail(error); return false; }
    }
    function useDevice() { report('conflict', 'Download this device copy, then resolve the other tab or restore the JSON backup.'); return Promise.resolve(false); }
    function render() {
      if (!root) return;
      const bar = root.ownerDocument.createElement('div');
      bar.className = 'storage-status storage-status--' + status.kind;
      const message = root.ownerDocument.createElement('div');
      message.className = 'storage-status__message'; message.setAttribute('role', 'status');
      message.textContent = presented().message; bar.append(message);
      const actions = root.ownerDocument.createElement('div'); actions.className = 'storage-status__actions';
      const button = (label, action) => { const el = root.ownerDocument.createElement('button'); el.type = 'button'; el.textContent = label; el.addEventListener('click', action); actions.append(el); };
      if (['offline', 'error', 'local-error'].includes(status.kind)) button('Retry', () => retry());
      if (['offline', 'error', 'local-error', 'conflict', 'update-available'].includes(status.kind)) button('Download device copy', () => downloadBackup());
      if (['pending', 'synced'].includes(status.kind)) button('Sync now', () => pending ? sync() : checkForUpdates());
      if (['conflict', 'update-available'].includes(status.kind)) button('Load database copy', () => {
        if (!global.confirm || global.confirm('Load the database copy? A pending device copy will download first.')) useDatabase();
      });
      if (previousRaw()) button('Download previous copy', () => downloadBackup(true));
      if (actions.childNodes.length) bar.append(actions);
      root.replaceChildren(bar);
    }
    const onStorage = event => { if (loaded && event.key === queueKey) { externalChange = true; block(); } };
    const onOnline = () => { if (loaded && pending && !conflict) sync(); };
    const onFocus = () => { if (loaded && !conflict) pending ? sync() : checkForUpdates(); };
    global.addEventListener?.('storage', onStorage);
    global.addEventListener?.('online', onOnline);
    global.addEventListener?.('focus', onFocus);
    return {load, save, sync, retry, checkForUpdates, useDatabase, useDevice, downloadBackup,
      getStatus: presented,
      setDraft(value) { draft = !!value; render(); },
      mount(element) { root = element; render(); },
      subscribe(listener) { listeners.add(listener); listener(presented()); return () => listeners.delete(listener); },
      destroy() { destroyed = true; clearTimeout(timer); clearTimeout(retryTimer); clearTimeout(pollTimer); listeners.clear();
        global.removeEventListener?.('storage', onStorage); global.removeEventListener?.('online', onOnline); global.removeEventListener?.('focus', onFocus); }};
  }
  global.CueLocalRecords = {create, difference, apply};
  if (typeof module !== 'undefined' && module.exports) module.exports = global.CueLocalRecords;
})(typeof window !== 'undefined' ? window : globalThis);
