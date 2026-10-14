const root = document.querySelector('#app'),
  dialog = document.querySelector('#detail');
const state = {
  user: null,
  page: 'Server library',
  catalog: [],
  consoles: [],
  jobs: [],
  sources: [],
  artifacts: [],
  notices: [],
  saveBackups: [],
  query: '',
  register: false,
  selectedConsole: '',
  library: [],
  game: null,
  release: null,
  plan: null,
  connectionError: '',
  manager: {
    status: null,
    jobs: [],
    logs: [],
    accounts: [],
    community: null,
    runtimeSettings: null,
    updatedAt: null,
  },
  managerTab: 'overview',
  logService: '',
  logLevel: '',
  appearance: (() => {
    try {
      return globalThis.localStorage?.getItem('ps5library.appearance') === 'mono'
        ? 'mono'
        : 'default';
    } catch {
      return 'default';
    }
  })(),
};
let websocket,
  refreshing = false,
  eventCursor = 0,
  planRequest = 0,
  detailVineUntil = 0;
const trafficHistory = new Map(),
  TRAFFIC_SAMPLE_LIMIT = 30,
  GIB = 1073741824;
const pageFromLocation = () =>
  location.pathname === '/pair'
    ? 'My PS5s'
    : location.pathname === '/profile'
      ? 'Profile'
      : 'Server library';
const dismissedNotices = new Set(
  (() => {
    try {
      const ids = JSON.parse(
        globalThis.localStorage?.getItem('ps5library.dismissedNotices') || '[]',
      );
      return Array.isArray(ids) ? ids : [];
    } catch {
      return [];
    }
  })(),
);
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const bytes = (n) =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(
    (n || 0) / (n >= 1073741824 ? 1073741824 : 1048576),
  ) + (n >= 1073741824 ? ' GB' : ' MB');
const dataRate = (n) => {
  const value = Math.max(0, Number(n) || 0),
    unit =
      value >= 1073741824
        ? [1073741824, 'GB']
        : value >= 1048576
          ? [1048576, 'MB']
          : value >= 1024
            ? [1024, 'KB']
            : [1, 'B'];
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value / unit[0])} ${unit[1]}`;
};
const friendly = (v) =>
  String(v ?? '')
    .toLowerCase()
    .replaceAll('_', ' ')
    .replace(/^./, (c) => c.toUpperCase());
function setAppearance(value) {
  state.appearance = value === 'mono' ? 'mono' : 'default';
  try {
    globalThis.localStorage?.setItem('ps5library.appearance', state.appearance);
  } catch {}
  document.documentElement?.setAttribute?.('data-appearance', state.appearance);
}
setAppearance(state.appearance);
const releaseLabel = (r) =>
  r.kind === 'DLC'
    ? `DLC: ${r.title || 'Additional content'} · ${r.version}`
    : `${r.kind === 'UPDATE' ? 'Update' : 'Base game'} · ${r.version}`;
const releaseBytes = (r) => r?.artifacts?.find((a) => a.format === 'pkg')?.size ?? r?.size ?? 0;
const releaseOptions = (game, selected) =>
  ['BASE', 'UPDATE', 'DLC']
    .map((kind) => {
      const releases = game.releases.filter((r) => r.kind === kind);
      if (!releases.length) return '';

      const label = kind === 'DLC' ? 'DLC' : kind === 'BASE' ? 'Base game' : 'Updates';
      const options = releases
        .map(
          (release) => `
            <option value="${esc(release.id)}" ${release.id === selected.id ? 'selected' : ''}>
              ${esc(releaseLabel(release))} · ${bytes(releaseBytes(release))}
            </option>`,
        )
        .join('');

      return `<optgroup label="${label}">${options}</optgroup>`;
    })
    .join('');
function toast(text) {
  document.querySelector('#toast').textContent = text;
  setTimeout(() => (document.querySelector('#toast').textContent = ''), 6500);
}
function dismissNotice(id) {
  dismissedNotices.add(id);
  try {
    globalThis.localStorage?.setItem(
      'ps5library.dismissedNotices',
      JSON.stringify([...dismissedNotices].slice(-100)),
    );
  } catch {}
  render();
}
function noticesView() {
  const notices = (state.notices || [])
    .filter(
      (n) =>
        (!state.selectedConsole || n.consoleId === state.selectedConsole) &&
        !dismissedNotices.has(n.id),
    )
    .slice(0, 3);
  if (!notices.length) return '';

  const items = notices
    .map(
      (notice) => `
        <aside class="notice">
          <span>${esc(notice.message)}</span>
          <button
            class="notice-dismiss"
            data-dismiss-notice="${esc(notice.id)}"
            aria-label="Dismiss notification"
          >Dismiss</button>
        </aside>`,
    )
    .join('');

  return `<section class="notice-stack" aria-label="Console notices">${items}</section>`;
}
function reportError(error) {
  const message = error?.message || String(error);
  toast(message);
  if (dialog.open) {
    let box = dialog.querySelector('.dialog-error');
    if (!box) {
      box = document.createElement('p');
      box.className = 'error dialog-error';
      box.setAttribute('role', 'alert');
      dialog.prepend(box);
    }
    box.textContent = message;
  }
}
function focusIdentity(container) {
  const element = document.activeElement;
  if (!element || !container?.contains?.(element)) return null;
  const values = [...element.attributes]
    .filter(({ name }) => ['id', 'name', 'value'].includes(name) || name.startsWith('data-'))
    .map(({ name, value }) => [name, value]);
  return values.length ? values : null;
}
function restoreFocus(container, identity) {
  if (!identity) return false;
  const element = [...container.querySelectorAll('button,input,select,textarea,a,summary')].find(
    (candidate) => identity.every(([name, value]) => candidate.getAttribute(name) === value),
  );
  if (!element) return false;
  element.focus({ preventScroll: true });
  return true;
}
function setDialog(html, focus, preserve = false) {
  const wasOpen = dialog.open,
    focused = preserve ? focusIdentity(dialog) : null;
  dialog.innerHTML = html;
  const title = dialog.querySelector('h1,h2');
  if (title) {
    title.id = 'dialog-title';
    dialog.setAttribute('aria-labelledby', 'dialog-title');
  } else dialog.removeAttribute('aria-labelledby');
  if (!wasOpen) dialog.showModal();
  if (!restoreFocus(dialog, focused) && focus) dialog.querySelector(focus)?.focus();
}
function closeDialog() {
  if (!dialog.open) return;
  if (
    !dialog.querySelector('.detail-grid') ||
    globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
  ) {
    dialog.close();
    return;
  }
  if (dialog.classList.contains('closing')) return;
  dialog.classList.add('closing');
  setTimeout(() => {
    if (!dialog.classList.contains('closing')) return;
    dialog.classList.remove('closing');
    dialog.close();
  }, 190);
}
function closeDialogFromBackdrop(event) {
  if (event.target !== dialog || !dialog.querySelector('.detail-grid')) return;
  const { left, right, top, bottom } = dialog.getBoundingClientRect();
  if (
    event.clientX < left ||
    event.clientX > right ||
    event.clientY < top ||
    event.clientY > bottom
  )
    closeDialog();
}
let pendingConfirmation = null;
function askConfirmation(title, message, label, run) {
  pendingConfirmation = run;
  setDialog(
    `<h1>${esc(title)}</h1>
    <p>${esc(message)}</p>
    <div class="row">
      <button class="danger" data-action="confirm-destructive">${esc(label)}</button>
      <button data-action="cancel-destructive">Cancel</button>
    </div>`,
    '[data-action="cancel-destructive"]',
  );
}
async function api(url, method = 'GET', body) {
  const response = await fetch('/api/v1' + url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    }),
    text = await response.text(),
    value = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = Error(value.message || friendly(value.error) || 'Request failed');
    error.status = response.status;
    throw error;
  }
  return value;
}
function authView() {
  const heading = state.register ? 'A library of your own.' : 'Make yourself at home.';
  const description = state.register
    ? 'Create your personal account on this server.'
    : 'Sign in to your private games, downloads and PS5 consoles.';
  const extraFields = state.register
    ? `<label>Invitation code<input name="inviteToken" autocomplete="off"></label>
      <details>
        <summary>First server account</summary>
        <label>
          Server setup token
          <input type="password" name="bootstrapToken" autocomplete="off">
        </label>
      </details>`
    : '';

  root.innerHTML = `
    <main class="auth">
      <div class="brand">PS5<span>Library</span></div>
      <h1>${heading}</h1>
      <p>${description}</p>
      <form id="auth">
        <label>
          Username
          <input name="username" autocomplete="username" required minlength="3">
        </label>
        <label>
          Password
          <input
            type="password"
            name="password"
            autocomplete="${state.register ? 'new-password' : 'current-password'}"
            required
            minlength="${state.register ? 12 : 1}"
          >
        </label>
        ${extraFields}
        <div id="auth-error" class="error" role="alert"></div>
        <button class="primary">${state.register ? 'Create account' : 'Sign in'}</button>
      </form>
      <button class="link" data-action="toggle-auth">
        ${
          state.register
            ? 'Already have an account? Sign in'
            : 'Have an invitation? Create an account'
        }
      </button>
      <footer>
        Self-hosted and separate from PlayStation Network.<br>
        No PSN account or password is needed.
      </footer>
    </main>`;
}
function offlineView() {
  root.innerHTML = `
    <main class="auth">
      <div class="brand">PS5<span>Library</span></div>
      <h1>Library Server unavailable.</h1>
      <p>Check the server connection, then try again.</p>
      <button class="primary" data-action="retry-connection">Retry</button>
    </main>`;
}
function connectionBanner() {
  return state.connectionError
    ? `<aside
        id="connection-status"
        class="connection-status"
        role="status"
        aria-live="polite"
      >
        <span>${esc(state.connectionError)}</span>
        <button data-action="retry-connection">Retry</button>
      </aside>`
    : '';
}
function syncConnectionBanner() {
  const current = document.querySelector?.('#connection-status');
  if (!state.connectionError) {
    current?.remove?.();
    return;
  }
  if (current) {
    current.outerHTML = connectionBanner();
    return;
  }
  root?.querySelector?.('.site-header')?.insertAdjacentHTML?.('afterend', connectionBanner());
}

const pages = {
  'My library': catalogView,
  'Server library': catalogView,
  Downloads: jobsView,
  Preparing: preparationsView,
  'My PS5s': consolesView,
  'Server cache': cacheView,
  Sources: sourcesView,
  'Saved data': savesPageView,
  'Users & sharing': usersView,
  Account: accountView,
  Profile: profileView,
  'Server manager': managerView,
};
function pageView() {
  return pages[state.page]();
}
function pageClass() {
  return `${['My library', 'Server library'].includes(state.page) ? 'library-main ' : ''}page-${state.page.toLowerCase().replaceAll(' ', '-')}`;
}
function render() {
  const focused = focusIdentity(root);
  if (!state.user) {
    authView();
    return;
  }
  root.innerHTML = `<div class="app-shell ${state.appearance === 'mono' ? 'appearance-mono' : ''}">
    ${nav()}
    ${connectionBanner()}
    <main class="main ${pageClass()}">${pageView()}</main>
    </section>
  </div>`;
  restoreFocus(root, focused);
}
function renderPage() {
  if (!root?.querySelector) return;
  const main = root.querySelector('.main');
  if (!main) {
    render();
    return;
  }
  const focused = focusIdentity(main);
  main.className = `main ${pageClass()}`;
  main.innerHTML = pageView();
  restoreFocus(main, focused);
  syncConnectionBanner();
}
function managerLogQuery() {
  const query = new URLSearchParams({ limit: '200' });
  if (state.logService) query.set('service', state.logService);
  if (state.logLevel) query.set('level', state.logLevel);
  return query;
}
async function refreshManagerLogs() {
  state.manager.logs = await api('/admin/logs?' + managerLogQuery());
  renderPage();
}
async function refresh(redraw = true) {
  if (refreshing || !state.user) return false;
  refreshing = true;
  try {
    const [catalog, consoles, jobs, sources, artifacts, notices] = await Promise.all(
        ['/catalog', '/consoles', '/jobs', '/sources', '/artifacts', '/notifications'].map((x) =>
          api(x),
        ),
      ),
      selectedConsole =
        state.selectedConsole || consoles.find((c) => c.isDefault)?.id || consoles[0]?.id || '',
      library = selectedConsole ? await api(`/consoles/${selectedConsole}/library`) : [];
    let profile = state.profile,
      saveBackups = state.saveBackups,
      manager = state.manager;
    if (['Profile', 'Saved data'].includes(state.page))
      [profile, saveBackups] = await Promise.all([api('/profile'), api('/save-backups')]);
    if (['Server manager', 'Users & sharing'].includes(state.page) && state.user.role === 'ADMIN') {
      const [status, managerJobs, logs, accounts, community, runtimeSettings] = await Promise.all([
        api('/admin/status'),
        api('/admin/jobs?limit=50'),
        api('/admin/logs?' + managerLogQuery()),
        api('/admin/accounts'),
        api('/admin/community'),
        api('/admin/runtime-settings'),
      ]);
      manager = {
        status,
        jobs: managerJobs,
        logs,
        accounts,
        community,
        runtimeSettings,
        updatedAt: Date.now(),
      };
    }
    syncTrafficHistory(jobs);
    Object.assign(state, {
      catalog,
      consoles,
      jobs,
      sources,
      artifacts,
      notices,
      selectedConsole,
      library,
      profile,
      saveBackups,
      manager,
      connectionError: '',
    });
    if (redraw) render();
    else syncConnectionBanner();
    return true;
  } catch (error) {
    state.connectionError = 'Library Server unavailable. Showing your last loaded data.';
    syncConnectionBanner();
    throw error;
  } finally {
    refreshing = false;
  }
}
async function navigate(page) {
  if (page === state.page) return;
  state.page = page;
  history.replaceState({}, '', page === 'Profile' ? '/profile' : '/');
  await refresh(false);
  const draw = () => {
      render();
      globalThis.scrollTo?.(0, 0);
    },
    reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  if (!reduced && document.startViewTransition) document.startViewTransition(draw);
  else {
    draw();
    if (!reduced) root.querySelector('.main')?.classList.add('page-enter');
  }
}
function mergeJobEvent(job, event, trackTraffic = false) {
  if (!job) return false;
  if (job.updatedAt && event.createdAt && Date.parse(event.createdAt) < Date.parse(job.updatedAt))
    return true;
  job.state = event.state;
  const p = event.progress || {};
  for (const key of ['downloadedBytes', 'totalBytes', 'speedBytesPerSecond', 'etaSeconds'])
    if (Object.hasOwn(p, key)) job[key] = p[key];
  if (Object.hasOwn(p, 'conversion')) job.progress = p.conversion;
  job.updatedAt = event.createdAt || job.updatedAt;
  if (trackTraffic) recordTraffic(job);
  return true;
}
function patchVisibleJobs(ids) {
  if (['Downloads', 'Preparing'].includes(state.page)) {
    for (const row of document.querySelectorAll?.('[data-job-id]') || []) {
      if (!ids.has(row.dataset.jobId) || row.contains?.(document.activeElement)) continue;
      const job = state.jobs.find((item) => item.id === row.dataset.jobId);
      if (job) row.outerHTML = downloadJob(job);
    }
    const rate = document.querySelector?.('#downloads-rate');
    if (rate)
      rate.outerHTML = downloadsRateView(
        (state.page === 'Preparing' ? activePreparations() : downloadPageJobs()).filter(
          (job) => !terminalJob(job),
        ),
      );
  }
  if (state.page === 'Server manager') {
    for (const row of document.querySelectorAll?.('[data-manager-job-id]') || []) {
      if (!ids.has(row.dataset.managerJobId) || row.contains?.(document.activeElement)) continue;
      const job = state.manager.jobs.find((item) => item.id === row.dataset.managerJobId);
      if (job) row.outerHTML = managerJob(job);
    }
  }
  const detail = dialog.open && dialog.querySelector?.('[data-detail-job-id]');
  if (detail && ids.has(detail.dataset.detailJobId)) {
    const job = state.jobs.find((item) => item.id === detail.dataset.detailJobId);
    if (job) detail.outerHTML = detailTransferProgress(job);
  }
}
function liveMessage(message) {
  const payload = JSON.parse(message.data);
  if (payload.type !== 'events' || !Array.isArray(payload.events)) return;
  let missing = false,
    terminal = false,
    preparationChanged = false;
  const changed = new Set();
  for (const event of payload.events) {
    eventCursor = Math.max(eventCursor, Number(event.id) || 0);
    changed.add(event.jobId);
    const job = state.jobs.find((item) => item.id === event.jobId),
      before = job?.state,
      beforePreparation = job ? activePreparation(job) : false;
    missing = !mergeJobEvent(job, event, true) || missing;
    if (state.manager?.jobs)
      mergeJobEvent(
        state.manager.jobs.find((item) => item.id === event.jobId),
        event,
      );
    terminal =
      terminal ||
      (before !== event.state &&
        ['COMPLETED', 'READY_ON_PS5', 'ERROR', 'CANCELLED'].includes(event.state));
    preparationChanged =
      preparationChanged || beforePreparation !== Boolean(job && activePreparation(job));
  }
  patchVisibleJobs(changed);
  if (preparationChanged) {
    if (state.page === 'Preparing' && !activePreparations().length) state.page = 'Downloads';
    renderPage();
  }
  if (missing || terminal || preparationChanged)
    refresh(false)
      .then((updated) => {
        if (updated) {
          renderPage();
          if (dialog.open && state.game && state.release) drawDetails();
        }
      })
      .catch(() => {});
}
function connect() {
  websocket?.close();
  websocket = new WebSocket(
    `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/events/live?after=${eventCursor}`,
  );
  websocket.onmessage = (message) => {
    try {
      liveMessage(message);
    } catch {
      websocket.close(1003, 'Invalid event');
    }
  };
  websocket.onclose = () => {
    if (state.user) setTimeout(connect, 3000);
  };
}
document.addEventListener('dragstart', queueDragStart);
document.addEventListener('dragover', queueDragOver);
document.addEventListener('drop', queueDrop);
document.addEventListener('dragend', () => {
  queueDragId = '';
  clearQueueDrop();
});
document.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (button?.dataset.remotePlay) {
    event.preventDefault();
    showRemotePlay(button.dataset.remotePlay).catch((error) => toast(error.message));
  }
});
document.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target,
    data = Object.fromEntries(new FormData(form));
  try {
    if (form.id === 'auth') {
      for (const k of ['bootstrapToken', 'inviteToken']) if (!data[k]) delete data[k];
      const result = await api('/auth/' + (state.register ? 'register' : 'login'), 'POST', data);
      state.user = result.user;
      state.page = pageFromLocation();
      await refresh();
      connect();
    } else if (form.id === 'pair') {
      await api('/pairings/claim', 'POST', {
        code: data.code.trim().toUpperCase(),
        ...(data.consoleId ? { consoleId: data.consoleId } : {}),
      });
      toast('PS5Library connected to your account');
      await refresh();
    } else if (form.id === 'source') {
      if (data.scanIntervalMinutes === '0') delete data.scanIntervalMinutes;
      else data.scanIntervalMinutes = Number(data.scanIntervalMinutes);
      if (!data.tokenEnv) delete data.tokenEnv;
      if (!data.autoPrepare) delete data.autoPrepare;
      data.shareCatalog = data.shareCatalog === 'on';
      const s = await api('/sources', 'POST', data);
      toast('Scanning your collection…');
      await api(`/sources/${s.id}/sync`, 'POST', {});
      await refresh();
    } else if (form.id === 'runtime-settings') {
      const runtime = state.manager.runtimeSettings;
      if (!runtime) throw Error('Runtime settings are not loaded');
      const settings = runtimeSettingsChanges(form, runtime);
      if (!Object.keys(settings).length) {
        toast('No configuration changes to apply');
        return;
      }
      try {
        state.manager.runtimeSettings = await api('/admin/runtime-settings', 'PATCH', {
          revision: runtime.revision,
          settings,
        });
        if (state.manager.status?.features)
          for (const [key, value] of Object.entries(settings))
            if (typeof value === 'boolean') state.manager.status.features[key] = value;
        renderPage();
        toast('Runtime configuration applied');
      } catch (error) {
        if (error.status === 409) {
          state.manager.runtimeSettings = await api('/admin/runtime-settings');
          renderPage();
          throw Error(
            'Configuration changed in another session. Review the latest values and apply again.',
          );
        }
        throw error;
      }
    } else if (form.id === 'community-request') {
      await api('/admin/community/request', 'POST', { displayName: data.displayName });
      await refresh();
      toast('Open the authorization link, then wait for Master approval');
    } else if (form.id === 'game-sharing') {
      const id = state.game.id,
        userIds = [...form.querySelectorAll('input[name="userId"]:checked')].map(
          (input) => input.value,
        );
      await api(`/games/${id}/shares`, 'PUT', { userIds });
      await refresh(false);
      state.game = state.catalog.find((game) => game.id === id);
      drawDetails();
      toast('Game access updated');
    } else if (form.dataset.rename) {
      await api(`/consoles/${form.dataset.rename}`, 'PATCH', { name: data.name });
      await refresh();
    }
  } catch (e) {
    const error = document.querySelector('#auth-error');
    if (form.id === 'auth' && error) error.textContent = e.message;
    else toast(e.message);
  }
});
document.addEventListener('click', async (event) => {
  const b = event.target.closest('button');
  if (!b) return;
  try {
    if (b.dataset.action === 'retry-connection') {
      if (!state.user) {
        location.reload();
        return;
      }
      if (await refresh(false)) renderPage();
      return;
    }
    if (b.dataset.removeGame) {
      const c = state.consoles.find((c) => c.id === state.selectedConsole);
      state.removal = {
        consoleId: c.id,
        releaseId: b.dataset.removeGame,
        storageId: b.dataset.storage,
      };
      const storageName = c.storage.find(
        (storage) => storage.storageId === b.dataset.storage,
      )?.displayName;
      setDialog(
        `<h1>Delete from PS5?</h1>
        <h2>${esc(state.game.title)}</h2>
        <p>${esc(c.name)} · ${esc(storageName || '')}</p>
        <p>Remove this console copy. Your server copy stays available.</p>
        <div class="row">
          <button class="danger" data-action="confirm-remove">Delete from PS5</button>
          <button data-action="keep-game">Keep game</button>
        </div>`,
        '[data-action="keep-game"]',
      );
    }
    if (b.dataset.dismissNotice) {
      dismissNotice(b.dataset.dismissNotice);
      return;
    }
    if (b.dataset.appearance) {
      setAppearance(b.dataset.appearance);
      render();
      return;
    }
    if (b.dataset.action === 'keep-game') drawDetails();
    if (b.dataset.action === 'confirm-remove') {
      const r = state.removal;
      await api(`/consoles/${r.consoleId}/library/remove`, 'POST', {
        releaseId: r.releaseId,
        storageId: r.storageId,
        confirm: true,
      });
      dialog.close();
      state.page = 'Downloads';
      await refresh();
      toast('Removal queued for your PS5');
    }
    if (b.dataset.backupSave) {
      await api(`/consoles/${b.dataset.backupSave}/saves/backups`, 'POST', {
        localUserId: b.dataset.localUserId,
        platform: b.dataset.platform,
        gameTitleId: b.dataset.gameTitle,
        saveTitleId: b.dataset.saveTitle,
        directory: b.dataset.directory,
      });
      await refresh();
      toast('Save backup requested from your PS5');
    }
    if (b.dataset.deleteSaveBackup)
      askConfirmation(
        'Delete this save backup?',
        'The encrypted archive will be permanently removed from this server.',
        'Delete backup',
        async () => {
          await api(`/save-backups/${b.dataset.deleteSaveBackup}`, 'DELETE');
          dialog.close();
          await refresh();
          toast('Save backup deleted');
        },
      );
    if (b.dataset.action === 'confirm-destructive' && pendingConfirmation) {
      const run = pendingConfirmation;
      pendingConfirmation = null;
      await run();
    }
    if (b.dataset.action === 'cancel-destructive') {
      pendingConfirmation = null;
      dialog.close();
    }
    if (b.dataset.action === 'manage-sharing') {
      const shares = await api(`/games/${state.game.id}/shares`);
      setDialog(sharingView(shares), 'input,button');
    }
    if (b.dataset.action === 'back-to-game') drawDetails();
    if (b.dataset.action === 'stop-global-sharing') {
      const id = state.game.id;
      await api(`/games/${id}/sharing`, 'PATCH', { shared: false });
      await refresh(false);
      state.game = state.catalog.find((game) => game.id === id);
      setDialog(sharingView(await api(`/games/${id}/shares`)), 'input,button');
      toast('Server-wide sharing stopped');
    }
    if (b.dataset.action === 'remove-trailer')
      askConfirmation(
        'Remove this trailer?',
        'The cached trailer will be removed from this server.',
        'Remove trailer',
        async () => {
          const id = state.game.id;
          await api(`/games/${id}/trailer`, 'DELETE');
          dialog.close();
          await refresh(false);
          state.game = state.catalog.find((g) => g.id === id);
          drawDetails();
          toast('Trailer removed');
        },
      );
    if (b.dataset.managerTabTarget) state.managerTab = b.dataset.managerTabTarget;
    if (b.dataset.page) {
      if (b.dataset.page === state.page) renderPage();
      else await navigate(b.dataset.page);
    }
    if (b.dataset.managerTab) {
      state.managerTab = b.dataset.managerTab;
      renderPage();
    }
    if (b.dataset.profileTab) {
      state.profileTab = b.dataset.profileTab;
      render();
    }
    if (b.dataset.action === 'reset-avatar') {
      await api('/profile/avatar', 'DELETE', {});
      await refresh();
    }
    if (b.dataset.game) {
      setDetailOrigin(b);
      await details(b.dataset.game);
    }
    if (b.dataset.action === 'toggle-auth') {
      state.register = !state.register;
      render();
    }
    if (b.dataset.action === 'close') closeDialog();
    if (b.dataset.action === 'logout') {
      state.user = null;
      trafficHistory.clear();
      websocket?.close();
      await api('/auth/logout', 'POST', {});
      Object.assign(state, {
        catalog: [],
        consoles: [],
        jobs: [],
        sources: [],
        artifacts: [],
        selectedConsole: '',
        game: null,
        profile: null,
      });
      dialog.close();
      render();
    }
    if (b.dataset.action === 'invite') {
      const i = await api('/admin/invites', 'POST', {});
      document.querySelector('#invite-result').innerHTML =
        `<p>Single use · expires in 7 days</p><label>Invitation code<input readonly value="${esc(i.token)}"></label>`;
    }
    if (b.dataset.sync) {
      await api(`/sources/${b.dataset.sync}/sync`, 'POST', {});
      await refresh();
      toast('Collection scanned');
    }
    if (b.dataset.default) {
      await api(`/consoles/${b.dataset.default}`, 'PATCH', { isDefault: true });
      state.selectedConsole = b.dataset.default;
      await refresh();
    }
    if (b.dataset.refreshConsole) {
      await api(`/consoles/${b.dataset.refreshConsole}/refresh`, 'POST', {});
      toast('Firmware refresh requested for the next console connection');
    }
    if (b.dataset.testNotification) {
      await api(`/consoles/${b.dataset.testNotification}/notifications/test`, 'POST', {});
      toast('Notification queued for your PS5');
    }
    if (b.dataset.revoke)
      askConfirmation(
        'Revoke this console?',
        'This PS5 will lose access and must be paired again.',
        'Revoke access',
        async () => {
          await api(`/consoles/${b.dataset.revoke}/revoke`, 'POST', {});
          dialog.close();
          await refresh();
          toast('Device credential revoked');
        },
      );
    if (b.dataset.forgetConsole)
      askConfirmation(
        'Remove this console record?',
        'This deletes its saved identity, jobs, console library state and recovery key. The PS5 must be registered again.',
        'Remove console',
        async () => {
          await api(`/admin/consoles/${b.dataset.forgetConsole}`, 'DELETE');
          dialog.close();
          state.selectedConsole = '';
          await refresh();
          toast('Console record removed');
        },
      );
    if (b.dataset.delete)
      askConfirmation(
        'Delete this cached package?',
        'The verified server copy will be removed. Original source files and PS5 installs stay available.',
        'Delete cached copy',
        async () => {
          const result = await api(`/artifacts/${b.dataset.delete}`, 'DELETE');
          dialog.close();
          await refresh();
          toast(`${bytes(result.freedBytes)} removed from the server cache`);
        },
      );
    if (b.dataset.dismissJob) {
      await api(`/jobs/${b.dataset.dismissJob}`, 'DELETE');
      await refresh();
      toast('Download history dismissed');
    }
    if (b.dataset.control) {
      await api(`/jobs/${b.dataset.control}/control`, 'POST', { action: b.dataset.command });
      await refresh();
    }
    if (b.dataset.prepare) {
      b.disabled = true;
      b.setAttribute('aria-busy', 'true');
      const result = await api('/preparations', 'POST', {
        sourceReleaseId: b.dataset.sourceRelease,
        method: b.dataset.prepare,
      });
      dialog.close();
      state.page = result.cached ? 'Server cache' : 'Preparing';
      await refresh();
      toast(result.cached ? 'Reusing your verified cached package' : 'Preparation queued');
    }
    if (b.dataset.action === 'download') {
      b.disabled = true;
      b.setAttribute('aria-busy', 'true');
      await api('/downloads', 'POST', { sourceReleaseId: b.dataset.sourceRelease });
      dialog.close();
      state.page = 'Downloads';
      await refresh();
    }
    if (b.dataset.action === 'transfer') {
      const plan = state.plan;
      if (
        !plan ||
        !plan.artifactId ||
        plan.releaseId !== state.release?.id ||
        plan.consoleId !== state.selectedConsole
      )
        throw Error('Transfer plan is no longer current');
      const selected = dialog.querySelector('input[name="destination"]:checked');
      if (!selected) throw Error('Select a storage destination');
      const queued = await api('/transfers', 'POST', {
        artifactId: plan.artifactId,
        consoleId: plan.consoleId,
        storageId: selected.value,
      });
      if (!state.jobs.some((job) => job.id === queued.id))
        state.jobs.unshift({
          id: queued.id,
          kind: 'TRANSFER',
          releaseId: plan.releaseId,
          consoleId: plan.consoleId,
          storageId: selected.value,
          state: 'QUEUED_FOR_PS5',
          downloadedBytes: 0,
          totalBytes: null,
        });
      drawDetails();
      while (refreshing) await new Promise((resolve) => setTimeout(resolve, 25));
      await refresh(false);
      drawDetails();
      toast('Download queued for your PS5');
    }
  } catch (e) {
    b.disabled = false;
    b.removeAttribute('aria-busy');
    reportError(e);
  }
});
document.addEventListener('change', async (event) => {
  try {
    if (event.target.closest?.('#runtime-settings')) syncRuntimeApply(event.target.form);
    if (event.target.id === 'trailer-upload') {
      const file = event.target.files?.[0];
      if (file) await uploadTrailer(file);
    }
    if (event.target.id === 'profile-picture') {
      const file = event.target.files?.[0];
      if (!file) return;
      if (file.size > 4 * 1024 ** 2) throw Error('Choose an image smaller than 4 MB');
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      await api('/profile/avatar', 'POST', { data });
      await refresh();
      toast('Account picture updated');
    }
    if (event.target.dataset.consoleSelect) {
      state.selectedConsole = event.target.value;
      if (dialog.open) {
        state.library = state.selectedConsole
          ? await api(`/consoles/${state.selectedConsole}/library`)
          : [];
        await updatePlan();
      } else await refresh();
    }
    if (event.target.id === 'release-select') {
      state.release = state.game.releases.find((r) => r.id === event.target.value);
      await updatePlan();
    }
  } catch (e) {
    toast(e.message);
  }
});
document.addEventListener('input', (event) => {
  if (event.target.closest?.('#runtime-settings')) syncRuntimeApply(event.target.form);
  if (event.target.id === 'search') {
    state.query = event.target.value;
    if (!['My library', 'Server library'].includes(state.page)) {
      state.page = 'Server library';
      render();
      document.querySelector('#search')?.focus();
      return;
    }
    const view = document.querySelector('#catalog-view');
    if (view) view.outerHTML = catalogView();
  }
});
document.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (button?.dataset.action === 'refresh-manager')
    refresh().catch((error) => toast(error.message));
});
document.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  try {
    if (button.dataset.restartService) {
      const service = button.dataset.restartService;
      setDialog(
        `<h1>Restart ${esc(friendly(service))}?</h1>
        <p>
          Active work using this service may pause briefly. Docker will keep its persistent data
          and restart the same container.
        </p>
        <div class="row">
          <button class="danger" data-confirm-restart="${esc(service)}">Restart service</button>
          <button data-action="cancel-admin-action">Cancel</button>
        </div>`,
        '[data-action="cancel-admin-action"]',
      );
    }
    if (button.dataset.confirmRestart) {
      const service = button.dataset.confirmRestart;
      await api(`/admin/services/${service}/restart`, 'POST', { confirm: service });
      dialog.close();
      toast(`${friendly(service)} restart requested`);
      setTimeout(() => refresh().catch(() => {}), 4000);
    }
    if (button.dataset.action === 'clear-logs') {
      setDialog(
        `<h1>Clear all application logs?</h1>
        <p>
          This removes current and rotated server and worker log files. Service data and audit
          records stored in the database are not changed.
        </p>
        <div class="row">
          <button class="danger" data-action="confirm-clear-logs">Clear logs</button>
          <button data-action="cancel-admin-action">Cancel</button>
        </div>`,
        '[data-action="cancel-admin-action"]',
      );
    }
    if (button.dataset.action === 'confirm-clear-logs') {
      await api('/admin/logs', 'DELETE');
      dialog.close();
      await refresh();
      toast('Application logs cleared');
    }
    if (button.dataset.action === 'cancel-admin-action') dialog.close();
  } catch (error) {
    toast(error.message);
  }
});
document.addEventListener('change', (event) => {
  if (event.target.id === 'manager-service') {
    state.logService = event.target.value;
    refreshManagerLogs().catch((error) => toast(error.message));
  }
  if (event.target.id === 'manager-level') {
    state.logLevel = event.target.value;
    refreshManagerLogs().catch((error) => toast(error.message));
  }
});
document.addEventListener('click', async (event) => {
  const action = event.target.closest('button')?.dataset.action;
  if (!['refresh-community', 'disconnect-community'].includes(action)) return;
  try {
    if (action === 'refresh-community') {
      await api('/admin/community/refresh', 'POST', {});
      await refresh();
      toast('Community status refreshed');
    }
    if (action === 'disconnect-community')
      askConfirmation(
        'Disconnect Community Master?',
        'Community saves, friends and groups will stop synchronizing until you connect again.',
        'Disconnect',
        async () => {
          await api('/admin/community', 'DELETE');
          dialog.close();
          await refresh();
          toast('Community disconnected');
        },
      );
  } catch (error) {
    toast(error.message);
  }
});
document.addEventListener('keydown', (event) => {
  const tab = event.target.closest?.('[role="tab"][data-manager-tab]');
  if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = [...tab.closest('[role="tablist"]').querySelectorAll('[role="tab"]')],
    index = tabs.indexOf(tab),
    next =
      event.key === 'Home'
        ? tabs[0]
        : event.key === 'End'
          ? tabs.at(-1)
          : tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
  event.preventDefault();
  state.managerTab = next.dataset.managerTab;
  renderPage();
  document.querySelector(`[data-manager-tab="${state.managerTab}"]`)?.focus();
});
dialog.addEventListener('click', closeDialogFromBackdrop);
dialog.addEventListener('cancel', (event) => {
  if (dialog.querySelector('.detail-grid')) {
    event.preventDefault();
    closeDialog();
  }
});
dialog.addEventListener('close', () => {
  pendingConfirmation = null;
  dialog.classList.remove('closing');
});
setInterval(async () => {
  if (state.user && savedDataVisible() && !refreshing)
    try {
      state.saveBackups = await api('/save-backups');
      const selected =
          (state.profile?.consoles || []).find((console) => console.id === state.selectedConsole) ||
          (state.profile?.consoles || [])[0],
        view = document.querySelector('#save-backups-view');
      if (selected && view && !view.contains(document.activeElement))
        view.outerHTML = saveBackupsView(selected);
    } catch (error) {
      toast(error.message);
    }
}, 5000);
setInterval(() => {
  if (
    state.user &&
    dialog.open &&
    state.game?.trailerState &&
    ['QUEUED', 'PREPARING'].includes(state.game.trailerState)
  ) {
    const id = state.game.id;
    refresh(false)
      .then(() => {
        if (dialog.open && state.game?.id === id) {
          state.game = state.catalog.find((g) => g.id === id);
          const panel = document.querySelector('#trailer-panel');
          if (panel) panel.outerHTML = trailerPanel(state.game);
        }
      })
      .catch(() => {});
  }
  if (
    state.user &&
    !dialog.open &&
    !root.contains(document.activeElement) &&
    ['My library', 'Server library', 'Downloads', 'Preparing', 'Server cache'].includes(state.page)
  )
    refresh(false)
      .then((updated) => {
        if (updated) renderPage();
      })
      .catch(() => {});
}, 30000);
(async () => {
  try {
    state.user = await api('/me');
  } catch (error) {
    if (error.status === 401) authView();
    else offlineView();
    return;
  }
  state.page = pageFromLocation();
  try {
    await refresh();
  } catch {
    render();
  }
  connect();
})();
