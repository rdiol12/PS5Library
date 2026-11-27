'use strict';
const root = document.querySelector('#app'),
  dialog = document.querySelector('#detail');
const state = {
  user: null,
  page: (() => {
    try {
      const saved = localStorage.getItem('ps5lib.page');
      return [
        'Server library',
        'My library',
        'Downloads',
        'Preparing',
        'My PS5s',
        'Saved data',
        'Sources',
        'Server cache',
        'Users & sharing',
        'Server manager',
        'Account',
      ].includes(saved)
        ? saved
        : 'Server library';
    } catch {
      return 'Server library';
    }
  })(),
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
  selectedGameId: '',
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
const terminalJob = (job) =>
  ['COMPLETED', 'READY_ON_PS5', 'ERROR', 'CANCELLED'].includes(job.state);
const savedDataVisible = () =>
  state.page === 'Saved data' || (state.page === 'Profile' && state.profileTab === 'saves');
function recordTraffic(job) {
  if (!job?.id || job.kind !== 'BUILD') return;
  if (terminalJob(job)) {
    trafficHistory.delete(job.id);
    return;
  }
  if (job.speedBytesPerSecond == null) return;
  const speed = Number(job.speedBytesPerSecond);
  if (!Number.isFinite(speed) || speed < 0) return;
  const samples = trafficHistory.get(job.id) || [];
  samples.push(speed);
  if (samples.length > TRAFFIC_SAMPLE_LIMIT)
    samples.splice(0, samples.length - TRAFFIC_SAMPLE_LIMIT);
  trafficHistory.set(job.id, samples);
}
function syncTrafficHistory(jobs) {
  const ids = new Set(jobs.map((job) => job.id));
  for (const id of trafficHistory.keys()) if (!ids.has(id)) trafficHistory.delete(id);
  for (const job of jobs) recordTraffic(job);
}
function trafficGraph(job) {
  const samples = trafficHistory.get(job.id) || [];
  if (!samples.length)
    return `<section class="traffic-graph traffic-empty">
      <div><strong>Network traffic</strong><span>No network activity</span></div>
    </section>`;
  const current = samples.at(-1),
    peak = Math.max(...samples),
    width = 260,
    height = 42,
    ceiling = Math.max(peak, 1),
    points = samples
      .map(
        (speed, index) =>
          `${samples.length === 1 ? width / 2 : (index * width) / (samples.length - 1)},${height - 2 - (speed / ceiling) * (height - 6)}`,
      )
      .join(' '),
    label = `Network traffic. Current ${dataRate(current)} per second. Peak ${dataRate(peak)} per second.`;
  const chart =
    samples.length === 1
      ? `<circle cx="${width / 2}" cy="${points.split(',')[1]}" r="2.5"/>`
      : `<polyline points="${points}"/>`;

  return `<section class="traffic-graph">
    <div>
      <strong>Network traffic</strong>
      <span>
        <b>Current ${dataRate(current)}/s</b>
        <small>Peak ${dataRate(peak)}/s</small>
      </span>
    </div>
    <svg
      class="traffic-sparkline"
      viewBox="0 0 ${width} ${height}"
      preserveAspectRatio="none"
      role="img"
      aria-label="${esc(label)}"
    >
      <path class="traffic-baseline" d="M0 ${height - 2}H${width}"/>
      ${chart}
    </svg>
  </section>`;
}
const activePreparation = (job) =>
  job.kind === 'BUILD' && job.state !== 'PAUSED' && !terminalJob(job);
const activePreparations = () => state.jobs.filter(activePreparation);
const watchStages = {
  STABILIZING: 'Waiting for files to settle',
  INSPECTING: 'Inspecting source',
  HASHING: 'Hashing source files',
};
const watchPreparations = () =>
  state.sources.flatMap((source) =>
    (source.observations || [])
      .filter((observation) => watchStages[observation.state])
      .map((observation) => ({
        id: `watch:${source.id}:${observation.path}`,
        kind: 'WATCH',
        state: observation.state,
        title:
          observation.details?.title ||
          String(observation.path).split(/[\\/]/).filter(Boolean).at(-1),
        progress: { stage: watchStages[observation.state] },
      })),
  );
const preparationItems = () => [
  ...watchPreparations(),
  ...state.jobs.filter(
    (job) => activePreparation(job) || (job.kind === 'BUILD' && job.state === 'ERROR'),
  ),
];
const downloadPageJobs = () => state.jobs.filter((job) => job.kind !== 'BUILD');
const installedEntry = (release) =>
  state.library.find((entry) => entry.releaseId === release?.id && entry.state === 'READY_ON_PS5');
const activeDetailTransfer = () =>
  state.jobs.find(
    (job) =>
      job.kind === 'TRANSFER' &&
      job.releaseId === state.release?.id &&
      job.consoleId === state.selectedConsole &&
      !terminalJob(job),
  );
const navIcons = {
  library:
    '<rect x="3" y="4" width="7" height="7"/><rect x="14" y="4" width="7" height="7"/><rect x="3" y="15" width="7" height="6"/><rect x="14" y="15" width="7" height="6"/>',
  console: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  activity: '<path d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14"/>',
  prepare: '<path d="M4 6h16M7 3v6m10-6v6M5 11h14v9H5z"/>',
  source: '<path d="M4 5h7l2 3h7v11H4z"/>',
  cache: '<path d="M4 7h16v12H4zM8 3h8v4M9 12h6"/>',
  users:
    '<circle cx="9" cy="8" r="3"/><path d="M3 20c.5-4 2.5-6 6-6s5.5 2 6 6m1-11a3 3 0 0 1 0 6m1 1c2 .6 3.2 1.9 4 4"/>',
  save: '<path d="M5 3h12l2 2v16H5zM8 3v6h8V3M8 17h8"/>',
  system: '<path d="M3 12h4l2-5 4 10 2-5h6"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M19 5l-2 2M7 17l-2 2"/>',
};
const navIcon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${navIcons[name]}</svg>`;
function nav() {
  const console = state.consoles.find((c) => c.id === state.selectedConsole),
    presence = console?.presence || 'OFFLINE',
    avatar = state.profile?.avatarUrl
      ? `<img src="${esc(state.profile.avatarUrl)}" alt="">`
      : `<span>${esc(state.user.username.slice(0, 1).toUpperCase())}</span>`,
    workspace = [
      ['Server library', 'Library', 'library'],
      ['My library', 'My PS5', 'console'],
      ['Downloads', 'Activity', 'activity'],
      ['Preparing', 'Preparation', 'prepare'],
      ['My PS5s', 'Consoles', 'console'],
      ['Saved data', 'Saved data', 'save'],
    ],
    manage = [
      ['Sources', 'Sources', 'source'],
      ['Server cache', 'Server cache', 'cache'],
      ...(state.user.role === 'ADMIN'
        ? [
            ['Users & sharing', 'Users & sharing', 'users'],
            ['Server manager', 'System & logs', 'system'],
          ]
        : []),
      ['Account', 'Settings', 'settings'],
    ],
    item = ([page, label, icon]) => {
      const active = state.page === page;
      const count = page === 'Preparing' ? preparationItems().length : 0;
      return `<button
        data-page="${page}"
        aria-label="${esc(label)}"
        class="${active ? 'active' : ''}"
        ${active ? 'aria-current="page"' : ''}
      >
        ${navIcon(icon)}
        <span>${esc(label)}</span>
        ${count ? `<b>${count}</b>` : ''}
      </button>`;
    },
    status = console ? `${esc(console.name)} · ${friendly(presence)}` : 'No PS5 selected';

  return `<aside class="site-sidebar">
    <button class="side-brand" data-page="Server library" aria-label="PS5Library home">
      <svg class="brand-mark" viewBox="0 0 48 36" aria-hidden="true">
        <path
          d="M13 8c-4 0-6.4 2.9-7.8 7.7L2.8 24c-1.2 4.1.4 6.4 3.6 6.4 3 0 5.1-4.6 7.1-6.6h21c2 2 4 6.6 7.1 6.6 3.2 0 4.8-2.3 3.6-6.4l-2.4-8.3C41.4 10.9 39 8 35 8H13Z"
          fill="currentColor"
        />
        <path
          d="M13 14v7M9.5 17.5h7M33 15.7h.1M37.6 20.3h.1"
          stroke="currentColor"
          stroke-width="2.2"
          stroke-linecap="round"
        />
      </svg>
      <span><b>PS5</b>Library</span>
    </button>
    <nav class="side-nav" aria-label="Library manager">
      <small>Workspace</small>
      ${workspace.map(item).join('')}
      <small>Manage</small>
      ${manage.map(item).join('')}
    </nav>
    <button
      class="sidebar-account ${state.page === 'Profile' ? 'active' : ''}"
      data-page="Profile"
      aria-label="Profile for ${esc(state.user.username)}"
    >
      <span class="profile-button">${avatar}</span>
      <span>
        <strong>${esc(state.user.username)}</strong>
        <small>${state.user.role === 'ADMIN' ? 'Administrator' : 'Library member'}</small>
      </span>
    </button>
  </aside>
  <section class="workspace">
    <header class="site-header">
      <label class="header-search">
        <span class="visually-hidden">Search games</span>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.5"/>
          <path d="m15.5 15.5 5 5"/>
        </svg>
        <input
          id="search"
          type="search"
          placeholder="Search games, title IDs or publishers"
          value="${esc(state.query)}"
        >
      </label>
      <div class="header-tools">
        <span class="server-state ${presence.toLowerCase()}"><i></i>${status}</span>
        <details class="notification-menu">
          <summary aria-label="Notifications">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6.5 9.5a5.5 5.5 0 0 1 11 0c0 6 2.5 6.5 2.5 6.5H4s2.5-.5 2.5-6.5Z"/>
              <path d="M9.5 19a3 3 0 0 0 5 0"/>
            </svg>
            ${(state.notices || []).length ? '<i></i>' : ''}
          </summary>
          <div class="notification-popover">
            ${noticesView() || '<p>No new notifications.</p>'}
          </div>
        </details>
      </div>
    </header>`;
}
const onConsole = (g) =>
  g.releases.some(
    (r) =>
      r.kind !== 'DLC' &&
      state.library.some((l) => l.releaseId === r.id && l.state === 'READY_ON_PS5'),
  );
const onServer = (g) =>
  g.releases.some((r) => r.kind !== 'DLC' && (r.sources?.length || 0 || r.artifacts?.length || 0));
function catalogGames() {
  const query = state.query.trim().toLowerCase();
  return state.catalog
    .filter(
      (g) =>
        !query ||
        [g.title, g.titleId, g.publisher, ...(g.genres || [])]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(query),
    )
    .filter((g) => (state.page === 'My library' ? onConsole(g) : onServer(g)));
}
let queueDragId = '',
  queueDropAfter = false,
  queueReordering = false;
function orderedQueuedJobs() {
  return state.jobs
    .filter((job) => job.state === 'QUEUED' && ['DOWNLOAD', 'BUILD'].includes(job.kind))
    .sort(
      (a, b) =>
        (a.queuePosition ?? Number.MAX_SAFE_INTEGER) - (b.queuePosition ?? Number.MAX_SAFE_INTEGER),
    );
}
function reorderedQueueIds(sourceId, targetId, after) {
  const jobs = orderedQueuedJobs(),
    ids = jobs.map((job) => job.id),
    source = jobs.find((job) => job.id === sourceId);
  if (!source || sourceId === targetId) return ids;
  const sameKind = jobs.filter((job) => job.kind === source.kind).map((job) => job.id),
    from = sameKind.indexOf(sourceId);
  sameKind.splice(from, 1);
  const target = sameKind.indexOf(targetId);
  if (target < 0) return ids;
  sameKind.splice(target + (after ? 1 : 0), 0, sourceId);
  let index = 0;
  return jobs.map((job) => (job.kind === source.kind ? sameKind[index++] : job.id));
}
function animateQueueOrder(ids) {
  const queue = document.querySelector?.('.download-queue'),
    rows = [...(queue?.querySelectorAll?.('[data-queue-job]') || [])];
  if (!queue?.replaceChildren || rows.length < 2) return Promise.resolve();
  const byId = new Map(rows.map((row) => [row.dataset.queueJob, row])),
    ordered = ids.map((id) => byId.get(id)).filter(Boolean);
  if (ordered.length !== rows.length) return Promise.resolve();
  const before = new Map(rows.map((row) => [row, row.getBoundingClientRect().top]));
  let index = 0;
  queue.replaceChildren(
    ...[...queue.children].map((child) =>
      child.matches?.('[data-queue-job]') ? ordered[index++] : child,
    ),
  );
  if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches)
    return Promise.resolve();
  return Promise.all(
    ordered.flatMap((row) => {
      const distance = before.get(row) - row.getBoundingClientRect().top;
      if (Math.abs(distance) < 1 || !row.animate) return [];
      row.classList.add('queue-sorting');
      const animation = row.animate(
        [
          { transform: `translateY(${distance}px)`, opacity: 0.78 },
          { transform: 'translateY(0)', opacity: 1 },
        ],
        { duration: 220, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
      );
      return [
        Promise.resolve(animation.finished)
          .catch(() => {})
          .finally(() => row.classList.remove('queue-sorting')),
      ];
    }),
  );
}
function clearQueueDrop() {
  for (const row of document.querySelectorAll?.(
    '.queue-drop-before,.queue-drop-after,.queue-dragging',
  ) || [])
    row.classList.remove('queue-drop-before', 'queue-drop-after', 'queue-dragging');
}
function queueDragStart(event) {
  const row = event.target.closest?.('[data-queue-job]');
  if (!row) return;
  if (queueReordering) {
    event.preventDefault();
    return;
  }
  queueDragId = row.dataset.queueJob;
  row.classList.add('queue-dragging');
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', queueDragId);
  }
}
function queueDragOver(event) {
  const row = event.target.closest?.('[data-queue-job]');
  if (!queueDragId || !row || row.dataset.queueJob === queueDragId) return;
  event.preventDefault();
  for (const item of document.querySelectorAll?.('.queue-drop-before,.queue-drop-after') || [])
    item.classList.remove('queue-drop-before', 'queue-drop-after');
  const box = row.getBoundingClientRect(),
    after = event.clientY > box.top + box.height / 2;
  queueDropAfter = after;
  row.classList.add(after ? 'queue-drop-after' : 'queue-drop-before');
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
}
async function queueDrop(event) {
  const row = event.target.closest?.('[data-queue-job]'),
    sourceId = queueDragId;
  clearQueueDrop();
  queueDragId = '';
  if (!sourceId || !row) return;
  event.preventDefault();
  if (queueReordering) return;
  queueReordering = true;
  const ids = reorderedQueueIds(sourceId, row.dataset.queueJob, queueDropAfter),
    movement = animateQueueOrder(ids);
  try {
    await api('/jobs/reorder', 'POST', { ids });
    await movement;
    while (refreshing) await new Promise((resolve) => setTimeout(resolve, 25));
    await refresh(false);
    render();
    toast('Queue order updated');
  } catch (error) {
    await movement;
    renderPage();
    reportError(error);
  } finally {
    queueReordering = false;
  }
}

function webGameCard(game, consoleLibrary) {
  const release =
      game.releases.find((item) => item.kind === 'UPDATE') ||
      game.releases.find((item) => item.kind === 'BASE'),
    prepared = release?.artifacts?.length,
    status = consoleLibrary ? 'Ready to play' : prepared ? 'Ready on server' : 'Ready to prepare',
    tone = consoleLibrary || prepared ? 'ready' : 'source',
    version = release?.version ? ` · v${esc(release.version)}` : '',
    size = releaseBytes(release) ? ` · ${bytes(releaseBytes(release))}` : '';

  return `<button class="web-game" data-game="${esc(game.id)}">
    <span class="web-game-art">
      <img
        loading="lazy"
        decoding="async"
        src="${esc(game.heroUrl || game.coverUrl)}"
        alt="Artwork for ${esc(game.title)}"
      >
      <span class="web-game-state ${tone}">${esc(status)}</span>
    </span>
    <span class="web-game-copy">
      <strong>${esc(game.title)}</strong>
      <small>${esc(game.titleId || 'Title ID pending')}${version}${size}</small>
    </span>
  </button>`;
}
function catalogView() {
  const games = catalogGames(),
    searching = Boolean(state.query.trim()),
    consoleLibrary = state.page === 'My library',
    title = searching ? 'Search results' : consoleLibrary ? 'My PS5' : 'Library',
    description = searching
      ? `Matches for “${state.query.trim()}”`
      : consoleLibrary
        ? 'Games confirmed by the selected console.'
        : 'Authorized content available on this server.',
    ready = games.filter((game) =>
      game.releases.some((release) => release.artifacts?.length),
    ).length;
  const headerAction = consoleLibrary
    ? consoleSelect('library')
    : state.user.role === 'ADMIN'
      ? '<button class="primary" data-page="Sources">Add content</button>'
      : '';
  const emptyTitle = searching
    ? 'No matching games'
    : consoleLibrary
      ? 'No games reported by this PS5'
      : 'No games on this server yet';
  const emptyMessage = searching
    ? 'Try a title, publisher, genre, or title ID.'
    : consoleLibrary
      ? 'Choose another console or refresh its inventory.'
      : 'Scan an authorized dump folder or add a source to begin.';
  const content = games.length
    ? `<div class="catalog-summary">
        <span id="result-count" role="status">
          <strong>${games.length}</strong> ${games.length === 1 ? 'game' : 'games'}
        </span>
        ${
          consoleLibrary
            ? ''
            : `<span>${ready} prepared</span>
              <span>${Math.max(0, games.length - ready)} ready to prepare</span>`
        }
      </div>
      <div class="web-game-grid">
        ${games.map((game) => webGameCard(game, consoleLibrary)).join('')}
      </div>`
    : `<div class="empty">
        <h2>${emptyTitle}</h2>
        <p>${emptyMessage}</p>
        ${
          !searching && state.page === 'Server library'
            ? '<button data-page="Sources">Manage sources</button>'
            : ''
        }
      </div>`;

  return `<section id="catalog-view" class="catalog-workspace">
    <header class="page-heading">
      <div><h1>${esc(title)}</h1><p>${esc(description)}</p></div>
      ${headerAction}
    </header>
    ${content}
  </section>`;
}
function consoleSelect(context) {
  const options = state.consoles
    .map(
      (console) => `<option
        value="${esc(console.id)}"
        ${console.id === state.selectedConsole ? 'selected' : ''}
      >${esc(console.name)} · ${friendly(console.presence)}</option>`,
    )
    .join('');

  return `<label>
    My PS5
    <select id="console-select-${context}" data-console-select="${context}">
      <option value="">Select a console</option>
      ${options}
    </select>
  </label>`;
}
function progress(job) {
  if (job.kind === 'DELETE')
    return job.state === 'COMPLETED'
      ? '<p>Removed from PS5; inventory confirmed.</p>'
      : ['ERROR', 'CANCELLED'].includes(job.state)
        ? ''
        : '<progress aria-label="Removing game"></progress><p>Removing the game from your PS5.</p>';
  if (job.kind === 'BUILD') {
    const p = job.progress,
      terminal = ['COMPLETED', 'ERROR', 'CANCELLED'].includes(job.state),
      stage = terminal ? friendly(job.state) : p?.stage || friendly(job.state);
    if (job.state === 'DOWNLOADING') {
      const done = Number(job.downloadedBytes || 0),
        total = Number(job.totalBytes || 0),
        percent = total ? Math.max(0, Math.min(100, Math.floor((done * 100) / total))) : null;
      return `<h4>${esc(stage)}</h4>
        <progress
          aria-label="Downloaded source bytes"
          max="${total || 1}"
          ${total ? `value="${done}"` : ''}
        ></progress>
        <p class="metrics">
          ${percent == null ? '' : percent + '% · '}${bytes(done)}${
            total ? ' / ' + bytes(total) : ' downloaded'
          }
        </p>`;
    }
    const measured = jobBytes(job),
      done = measured?.completedBytes,
      total = measured?.totalBytes,
      known = Boolean(measured);
    const stageProgress = !terminal
      ? `<progress
          aria-label="${esc(stage)}"
          max="${known ? total : 1}"
          ${known ? `value="${done}"` : ''}
        ></progress>`
      : '';
    const metrics = known
      ? `${Math.floor((done * 100) / total)}% · ${bytes(done)} / ${bytes(total)}`
      : esc(stage);
    const creator = {
      CREATING: 'Creating backport (Experimental). Console testing is still required.',
      CREATED: 'Experimental backport created. Console testing is still required.',
      SKIPPED_EXISTING: 'Skipped: existing backport folder. Experimental creator did not run.',
      DISABLED: 'Experimental backport creation is disabled.',
      NOT_REQUIRED: 'Experimental analysis found no backport changes needed.',
      NEEDS_REVIEW: 'Experimental backport needs review. Package build stopped.',
      FAILED: 'Experimental backport creation failed. Package build stopped.',
    }[p?.backportCreation?.state];
    const stageView = `<h4>${esc(stage)}</h4>${stageProgress}<p class="metrics">${metrics}</p>${creator ? `<p class="metrics">${esc(creator)}</p>` : ''}`;
    if (state.user.role !== 'ADMIN' || !p) return stageView;
    return (
      stageView +
      `<div class="cols">${[
        [
          p.package?.method || 'Package',
          p.package || { state: job.state === 'COMPLETED' ? 'VERIFIED' : 'WAITING' },
          false,
        ],
        ['Compatibility files', p.fakelib || { state: 'UNKNOWN' }, job.compatibilityFilesSupplied],
      ]
        .map(([name, c, supplied]) => {
          const complete = job.state === 'COMPLETED' && c.state === 'VERIFIED',
            pending = supplied && c.state === 'NOT_REQUIRED',
            absent = !supplied && c.state === 'NOT_REQUIRED',
            unknown = c.state === 'UNKNOWN';
          const indicator =
            !absent && !unknown && !terminal
              ? `<progress
                  aria-label="${esc(name)} preparation"
                  max="1"
                  ${complete ? 'value="1"' : ''}
                ></progress>`
              : '';
          const message = pending
            ? 'Files supplied · waiting'
            : absent
              ? 'No compatibility files supplied'
              : unknown
                ? 'Not reported by this build'
                : terminal
                  ? friendly(job.state)
                  : complete
                    ? 'Files verified'
                    : friendly(c.state);
          return `<div><h4>${esc(name)}</h4>${indicator}<small>${esc(message)}</small></div>`;
        })
        .join('')}</div>`
    );
  }
  const percent = job.totalBytes
    ? Math.max(0, Math.min(100, Math.floor((job.downloadedBytes * 100) / job.totalBytes)))
    : null;
  return `<progress
      aria-label="Transferred bytes"
      max="${job.totalBytes || 1}"
      ${job.totalBytes ? `value="${job.downloadedBytes}"` : ''}
    ></progress>
    <div class="metrics">
      <span>
        ${percent == null ? '' : percent + '% · '}${bytes(job.downloadedBytes)}${
          job.totalBytes ? ' / ' + bytes(job.totalBytes) : ' transferred'
        }
      </span>
      <span>
        ${bytes(job.speedBytesPerSecond)}/s · ETA
        ${job.etaSeconds == null ? '—' : Math.ceil(job.etaSeconds / 60) + ' min'}
      </span>
    </div>`;
}
function gameForJob(job) {
  return state.catalog.find((game) =>
    game.releases.some((release) => release.id === job.releaseId),
  );
}
function jobBytes(job) {
  let measured;
  if (job.kind === 'BUILD')
    measured =
      job.state === 'DOWNLOADING'
        ? { completedBytes: job.downloadedBytes, totalBytes: job.totalBytes }
        : ['EXTRACTING', 'BUILDING', 'PUBLISHING'].includes(job.state)
          ? job.progress?.operation || job.progress?.extraction || job.progress?.staging
          : null;
  else measured = { completedBytes: job.downloadedBytes, totalBytes: job.totalBytes };
  const completedBytes = Number(measured?.completedBytes),
    totalBytes = Number(measured?.totalBytes);
  return Number.isFinite(completedBytes) &&
    Number.isFinite(totalBytes) &&
    completedBytes >= 0 &&
    totalBytes > 0 &&
    completedBytes <= totalBytes
    ? { completedBytes, totalBytes }
    : null;
}
function jobPercent(job) {
  if (['COMPLETED', 'READY_ON_PS5'].includes(job.state)) return 100;
  const measured = jobBytes(job),
    percent = measured ? Math.floor((measured.completedBytes * 100) / measured.totalBytes) : null;
  return job.kind === 'BUILD' && percent === 100 ? null : percent;
}
function detailTransferProgress(job) {
  const measured = jobBytes(job),
    percent = jobPercent(job),
    stage = job.state === 'TRANSFERRING' ? 'Downloading to PS5' : friendly(job.state),
    meta = [];
  if (measured) meta.push(`${bytes(measured.completedBytes)} / ${bytes(measured.totalBytes)}`);
  if (job.speedBytesPerSecond) meta.push(`${bytes(job.speedBytesPerSecond)}/s`);
  if (job.etaSeconds != null)
    meta.push(`About ${Math.max(1, Math.ceil(job.etaSeconds / 60))} minutes`);
  const percentLabel = percent == null ? '' : `<strong>${percent}%</strong>`;
  const metrics = meta.length
    ? `<div class="detail-transfer-meta">
        ${meta.map((value) => `<span>${esc(value)}</span>`).join('')}
      </div>`
    : '';

  return `<div class="detail-transfer-progress" data-detail-job-id="${esc(job.id)}">
    <button class="primary" disabled>Download in progress</button>
    <div class="detail-transfer-stage"><span>${esc(stage)}</span>${percentLabel}</div>
    <progress
      aria-label="${esc(stage)}"
      max="100"
      ${percent == null ? '' : `value="${percent}"`}
    ></progress>
    ${metrics}
  </div>`;
}
function jobTimeline(job) {
  const pipelines = {
      BUILD: [
        ['Download', ['DOWNLOADING']],
        ['Extract', ['EXTRACTING']],
        ['Inspect', ['INSPECTING']],
        ...(job.buildMethod === 'FPKG' ||
        job.progress?.package?.method === 'FPKG' ||
        job.progress?.backportCreation
          ? [['Backport (Experimental)', ['BACKPORTING']]]
          : []),
        ['Prepare', ['STAGING', 'PREPARING']],
        ['Build', ['BUILDING']],
        ['Check', ['VERIFYING']],
        ['Publish', ['PUBLISHING']],
      ],
      WATCH: [
        ['Settle', ['STABILIZING']],
        ['Inspect', ['INSPECTING']],
        ['Hash', ['HASHING']],
        ['Queue', []],
        ['Build', []],
      ],
      TRANSFER: [
        ['Queue', ['QUEUED_FOR_PS5', 'QUEUED']],
        ['Transfer', ['TRANSFERRING']],
        ['Check', ['VERIFYING']],
        ['Install', ['REGISTERING', 'INSTALLING']],
        ['Ready', ['READY_ON_PS5']],
      ],
      DOWNLOAD: [
        ['Download', ['DOWNLOADING']],
        ['Check', ['VERIFYING']],
        ['Ready', ['COMPLETED']],
      ],
      DELETE: [
        ['Remove', ['QUEUED', 'REMOVING']],
        ['Confirm', ['COMPLETED']],
      ],
    },
    steps = pipelines[job.kind] || [
      ['Queue', ['QUEUED']],
      ['Process', ['RUNNING']],
      ['Ready', ['COMPLETED']],
    ],
    terminal = ['COMPLETED', 'READY_ON_PS5'].includes(job.state),
    currentState =
      job.kind === 'BUILD' && job.progress?.backportCreation?.state === 'CREATING'
        ? 'BACKPORTING'
        : job.state,
    current = steps.findIndex(([, states]) => states.includes(currentState));
  const items = steps
    .map(([name], index) => {
      const className =
        terminal || (current >= 0 && index < current) ? 'done' : index === current ? 'current' : '';
      return `<li class="${className}"><i></i><span>${esc(name)}</span></li>`;
    })
    .join('');

  return `<ol class="job-stages" aria-label="Job stages">${items}</ol>`;
}
function downloadJob(job) {
  const game = gameForJob(job),
    measured = jobBytes(job),
    percent = jobPercent(job),
    terminal = terminalJob(job),
    queued = job.state === 'QUEUED' && ['DOWNLOAD', 'BUILD'].includes(job.kind),
    ready = ['COMPLETED', 'READY_ON_PS5'].includes(job.state),
    stage = ['BUILD', 'WATCH'].includes(job.kind)
      ? job.progress?.stage || friendly(job.state)
      : job.kind === 'TRANSFER' && job.state === 'TRANSFERRING'
        ? 'Downloading to ' + (job.location?.split(' / ')[0] || 'PS5')
        : friendly(job.state),
    meta = [];
  if (measured) meta.push(`${bytes(measured.completedBytes)} / ${bytes(measured.totalBytes)}`);
  if (job.speedBytesPerSecond) meta.push(`${bytes(job.speedBytesPerSecond)}/s`);
  if (job.etaSeconds != null)
    meta.push(`About ${Math.max(1, Math.ceil(job.etaSeconds / 60))} minutes`);
  if (job.location) meta.push(job.location.split(' / ')[0]);
  if (job.queuePosition) meta.push(`Queue position ${job.queuePosition}`);
  let actions = '';
  if (
    (job.kind === 'DOWNLOAD' && !['COMPLETED', 'CANCELLED'].includes(job.state)) ||
    (job.kind === 'BUILD' && job.state === 'ERROR' && state.user?.role === 'ADMIN')
  ) {
    const command = job.state === 'ERROR' ? 'retry' : job.state === 'PAUSED' ? 'resume' : 'pause';
    const label = job.state === 'ERROR' ? 'Retry' : job.state === 'PAUSED' ? 'Resume' : 'Pause';
    actions = `<button data-control="${esc(job.id)}" data-command="${command}">${label}</button>`;
    if (job.state !== 'ERROR')
      actions += `<button data-control="${esc(job.id)}" data-command="cancel">Cancel</button>`;
    else actions += `<button data-dismiss-job="${esc(job.id)}">Dismiss</button>`;
  } else if (job.kind === 'BUILD' && !terminal && state.user?.role === 'ADMIN') {
    actions = `<button data-control="${esc(job.id)}" data-command="cancel">Cancel</button>`;
  } else if (job.kind === 'TRANSFER' && !terminal) {
    actions = `<button data-control="${esc(job.id)}" data-command="cancel">Cancel</button>`;
  } else if (terminal) {
    actions = `<button data-dismiss-job="${esc(job.id)}">Dismiss</button>`;
  }

  const cover = game?.coverUrl
    ? `<img
        class="download-job-cover"
        loading="lazy"
        decoding="async"
        draggable="false"
        src="${esc(game.coverUrl)}"
        alt="Cover for ${esc(game.title)}"
      >`
    : '<span class="download-job-cover placeholder" aria-hidden="true"></span>';
  const metadata = meta.length
    ? `<div class="download-job-meta">
        ${meta.map((value) => `<span>${esc(value)}</span>`).join('')}
      </div>`
    : '';
  const dragAttributes = queued
    ? `draggable="true" data-queue-job="${esc(job.id)}" title="Drag to change queue order"`
    : '';

  return `<article
    class="download-job${queued ? ' queue-draggable' : ''}"
    data-job-id="${esc(job.id)}"
    ${dragAttributes}
  >
    ${cover}
    <div class="download-job-body">
      <div class="download-job-title">
        <div>
          <h2>${esc(job.title || game?.title || 'Selected release')}</h2>
          <span class="download-job-state ${
            ready ? 'ready' : job.state === 'ERROR' ? 'error' : ''
          }">${esc(stage)}</span>
        </div>
        ${percent == null ? '' : `<strong>${percent}%</strong>`}
      </div>
      <progress
        aria-label="${esc(stage)}"
        max="100"
        ${percent == null ? '' : `value="${percent}"`}
      ></progress>
      ${metadata}
      ${jobTimeline(job)}
      ${state.page === 'Preparing' && job.kind === 'BUILD' && !terminal ? trafficGraph(job) : ''}
      ${job.error ? `<p class="error">${esc(friendly(job.error))}</p>` : ''}
    </div>
    <div class="download-job-actions">
      ${queued ? '<span class="queue-grip" aria-hidden="true"></span>' : ''}
      ${actions}
    </div>
  </article>`;
}
function downloadsRateView(
  active = state.jobs.filter(
    (job) => !['COMPLETED', 'READY_ON_PS5', 'ERROR', 'CANCELLED'].includes(job.state),
  ),
) {
  const route = active.find((job) => job.consoleId) || active[0],
    consoleInfo = state.consoles.find((item) => item.id === route?.consoleId),
    speed = active.reduce((total, job) => total + Number(job.speedBytesPerSecond || 0), 0);
  return `<div id="downloads-rate" class="downloads-rate">
    <strong>${speed ? `${bytes(speed)}/s` : 'No active transfer'}</strong>
    <span>${active.length} active${consoleInfo ? ` · ${esc(consoleInfo.name)}` : ''}</span>
  </div>`;
}
function workPage(jobs, title, description, empty) {
  const active = jobs.filter((job) => !terminalJob(job)),
    route = active.find((job) => job.consoleId) || active[0],
    consoleInfo = state.consoles.find((item) => item.id === route?.consoleId),
    storage = consoleInfo?.storage.find((item) => item.storageId === route?.storageId),
    preparing = title === 'Preparation';
  const routeName = preparing
    ? route?.title || 'Waiting for worker'
    : consoleInfo?.name || 'Server download';
  const routeDetail = preparing
    ? route?.progress?.stage || friendly(route?.state || 'queued')
    : storage
      ? `${esc(storage.displayName)} · ${bytes(storage.freeBytes)} available`
      : route?.location
        ? esc(route.location.split(' / ')[0])
        : 'Waiting for the next stage';
  const pipeline =
    route?.kind === 'TRANSFER'
      ? 'Transfer after verification'
      : preparing
        ? 'Verify before publishing'
        : 'Download and verify';
  const nextJobs = active.filter((job) => job !== route).slice(0, 4);
  const nextQueue = nextJobs.length
    ? `<ol>${nextJobs
        .map(
          (job, index) => `<li>
            <span>${String(index + 1).padStart(2, '0')}</span>
            ${esc(job.title || 'Selected release')}
          </li>`,
        )
        .join('')}</ol>`
    : '<p>No other active jobs.</p>';
  const content = jobs.length
    ? `<div class="downloads-layout">
        <div class="download-queue" aria-label="${esc(title)} queue">
          ${jobs.map(downloadJob).join('')}
        </div>
        <aside class="downloads-summary" aria-label="Queue summary">
          <h2>${preparing ? 'Current build' : 'Current route'}</h2>
          <section>
            <small>${preparing ? 'Package' : 'Destination'}</small>
            <strong>${esc(routeName)}</strong>
            <p>${routeDetail}</p>
          </section>
          <section>
            <small>Pipeline</small>
            <strong>${esc(pipeline)}</strong>
            <p>
              ${
                preparing
                  ? 'The verified package is published to your server cache.'
                  : 'Transfers continue independently after the server verifies the source.'
              }
            </p>
          </section>
          <section><small>Next in queue</small>${nextQueue}</section>
        </aside>
      </div>`
    : `<div class="empty">
        <h2>${esc(empty)}</h2>
        <p>
          ${
            preparing
              ? 'The next requested package will appear here.'
              : 'New downloads and PS5 transfers will appear here.'
          }
        </p>
      </div>`;

  return `<section class="downloads-page">
    <div class="downloads-pad">
      <header class="downloads-head">
        <div><h1>${esc(title)}</h1><p>${esc(description)}</p></div>
        ${downloadsRateView(active)}
      </header>
      ${content}
    </div>
  </section>`;
}
function jobsView() {
  return workPage(
    downloadPageJobs(),
    'Activity',
    'Downloads, transfers and installation continue in the background',
    'No activity yet.',
  );
}
function preparationsView() {
  return workPage(
    preparationItems(),
    'Preparation',
    'The worker is preparing verified packages for your server cache',
    'No package is being prepared.',
  );
}
function remotePlayButton(c) {
  return c.capabilities?.remotePlayPairing
    ? `<button type="button" data-remote-play="${esc(c.id)}"${c.presence === 'ONLINE' ? '' : ' title="PS5 agent must be online to pair Remote Play"'}>Pair Remote Play client</button>`
    : '';
}
function remotePlayView(c, p) {
  const content =
    p.state === 'READY'
      ? `<h1>Remote Play PIN</h1>
        <p class="pairing-pin">
          <code>${esc((p.pin || '').replace(/^(\d{4})(\d{4})$/, '$1 $2'))}</code>
        </p>
        <label>Account ID<input readonly value="${esc(p.accountId || '')}"></label>
        <p>
          Open chiaki-ng on this PC, add the PS5, and enter this account ID and PIN.
          Remote Play must already be enabled under PS5 Settings &gt; System &gt; Remote Play.
          Keep this page open until pairing completes.
        </p>`
      : p.state === 'PAIRED'
        ? '<h1>Remote Play client paired</h1>'
        : p.state === 'ERROR'
          ? `<h1>Pairing failed</h1><p class="error">${esc(friendly(p.error || 'REMOTE_PLAY_ERROR'))}</p>`
          : '<h1>Requesting a native Remote Play PIN…</h1><progress aria-label="Requesting Remote Play PIN"></progress>';
  return `<button class="close" data-action="close">Close</button>
    <p class="dialog-context">${esc(c.name)}</p>
    ${content}`;
}
function consoleCapability(label, enabled, detail) {
  return `<li class="console-service ${enabled ? 'available' : 'unavailable'}">
    <span class="console-service-copy">
      <i aria-hidden="true"></i>
      <span>
        <strong>${esc(label)}</strong>
        <small>${esc(detail || (enabled ? 'Reported by console' : 'No capability reported'))}</small>
      </span>
    </span>
    <b>${enabled ? 'Available' : 'Not reported'}</b>
  </li>`;
}
function consoleCard(c) {
  const active = state.jobs.filter((job) => job.consoleId === c.id && !terminalJob(job)),
    updates = active.filter((job) =>
      state.catalog.some((game) =>
        game.releases.some((release) => release.id === job.releaseId && release.kind === 'UPDATE'),
      ),
    ).length;
  const lastSeen = c.lastSeen
      ? c.presence === 'ONLINE'
        ? 'Just now'
        : new Date(c.lastSeen).toLocaleString()
      : 'Never',
    runtime = c.clientKind === 'SIMULATOR' ? 'Development simulator' : c.runtime || 'Not reported',
    status = c.runtimeStatus || {},
    storage = c.storage || [],
    caps = c.capabilities || {},
    runtimeAvailable = Boolean(c.runtime && c.runtime !== 'unknown');
  const serviceCount = [
    runtimeAvailable,
    caps.shadowMount,
    caps.backportOverlay,
    caps.fpkgInstall,
    caps.inventoryScan,
    caps.nativeNotifications,
  ].filter(Boolean).length;
  const storageView = storage.length
    ? `<div class="console-storage-grid">${storage
        .map((item) => {
          const methods = item.installMethodsSupported || [],
            used = Math.max(0, Number(item.totalBytes || 0) - Number(item.freeBytes || 0)),
            context =
              item.storageId === 'internal-installed'
                ? 'System install volume'
                : item.writable
                  ? 'Writable destination'
                  : 'Read only';
          const methodBadges =
            methods.map((method) => `<b>${esc(method)}</b>`).join('') || '<b>Inventory only</b>';
          return `<article class="console-storage ${item.writable ? 'writable' : 'read-only'}">
            <header>
              <div><strong>${esc(item.displayName)}</strong><small>${esc(context)}</small></div>
              <span>${bytes(item.freeBytes)} free</span>
            </header>
            <progress
              aria-label="${esc(item.displayName)} storage used"
              value="${used}"
              max="${item.totalBytes || 1}"
            ></progress>
            <footer>
              <span>${bytes(used)} used of ${bytes(item.totalBytes)}</span>
              <div>${methodBadges}</div>
            </footer>
          </article>`;
        })
        .join('')}</div>`
    : '<p class="console-empty">No storage has been reported yet.</p>';
  const runtimeDetail =
    typeof status === 'object' && status.kstuff ? friendly(status.kstuff) : runtime;
  const shadowMountDetail =
    typeof status === 'object' && status.shadowMount ? friendly(status.shadowMount) : undefined;
  const capabilities = [
    consoleCapability('Runtime', runtimeAvailable, runtimeDetail),
    consoleCapability('ShadowMount', caps.shadowMount, shadowMountDetail),
    consoleCapability('Backport overlay', caps.backportOverlay),
    consoleCapability('FPKG install', caps.fpkgInstall),
    consoleCapability('Inventory scan', caps.inventoryScan),
    consoleCapability('Notifications', caps.nativeNotifications),
  ].join('');
  const forgetButton =
    state.user.role === 'ADMIN'
      ? `<button type="button" data-forget-console="${esc(c.id)}" class="danger">
          Remove console record
        </button>`
      : '';

  return `<article class="console-card ${esc(String(c.presence || 'OFFLINE').toLowerCase())}">
    <header class="console-card-head">
      <span class="console-device-icon" aria-hidden="true">${navIcon('console')}</span>
      <div>
        <div class="console-name">
          <h2>${esc(c.name)}</h2>
          ${c.isDefault ? '<span class="badge">Default</span>' : ''}
        </div>
        <p>
          <span class="console-presence"><i></i>${esc(friendly(c.presence || 'OFFLINE'))}</span>
          <span>Last seen ${esc(lastSeen)}</span>
        </p>
      </div>
      <button data-refresh-console="${esc(c.id)}" aria-label="Refresh ${esc(
        c.name,
      )} information">Refresh</button>
    </header>
    <div class="console-metrics" aria-label="Console activity">
      <div><strong>${Number(c.games || 0)}</strong><small>Games</small></div>
      <div><strong>${active.length}</strong><small>Active jobs</small></div>
      <div><strong>${updates}</strong><small>Update jobs</small></div>
    </div>
    <dl class="console-firmware">
      <div><dt>Firmware</dt><dd>${esc(c.firmware || 'Not reported')}</dd></div>
      <div><dt>Runtime</dt><dd>${esc(runtime)}</dd></div>
      <div>
        <dt>Agent</dt>
        <dd>${c.presence === 'ONLINE' ? 'Connected' : esc(friendly(c.presence || 'OFFLINE'))}</dd>
      </div>
    </dl>
    <section class="console-card-section">
      <div class="console-section-head">
        <div><h3>Storage</h3><p>Destinations reported by this console.</p></div>
        <span>${storage.length}</span>
      </div>
      ${storageView}
    </section>
    <section class="console-card-section console-services" aria-label="Console services">
      <div class="console-section-head">
        <div><h3>Console services</h3><p>Capabilities reported by the current runtime.</p></div>
        <span aria-label="${serviceCount} of 6 services available">
          <strong>${serviceCount}</strong> / 6
        </span>
      </div>
      <ul class="console-capabilities">${capabilities}</ul>
    </section>
    <footer class="console-card-actions">
      <form data-rename="${esc(c.id)}">
        <label>
          Console name
          <input name="name" value="${esc(c.name)}" required maxlength="80">
        </label>
        <button data-rename-submit="${esc(c.id)}">Save name</button>
      </form>
      <div class="console-action-group">
        <span>Console actions</span>
        <div class="console-actions">
          <button
            type="button"
            data-default="${esc(c.id)}"
            class="${c.isDefault ? '' : 'primary'}"
            ${c.isDefault ? 'disabled' : ''}
          >${c.isDefault ? 'Default console' : 'Use by default'}</button>
          <button
            type="button"
            data-test-notification="${esc(c.id)}"
            ${caps.nativeNotifications ? '' : 'disabled'}
          >Test notification</button>
          ${remotePlayButton(c)}
        </div>
      </div>
      <details class="console-danger">
        <summary>Access &amp; removal</summary>
        <div>
          <button type="button" data-revoke="${esc(c.id)}" class="danger">Revoke access</button>
          ${forgetButton}
        </div>
      </details>
    </footer>
  </article>`;
}
function consolesView() {
  const online = state.consoles.filter((c) => c.presence === 'ONLINE').length,
    storage = state.consoles.reduce(
      (total, c) =>
        total + (c.storage || []).reduce((sum, item) => sum + Number(item.freeBytes || 0), 0),
      0,
    ),
    params = new URLSearchParams(location.search),
    reconnect =
      params.get('kind') === 'frontend'
        ? state.consoles.find((value) => value.isDefault)?.id || state.consoles[0]?.id
        : '',
    pairOpen = !state.consoles.length || Boolean(params.get('code'));
  const consoleOptions = state.consoles
    .map(
      (console) => `<option
        value="${esc(console.id)}"
        ${console.id === reconnect ? 'selected' : ''}
      >Reconnect ${esc(console.name)}</option>`,
    )
    .join('');
  const consoleList = state.consoles.length
    ? `<div class="console-grid">${state.consoles.map(consoleCard).join('')}</div>`
    : `<div class="empty">
        <h2>No consoles registered</h2>
        <p>Open PS5Library on your PS5 to generate a pairing code.</p>
      </div>`;

  return `<section class="standard-page console-page">
    <header class="page-heading">
      <div>
        <h1>Consoles</h1>
        <p>Presence, storage and runtime details from every PS5 paired to your account.</p>
      </div>
    </header>
    <div class="console-summary" aria-label="Console summary">
      <div><strong>${state.consoles.length}</strong><span>Registered</span></div>
      <div><strong>${online}</strong><span>Online now</span></div>
      <div><strong>${bytes(storage)}</strong><span>Free storage</span></div>
    </div>
    <details class="console-pair" ${pairOpen ? 'open' : ''}>
      <summary>
        <div><h2>Connect a PS5</h2><p>Use the five-character code shown by PS5Library.</p></div>
        <span class="console-pair-action">Pair console<i aria-hidden="true"></i></span>
      </summary>
      <form id="pair">
        <label>
          Pairing code
          <input
            name="code"
            required
            minlength="5"
            maxlength="5"
            pattern="[2-9A-HJ-NP-Z]{5}"
            autocomplete="off"
            spellcheck="false"
            placeholder="ABCDE"
            value="${esc(params.get('code') || '')}"
          >
        </label>
        <label>
          Console record
          <select name="consoleId">
            <option value="">Register a new PS5</option>
            ${consoleOptions}
          </select>
        </label>
        <button class="primary">Connect PS5Library</button>
      </form>
    </details>
    ${consoleList}
  </section>`;
}
function cacheView() {
  const total = state.artifacts.reduce((n, a) => n + Number(a.size || 0), 0),
    verified = state.artifacts.filter((a) => a.verified).length,
    cards = state.artifacts
      .map((a) => {
        const game = state.catalog.find((g) => g.releases.some((r) => r.id === a.releaseId)),
          art = game?.heroUrl || game?.coverUrl,
          format =
            a.format === 'pkg'
              ? 'FPKG'
              : a.format === 'ffpkg'
                ? 'ShadowMount image'
                : String(a.format || 'artifact').toUpperCase(),
          created = a.createdAt ? new Date(a.createdAt).toLocaleDateString() : 'Date unavailable';
        const artwork = art
          ? `<img loading="lazy" decoding="async" src="${esc(art)}" alt="">`
          : `<span class="cache-art-placeholder" aria-hidden="true">${navIcon('cache')}</span>`;
        const label = game ? `Open ${esc(a.title)}` : `${esc(a.title)} has no catalog entry`;
        return `<article class="cache-artifact">
          <button
            class="cache-art-open"
            ${game ? `data-game="${esc(game.id)}"` : 'disabled'}
            aria-label="${label}"
          >
            <span class="cache-artwork">
              ${artwork}
              <span class="cache-state ${a.verified ? 'verified' : 'pending'}">
                ${a.verified ? 'Verified' : 'Needs verification'}
              </span>
            </span>
            <span class="cache-art-copy">
              <strong>${esc(a.title)}</strong>
              <small>Version ${esc(a.version)} · ${esc(format)}</small>
              <span>
                ${esc(game?.titleId || a.builderVersion || 'Prepared artifact')} · ${esc(created)}
              </span>
            </span>
          </button>
          <footer>
            <strong>${bytes(a.size)}</strong>
            <button class="danger" data-delete="${esc(a.id)}">Delete cached copy</button>
          </footer>
        </article>`;
      })
      .join('');
  const content = cards
    ? `<div class="cache-gallery">${cards}</div>`
    : `<div class="empty">
        <h2>No prepared packages</h2>
        <p>Packages appear here after the worker verifies and publishes them.</p>
        <button data-page="Server library">Browse library</button>
      </div>`;

  return `<section class="standard-page cache-page">
    <header class="page-heading">
      <div><h1>Server cache</h1><p>Verified packages kept on this PC and ready to reuse.</p></div>
    </header>
    <div class="cache-summary" aria-label="Cache summary">
      <div><strong>${bytes(total)}</strong><span>Storage used</span></div>
      <div>
        <strong>${state.artifacts.length}</strong>
        <span>${state.artifacts.length === 1 ? 'Artifact' : 'Artifacts'}</span>
      </div>
      <div><strong>${verified}</strong><span>Verified</span></div>
    </div>
    ${content}
  </section>`;
}
function sourcesView() {
  const adminFields =
    state.user.role === 'ADMIN'
      ? `<label>
          Automatically prepare
          <select name="autoPrepare">
            <option value="">Off</option>
            <option value="BOTH">FPKG and ShadowMount</option>
            <option value="FPKG">FPKG</option>
            <option value="SHADOWMOUNT">ShadowMount</option>
          </select>
        </label>
        <label class="check">
          <input name="shareCatalog" type="checkbox">
          <span>Share new titles with server members</span>
        </label>
        <label>
          Repository credential reference (optional)
          <input name="tokenEnv" placeholder="REPOSITORY_TOKEN_MY_REPO">
        </label>`
      : '';
  const sourceCards =
    state.sources
      .map((source) => {
        const scanState = source.last_synced
          ? 'Scanned ' + esc(new Date(source.last_synced).toLocaleString())
          : 'Awaiting first scan';
        const observations = source.observations?.length
          ? `<ul>${source.observations
              .map((observation) => {
                const error = observation.error ? ` · ${esc(friendly(observation.error))}` : '';
                const space = observation.details?.requiredBytes
                  ? ` · ${bytes(observation.details.requiredBytes)} build space required`
                  : '';
                return `<li>
                  ${esc(observation.details?.title || observation.path)}
                  · ${esc(friendly(observation.state))}${error}${space}
                </li>`;
              })
              .join('')}</ul>`
          : '';
        return `<article class="card">
          <h3>${esc(source.name)}</h3>
          <p>${friendly(source.type)}<br>${scanState}</p>
          ${source.error ? `<p class="error">${esc(friendly(source.error))}</p>` : ''}
          ${observations}
          <button data-sync="${source.id}">Scan now</button>
        </article>`;
      })
      .join('') || '<p>No sources configured for this account.</p>';

  return `<h1>Sources</h1>
    <p>Connect your own dumps, private repositories and authorized public releases.</p>
    <div class="cols">
      <section class="card">
        <h2>Add a collection</h2>
        <form id="source" class="stack">
          <label>
            Name
            <input name="name" required placeholder="My homebrew collection">
          </label>
          <label>
            Source type
            <select name="type">
              <option value="LOCAL_FOLDER">Local folder manifest</option>
              ${
                state.user.role === 'ADMIN'
                  ? '<option value="WATCH_FOLDER">Watch dump folders</option>'
                  : ''
              }
              <option value="STATIC_MANIFEST">Public manifest</option>
              <option value="PRIVATE_HTTP">Private HTTP repository</option>
              <option value="GITHUB_RELEASE">GitHub release manifest</option>
            </select>
          </label>
          <label>
            Folder name, manifest URL, or owner/repository
            <input name="location" required>
          </label>
          <label>
            Scan every
            <select name="scanIntervalMinutes">
              <option value="1">Every minute</option>
              <option value="15">15 minutes</option>
              <option value="60">Hour</option>
              <option value="0">Manually</option>
            </select>
          </label>
          ${adminFields}
          <button class="primary">Add and scan</button>
          <small>
            Watched folders use the administrator-configured dump directory; enter . for its
            root. Local manifest collections use your personal source directory.
          </small>
        </form>
      </section>
      <section>${sourceCards}</section>
    </div>`;
}
function saveSlotRow(save, consoleId, enabled) {
  const active = state.saveBackups.find(
      (backup) =>
        backup.consoleId === consoleId &&
        backup.localUserId === save.localUserId &&
        backup.platform === save.platform &&
        backup.saveTitleId === save.saveTitleId &&
        backup.directory === save.directory &&
        !['READY', 'ERROR', 'CANCELLED'].includes(backup.state),
    ),
    modified = save.modifiedAt
      ? new Date(Number(save.modifiedAt) * 1000).toLocaleString()
      : 'Time unavailable';
  const status = active
    ? `<span class="save-state active"><i></i>${esc(friendly(active.state))}</span>`
    : '';
  return `<article class="save-slot">
    <div class="save-slot-copy">
      <strong>${esc(save.subtitle || save.directory || 'Save slot')}</strong>
      ${save.detail ? `<p>${esc(save.detail)}</p>` : ''}
      <small>${bytes(save.sizeBytes)} · Updated ${esc(modified)} · ${esc(save.directory)}</small>
    </div>
    <div class="save-slot-action">
      ${status}
      <button
        data-backup-save="${esc(consoleId)}"
        data-local-user-id="${esc(save.localUserId)}"
        data-platform="${esc(save.platform)}"
        data-game-title="${esc(save.gameTitleId)}"
        data-save-title="${esc(save.saveTitleId)}"
        data-directory="${esc(save.directory)}"
        ${enabled && !active ? '' : 'disabled'}
      >${active ? 'Backup in progress' : 'Back up to server'}</button>
    </div>
  </article>`;
}
function saveHistoryRow(backup, slots) {
  const slot = slots.find(
      (save) =>
        save.localUserId === backup.localUserId &&
        save.platform === backup.platform &&
        save.saveTitleId === backup.saveTitleId &&
        save.directory === backup.directory,
    ),
    name = slot?.title || slot?.subtitle || backup.saveTitleId,
    terminal = ['READY', 'ERROR', 'CANCELLED'].includes(backup.state),
    tone =
      backup.state === 'READY'
        ? 'ready'
        : backup.state === 'ERROR'
          ? 'error'
          : backup.state === 'CANCELLED'
            ? 'cancelled'
            : 'active',
    created = backup.createdAt ? new Date(backup.createdAt).toLocaleString() : 'Date unavailable',
    amount = backup.totalBytes
      ? `${bytes(backup.uploadedBytes)} / ${bytes(backup.totalBytes)}`
      : 'Waiting for console';
  const indicator = terminal
    ? ''
    : backup.totalBytes
      ? `<progress
          aria-label="Uploading ${esc(name)} save"
          value="${backup.uploadedBytes}"
          max="${backup.totalBytes}"
        ></progress>`
      : `<progress aria-label="Waiting for ${esc(name)} save"></progress>`;
  const download = backup.downloadUrl
    ? `<a class="button" href="${esc(backup.downloadUrl)}" download>Download backup</a>`
    : '<span></span>';

  return `<article class="save-history-item">
    <div class="save-history-head">
      <span class="save-state ${tone}"><i></i>${esc(friendly(backup.state))}</span>
      <time>${esc(created)}</time>
    </div>
    <strong>${esc(name)}</strong>
    <small>${esc(backup.platform)} · ${esc(backup.saveTitleId)} · ${esc(backup.directory)}</small>
    <div class="save-history-progress"><span>${esc(amount)}</span>${indicator}</div>
    ${backup.error ? `<p class="save-error" role="alert">${esc(friendly(backup.error))}</p>` : ''}
    <footer>
      ${download}
      <button class="danger" data-delete-save-backup="${esc(backup.id)}">Delete</button>
    </footer>
  </article>`;
}
function saveBackupsView(selected) {
  const consoleState = state.consoles.find((console) => console.id === selected?.id),
    online = consoleState?.presence === 'ONLINE',
    supported = consoleState?.capabilities?.saveBackup === true,
    enabled = online && supported,
    slots = selected?.saveData || [],
    backups = state.saveBackups.filter((backup) => backup.consoleId === selected?.id),
    ready = backups.filter((backup) => backup.state === 'READY'),
    stored = ready.reduce((total, backup) => total + Number(backup.totalBytes || 0), 0),
    groups = [
      ...slots
        .reduce((map, save) => {
          const key = `${save.platform}:${save.gameTitleId}`,
            group = map.get(key) || [];
          group.push(save);
          map.set(key, group);
          return map;
        }, new Map())
        .values(),
    ];
  const games = groups
    .map((saves) => {
      const first = saves[0],
        game = state.catalog.find(
          (item) => item.titleId === first.gameTitleId || item.titleId === first.saveTitleId,
        ),
        title = game?.title || first.title || first.gameTitleId,
        art = game?.coverUrl || game?.heroUrl;
      const artwork = art
        ? `<img loading="lazy" decoding="async" src="${esc(art)}" alt="">`
        : `<span class="save-game-placeholder" aria-hidden="true">${navIcon('save')}</span>`;
      return `<section class="save-game">
        <header>
          ${artwork}
          <div>
            <h3>${esc(title)}</h3>
            <p>
              ${esc(first.platform)} · ${esc(first.gameTitleId)} · ${saves.length}
              ${saves.length === 1 ? 'save' : 'saves'}
            </p>
          </div>
        </header>
        <div class="save-slot-list">
          ${saves.map((save) => saveSlotRow(save, selected.id, enabled)).join('')}
        </div>
      </section>`;
    })
    .join('');
  const capability = enabled
    ? 'Ready to back up'
    : !online
      ? 'Console offline · backup actions paused'
      : 'Save backup support not reported';
  const emptySaves = `<div class="save-empty">
    <span aria-hidden="true">${navIcon('save')}</span>
    <h3>No saves reported</h3>
    <p>
      ${
        online
          ? 'Open or refresh PS5Library on this console so the agent can report its save slots.'
          : 'Bring this console online to refresh its saved data.'
      }
    </p>
  </div>`;
  const guidance =
    !enabled && slots.length
      ? `<p class="save-guidance">
          ${
            online
              ? 'Update the PS5Library agent to enable encrypted backups.'
              : 'Bring this console online before starting a backup.'
          }
        </p>`
      : '';
  const history = backups.length
    ? backups.map((backup) => saveHistoryRow(backup, slots)).join('')
    : `<div class="save-empty compact">
        <h3>No backups yet</h3>
        <p>Choose “Back up to server” beside a console save.</p>
      </div>`;

  return `<div id="save-backups-view" class="save-workspace">
    <div class="save-overview">
      <div class="save-console-identity">
        <span class="save-console-icon" aria-hidden="true">${navIcon('console')}</span>
        <span>
          <strong>${esc(selected.name || consoleState?.name || 'Selected PS5')}</strong>
          <small class="${enabled ? 'available' : 'unavailable'}">
            <i></i>${esc(capability)}
          </small>
        </span>
      </div>
      <dl>
        <div><dt>Console saves</dt><dd>${slots.length}</dd></div>
        <div><dt>Server backups</dt><dd>${ready.length}</dd></div>
        <div><dt>Stored</dt><dd>${bytes(stored)}</dd></div>
      </dl>
    </div>
    <div class="save-content">
      <section class="save-source">
        <header class="save-section-head">
          <div>
            <h2>Console saves</h2>
            <p>Choose a reported save to copy its encrypted data to this server.</p>
          </div>
          <span>${slots.length}</span>
        </header>
        ${games || emptySaves}
        ${guidance}
      </section>
      <aside class="save-history">
        <header class="save-section-head">
          <div><h2>Backup history</h2><p>Encrypted copies stored for this account.</p></div>
          <span>${backups.length}</span>
        </header>
        <div class="save-history-list" aria-live="polite">${history}</div>
      </aside>
    </div>
  </div>`;
}
function profileView() {
  const profile = state.profile,
    profiles = profile?.consoles || [],
    selected = profiles.find((item) => item.id === state.selectedConsole) || profiles[0],
    consoleInfo = state.consoles.find((item) => item.id === selected?.id),
    online = consoleInfo?.presence === 'ONLINE',
    tab = state.profileTab || 'available',
    games = (selected?.games || []).filter((game) => tab !== 'available' || game.available),
    hero = state.catalog.find((game) => game.id === games[0]?.gameId)?.heroUrl,
    trophies = selected?.trophySummary?.earnedTrophies,
    storage = consoleInfo?.storage || [],
    avatar = profile?.avatarUrl
      ? `<img class="profile-avatar" src="${esc(profile.avatarUrl)}" alt="Your account picture">`
      : `<span class="profile-avatar initials">${esc((profile?.username || state.user.username).slice(0, 1).toUpperCase())}</span>`,
    gameShelf = games.length
      ? `<div class="profile-game-strip">${games
          .map(
            (game) => `<button class="profile-game" data-game="${esc(game.gameId)}">
              <img
                loading="lazy"
                decoding="async"
                src="${esc(game.coverUrl)}"
                alt="Cover for ${esc(game.title)}"
              >
              <strong>${esc(game.title)}</strong>
              <small>${esc(game.platform)}${game.available ? ' · Available' : ' · Missing'}</small>
            </button>`,
          )
          .join('')}</div>`
      : '<div class="empty"><p>No games have been reported in this view.</p></div>';
  const storageView = storage.length
    ? `<div class="storage-list">${storage
        .map((item) => {
          const used = Math.max(0, item.totalBytes - item.freeBytes);
          return `<article class="storage">
            <div><h3>${esc(item.displayName)}</h3><small>${bytes(item.freeBytes)} free</small></div>
            <progress
              aria-label="${esc(item.displayName)} used"
              value="${used}"
              max="${item.totalBytes || 1}"
            ></progress>
            <p>${bytes(used)} used of ${bytes(item.totalBytes)}</p>
          </article>`;
        })
        .join('')}</div>`
    : '<p>No storage has been reported by this console.</p>';
  const trophySummary = ['platinum', 'gold', 'silver', 'bronze']
    .map(
      (grade) => `<div>
        <strong>${trophies ? esc(trophies[grade]) : '—'}</strong>
        <small>${friendly(grade)}</small>
      </div>`,
    )
    .join('');
  const profileTab = (name, label) => `<button
    data-profile-tab="${name}"
    aria-current="${tab === name ? 'page' : 'false'}"
  >${label}<i aria-hidden="true"></i></button>`;
  const sectionTitle =
    tab === 'saves' ? 'Save backups' : tab === 'trophies' ? 'Trophies by game' : 'Console library';

  return `<section class="profile-page">
    ${hero ? `<img class="profile-art" src="${esc(hero)}" alt="">` : ''}
    <div class="profile-fade"></div>
    <div class="profile-pad">
      <header class="profile-head">
        <div class="profile-identity">
          ${avatar}
          <div>
            <h1>${esc(profile?.username || state.user.username)}</h1>
            <p class="profile-presence ${online ? 'online' : 'offline'}">
              <i></i>${esc(selected?.name || 'No PS5 selected')} ·
              ${esc(friendly(consoleInfo?.presence || 'OFFLINE'))}
            </p>
          </div>
        </div>
        <div class="profile-actions">
          ${profiles.length > 1 ? consoleSelect('profile') : ''}
          <label class="button profile-edit">
            Edit profile
            <input
              id="profile-picture"
              class="visually-hidden"
              type="file"
              accept="image/png,image/jpeg,image/webp"
            >
          </label>
          <button class="primary" data-page="My PS5s">Manage console</button>
        </div>
      </header>
      <div class="console-overview">
        <section class="console-main">
          <h2>${esc(selected?.name || 'Your PS5')}</h2>
          <div class="console-facts">
            <div>
              <small>Status</small>
              <strong>${esc(
                consoleInfo?.presence === 'ONLINE'
                  ? 'Connected'
                  : friendly(consoleInfo?.presence || 'Offline'),
              )}</strong>
            </div>
            <div><small>Firmware</small><strong>${esc(
              consoleInfo?.firmware || 'Not reported',
            )}</strong></div>
            <div>
              <small>Library</small>
              <strong>${Number(
                consoleInfo?.games || games.filter((game) => game.available).length,
              )} games</strong>
            </div>
            <div>
              <small>ShadowMountPlus</small>
              <strong>${consoleInfo?.capabilities?.shadowMount ? 'Available' : 'Not reported'}</strong>
            </div>
          </div>
          <h2>Storage</h2>
          ${storageView}
        </section>
        <aside class="profile-side">
          <h2>Trophies</h2>
          <div class="trophies">${trophySummary}</div>
          <nav class="profile-links" aria-label="Profile options">
            ${profileTab('available', 'Available games')}
            ${profileTab('trophies', 'Trophies by game')}
            ${profileTab('saves', 'Save backups')}
            ${profileTab('all', 'Console library')}
          </nav>
          ${
            profile?.avatarUrl
              ? '<button class="link" data-action="reset-avatar">Use default picture</button>'
              : ''
          }
        </aside>
      </div>
    </div>
    <section class="profile-games">
      <div class="profile-games-head">
        <div>
          <h2>${sectionTitle}</h2>
          ${
            tab === 'trophies'
              ? '<p>Per-game trophy progress appears after the console reports verified data.</p>'
              : ''
          }
        </div>
        <span>${games.length} ${games.length === 1 ? 'game' : 'games'}</span>
      </div>
      ${tab === 'saves' ? saveBackupsView(selected) : gameShelf}
    </section>
  </section>`;
}
function savesPageView() {
  if (!state.profile)
    return `<section class="standard-page saves-page" aria-busy="true">
      <header class="page-heading">
        <div><h1>Saved data</h1><p>Loading saves and backup history…</p></div>
      </header>
      <div class="save-loading"><i></i><i></i><i></i></div>
    </section>`;
  const profiles = state.profile.consoles || [],
    selected = profiles.find((item) => item.id === state.selectedConsole) || profiles[0];
  const content = selected
    ? saveBackupsView(selected)
    : `<div class="empty save-page-empty">
        <h2>No PS5 connected</h2>
        <p>Pair a console before managing saved data.</p>
        <button class="primary" data-page="My PS5s">Pair a PS5</button>
      </div>`;
  return `<section class="standard-page saves-page">
    <header class="page-heading">
      <div><h1>Saved data</h1><p>Encrypted backups from saves reported by your console.</p></div>
      ${profiles.length ? `<div class="saves-console-picker">${consoleSelect('saves')}</div>` : ''}
    </header>
    ${content}
  </section>`;
}
function usersView() {
  if (state.user.role !== 'ADMIN') return accountView();
  const accounts = state.manager?.accounts || [];
  const rows = accounts
    .map((account) => {
      const online = account.devices.filter(
        (device) => device.presence === 'ONLINE' && !device.revokedAt,
      ).length;
      return `<tr>
        <td><strong>${esc(account.username)}</strong></td>
        <td>${esc(friendly(account.role))}</td>
        <td>${account.sessions.length}</td>
        <td>${account.devices.length}</td>
        <td><span class="health-dot ${online ? 'healthy' : 'unhealthy'}">${online} online</span></td>
      </tr>`;
    })
    .join('');
  const table = rows
    ? `<div class="responsive-table">
        <table>
          <thead><tr><th>User</th><th>Role</th><th>Sessions</th><th>Devices</th><th>Online</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`
    : '<div class="empty"><p>No accounts have been created.</p></div>';

  return `<section class="standard-page">
    <header class="page-heading">
      <div><h1>Users &amp; sharing</h1><p>Accounts remain isolated unless a game is explicitly shared.</p></div>
      <button class="primary" data-action="invite">Invite user</button>
    </header>
    <div id="invite-result" class="stack"></div>
    <section class="table-section">
      <header>
        <div><h2>Accounts</h2><p>Only administrators can prepare packages or manage this server.</p></div>
        <span>${accounts.length} ${accounts.length === 1 ? 'account' : 'accounts'}</span>
      </header>
      ${table}
    </section>
  </section>`;
}
function accountView() {
  const initial = esc(state.user.username.slice(0, 1).toUpperCase()),
    admin = state.user.role === 'ADMIN';
  const adminSection = admin
    ? `<section class="settings-section">
        <header>
          <h2>Server administration</h2>
          <p>Open the workspace for the task you need. Runtime configuration is managed on the server page.</p>
        </header>
        <div class="settings-actions">
          <button data-page="Server manager" data-manager-tab-target="configuration">
            <span>
              <strong>Server configuration</strong>
              <small>Hot-reload safe options and review restart-only settings</small>
            </span>
          </button>
          <button data-page="Server manager" data-manager-tab-target="overview">
            <span><strong>System &amp; logs</strong><small>Health, jobs, access and diagnostics</small></span>
          </button>
          <button data-page="Sources">
            <span><strong>Content sources</strong><small>Scan and manage authorized folders</small></span>
          </button>
          <button data-page="Users &amp; sharing">
            <span><strong>Users &amp; sharing</strong><small>Invite people and review access</small></span>
          </button>
        </div>
      </section>`
    : '';

  return `<section class="standard-page settings-view">
    <header class="page-heading">
      <div><h1>Settings</h1><p>Personalize this browser and manage your Library Server access.</p></div>
    </header>
    <div class="settings-grid">
      <aside class="settings-identity">
        <span class="settings-avatar" aria-hidden="true">${initial}</span>
        <div><h2>${esc(state.user.username)}</h2><p>${esc(friendly(state.user.role))} account</p></div>
        <button data-page="Profile">Open profile</button>
        <button data-page="My PS5s">Manage consoles</button>
      </aside>
      <div class="settings-sections">
        <section class="settings-section">
          <header><h2>Appearance</h2><p>Choose how the manager looks on this browser.</p></header>
          <div class="appearance-options" role="group" aria-label="Appearance">
            <button data-appearance="default" aria-pressed="${state.appearance === 'default'}">
              <span class="appearance-swatch default" aria-hidden="true"></span>
              <span><strong>Library color</strong><small>Blue status and artwork color</small></span>
            </button>
            <button data-appearance="mono" aria-pressed="${state.appearance === 'mono'}">
              <span class="appearance-swatch mono" aria-hidden="true"></span>
              <span><strong>Black &amp; white</strong><small>Monochrome manager and artwork</small></span>
            </button>
          </div>
        </section>
        <section class="settings-section">
          <header>
            <h2>Library access</h2>
            <p>These protections are always active for this account.</p>
          </header>
          <div class="setting-line">
            <span>
              <strong>Private activity</strong>
              <small>Your consoles, jobs, saved data and sources stay within your account.</small>
            </span>
            <b>Protected</b>
          </div>
          <div class="setting-line">
            <span>
              <strong>Shared games</strong>
              <small>Other owners' titles appear only after they explicitly share them with you.</small>
            </span>
            <b>Explicit access</b>
          </div>
        </section>
        ${adminSection}
        <section class="settings-section session-section">
          <header>
            <h2>Browser session</h2>
            <p>Signing out removes this browser's active Library Server session.</p>
          </header>
          <div class="setting-line danger-setting">
            <span>
              <strong>Sign out of PS5Library</strong>
              <small>Your server data and paired consoles stay intact.</small>
            </span>
            <button class="danger" data-action="logout">Sign out</button>
          </div>
        </section>
      </div>
    </div>
  </section>`;
}
const duration = (n) =>
  n < 60
    ? `${n}s`
    : n < 3600
      ? `${Math.floor(n / 60)}m`
      : `${Math.floor(n / 3600)}h ${Math.floor((n % 3600) / 60)}m`;
function managerJob(job) {
  return `<article data-manager-job-id="${esc(job.id)}">
    <div>
      <strong>${esc(job.title || 'Background task')}</strong>
      <small>
        ${esc(job.username)} · ${esc(friendly(job.kind))} ·
        ${esc(new Date(job.updatedAt).toLocaleString())}
      </small>
      ${progress(job)}
    </div>
    <div>
      <span class="pill ${job.state === 'ERROR' ? 'offline' : ''}">
        ${esc(friendly(job.state))}
      </span>
      ${job.error ? `<small class="error">${esc(friendly(job.error))}</small>` : ''}
    </div>
  </article>`;
}
const runtimeSettingCopy = {
  companionApp: 'Allow PS5Library companion clients to sign in.',
  ps5Connections: 'Accept PS5 console pairing and device traffic.',
  accountRegistration: 'Allow invitations and new account registration.',
  community: 'Allow optional Community Master features.',
  newDownloads: 'Accept new download and preparation requests. Active work continues.',
  homeUpdateBridge: 'Allow native Home update requests when the update agent is configured.',
  autoCreateBackport:
    'Experimental: create 4.50 compatibility files before FPKG builds only when the game has no backport folder. Existing folders are skipped. Console testing is still required. Applies to builds starting next.',
  quotaBytes: 'Maximum managed storage used by this server. Set 0 for unlimited.',
  diskMarginBytes: 'Free disk space reserved before new work starts.',
};
function runtimeSettingsChanges(form, runtime) {
  const patch = {};
  for (const definition of runtime.definitions.filter((item) => item.writable)) {
    const input = form.elements.namedItem(definition.key);
    if (!input) continue;
    const value =
      definition.type === 'boolean'
        ? Boolean(input.checked)
        : Math.round(Number(input.value) * GIB);
    if (definition.type === 'bytes' && (!Number.isSafeInteger(value) || value < 0))
      throw Error(`${definition.label} must be a non-negative storage size`);
    if (runtime.settings[definition.key] !== value) patch[definition.key] = value;
  }
  return patch;
}
function syncRuntimeApply(form) {
  const button = form?.querySelector?.('button[type="submit"]');
  if (!button) return;
  try {
    button.disabled = !Object.keys(runtimeSettingsChanges(form, state.manager.runtimeSettings))
      .length;
  } catch {
    button.disabled = true;
  }
}
function managerOverview(m, healthy) {
  const s = m.status || {},
    services = s.services || {},
    host = s.host,
    managed = s.managedServices || [],
    labels = {
      server: 'API server',
      worker: 'Package worker',
      postgres: 'PostgreSQL',
      redis: 'Redis queue',
      proxy: 'HTTPS proxy',
    },
    metrics = [
      ['Accounts', s.users],
      ['Consoles', s.consoles],
      ['Online now', s.onlineConsoles],
      ['Sources', s.sources],
      ['Active jobs', s.activeJobs],
      ['Failed jobs', s.failedJobs],
      ['Pairing requests', s.pendingPairings],
      ['Cache size', bytes(Number(s.artifactBytes || 0))],
    ],
    service = (name, value, details = '') => {
      const response =
        details ||
        ((value?.latencyMs ?? null) !== null
          ? value.latencyMs + ' ms response'
          : 'No response reported');
      return `<article class="system-service-row">
        <span><strong>${esc(name)}</strong><small>${esc(response)}</small></span>
        <span class="health-dot ${value?.status === 'CONNECTED' ? 'healthy' : 'unhealthy'}">
          ${esc(value?.status || 'UNKNOWN')}
        </span>
      </article>`;
    },
    usage = (name, value, total) => `<div class="host-meter">
      <div class="row spread">
        <span>${esc(name)}</span>
        <strong>${total ? Math.round((value * 100) / total) : 0}%</strong>
      </div>
      <progress
        aria-label="${esc(name)} used"
        value="${esc(value || 0)}"
        max="${esc(total || 1)}"
      ></progress>
      <small>${bytes(Number(value || 0))} used of ${bytes(Number(total || 0))}</small>
    </div>`;
  const serviceRows = managed.length
    ? managed
        .map((item) => {
          const details =
            item.status === 'RUNNING'
              ? `${Number(item.cpuPercent || 0).toFixed(1)}% CPU · ${bytes(
                  Number(item.memoryBytes || 0),
                )} memory`
              : 'Container is not running';
          return `<article class="system-service-row managed">
            <span>
              <strong>${esc(labels[item.id] || friendly(item.id))}</strong>
              <small>${details}</small>
            </span>
            <span class="health-dot ${item.status === 'RUNNING' ? 'healthy' : 'unhealthy'}">
              ${esc(item.status)}
            </span>
            <button
              data-restart-service="${esc(item.id)}"
              ${item.status === 'MISSING' ? 'disabled' : ''}
            >Restart</button>
          </article>`;
        })
        .join('')
    : service(
        'API server',
        services.api,
        services.api ? `Up ${duration(services.api.uptimeSeconds || 0)}` : '',
      ) +
      service('PostgreSQL', services.database) +
      service(
        'Redis queue',
        services.redis,
        services.redis?.status === 'CONNECTED'
          ? `${services.redis.version || 'Redis'} · ${services.redis.usedMemory || 'memory unknown'} · ${services.redis.connectedClients || 0} clients`
          : 'Queue unavailable',
      ) +
      service('Package worker', services.worker);
  const metricsView = metrics
    .map(([name, value]) => `<div><dt>${esc(name)}</dt><dd>${esc(value ?? 0)}</dd></div>`)
    .join('');
  const hostSummary = host
    ? `${esc(host.cpuCount)} CPU cores · Up ${duration(host.uptimeSeconds || 0)}`
    : 'Host controller unavailable';
  const hostView = host
    ? `<p class="host-load">
        Load ${
          (host.loadAverage || []).map((value) => Number(value).toFixed(2)).join(' / ') ||
          'not reported'
        }
      </p>
      ${usage('Memory', host.memory.used, host.memory.total)}
      ${usage('Server disk', host.disk.used, host.disk.total)}`
    : `<div class="system-empty">
        <strong>Performance data unavailable</strong>
        <p>Application diagnostics remain available. Service restarts require the host controller.</p>
      </div>`;

  return `<section class="system-status-strip">
    <div>
      <span class="health-dot ${healthy ? 'healthy' : 'unhealthy'}">
        ${healthy ? 'Core services operational' : 'Attention required'}
      </span>
      <h2>${healthy ? 'The server is ready.' : 'One or more services need attention.'}</h2>
      <p>
        Snapshot ${m.updatedAt ? esc(new Date(m.updatedAt).toLocaleString()) : 'is still loading'}.
      </p>
    </div>
    <dl>${metricsView}</dl>
  </section>
  <div class="system-overview-grid">
    <section class="system-section">
      <header>
        <div><h2>Services</h2><p>Live process state and guarded restart controls.</p></div>
        <span>${managed.length || 4} monitored</span>
      </header>
      <div class="system-service-list">${serviceRows}</div>
    </section>
    <section class="system-section host-section">
      <header><div><h2>Host performance</h2><p>${hostSummary}</p></div></header>
      ${hostView}
    </section>
  </div>`;
}
function managerJobsView(m) {
  const s = m.status || {},
    queue = s.queue || {},
    jobs = m.jobs || [];
  const summary = ['active', 'waiting', 'delayed', 'failed', 'completed', 'paused']
    .map((key) => `<div><dt>${esc(friendly(key))}</dt><dd>${esc(queue[key] || 0)}</dd></div>`)
    .join('');
  const recent = jobs.length
    ? `<div class="manager-table">${jobs.map(managerJob).join('')}</div>`
    : `<div class="system-empty">
        <strong>No jobs recorded</strong>
        <p>Package preparation and transfers will appear here.</p>
      </div>`;

  return `<section class="system-section queue-section">
    <header>
      <div><h2>Job queue</h2><p>${esc(queue.name || 'Queue diagnostics unavailable')}</p></div>
      <span class="health-dot ${queue.consumerRunning ? 'healthy' : 'unhealthy'}">
        ${queue.consumerRunning ? 'Consumer running' : 'Consumer offline'}
      </span>
    </header>
    <dl class="queue-summary">${summary}</dl>
  </section>
  <section class="system-section recent-jobs">
    <header>
      <div><h2>Recent jobs</h2><p>Latest work across every server account.</p></div>
      <span>${jobs.length} shown</span>
    </header>
    ${recent}
  </section>`;
}
function managerAccessView(m) {
  const accounts = m.accounts || [],
    c = m.community || { configured: false, state: 'DISCONNECTED' },
    features = m.status?.features || {};
  const accountList =
    accounts
      .map((account) => {
        const online = account.devices.filter(
          (device) => device.presence === 'ONLINE' && !device.revokedAt,
        ).length;
        const sessions =
          account.sessions
            .map(
              (session) => `<div class="connection-row">
                <span>
                  <strong>${esc(session.ip || 'Address unavailable')}</strong>
                  <small>${esc(session.userAgent || 'Unknown browser')}</small>
                </span>
                <span>
                  <small>Last active</small>
                  <strong>${esc(new Date(session.lastSeenAt).toLocaleString())}</strong>
                </span>
              </div>`,
            )
            .join('') || '<p>No active browser sessions.</p>';
        const devices =
          account.devices
            .map((device) => {
              const connected = device.presence === 'ONLINE' && !device.revokedAt;
              const lastSeen = device.lastSeenAt
                ? esc(new Date(device.lastSeenAt).toLocaleString())
                : 'Never connected';
              return `<div class="connection-row">
                <span>
                  <strong>${esc(device.name)}</strong>
                  <small>
                    ${esc(friendly(device.credentialKind))} · ${esc(device.clientKind)} ·
                    Firmware ${esc(device.firmware || 'unknown')}
                  </small>
                </span>
                <span>
                  <span class="health-dot ${connected ? 'healthy' : 'unhealthy'}">
                    ${device.revokedAt ? 'REVOKED' : esc(device.presence)}
                  </span>
                  <small>${esc(device.ip || 'No recent address')} · ${lastSeen}</small>
                </span>
              </div>`;
            })
            .join('') || '<p>No registered devices.</p>';
        return `<details>
          <summary>
            <span>
              <strong>${esc(account.username)}</strong>
              <small>
                ${esc(account.role)} · ${account.sessions.length} active
                ${account.sessions.length === 1 ? 'session' : 'sessions'} ·
                ${account.devices.length} ${account.devices.length === 1 ? 'device' : 'devices'}
              </small>
            </span>
            <span class="pill">${online} online</span>
          </summary>
          <div class="account-detail">
            <h3>Browser sessions</h3>
            ${sessions}
            <h3>Registered devices</h3>
            ${devices}
          </div>
        </details>`;
      })
      .join('') ||
    `<div class="system-empty">
      <strong>No accounts created</strong>
      <p>Invite a user from Users &amp; sharing.</p>
    </div>`;

  let communityView;
  if (features.community === false) {
    communityView = `<div class="system-empty">
      <strong>Community is disabled</strong>
      <p>Enable it under Configuration before connecting.</p>
    </div>`;
  } else if (!c.configured) {
    communityView = `<div class="system-empty">
      <strong>Community server not configured</strong>
      <p>Set COMMUNITY_MASTER_URL in the server environment and restart.</p>
    </div>`;
  } else if (c.state === 'DISCONNECTED') {
    communityView = `<form id="community-request" class="community-request">
      <label>
        Server display name
        <input name="displayName" required maxlength="80" value="Family Library">
      </label>
      <button class="primary">Request access</button>
    </form>`;
  } else {
    const authorization =
      c.state === 'AWAITING_OWNER'
        ? `<p class="dialog-context">Owner authorization code</p>
          <p class="pairing-pin"><code>${esc(c.userCode)}</code></p>
          <a
            class="button"
            target="_blank"
            rel="noopener"
            href="${esc(c.verificationUriComplete)}"
          >Sign in and authorize</a>`
        : '';
    communityView = `<div class="community-state">
      <p>
        ${c.serverId ? `Server ID: <code>${esc(c.serverId)}</code><br>` : ''}
        ${c.banReason ? `Reason: ${esc(c.banReason)}<br>` : ''}
        ${c.error ? `Last error: ${esc(friendly(c.error))}` : ''}
      </p>
      ${authorization}
      <div class="row tab-actions">
        <button data-action="refresh-community">Refresh status</button>
        <button class="danger" data-action="disconnect-community">Disconnect</button>
      </div>
    </div>`;
  }

  return `<section class="system-section access-section">
    <header>
      <div>
        <h2>Accounts &amp; connected devices</h2>
        <p>Active sessions and registered clients, isolated by account.</p>
      </div>
      <span>${accounts.length} accounts</span>
    </header>
    <div class="account-list">${accountList}</div>
  </section>
  <section class="system-section community-panel">
    <header>
      <div>
        <h2>Community Master</h2>
        <p>Optional save and social features. Game content never uses this connection.</p>
      </div>
      <span class="health-dot ${c.state === 'APPROVED' ? 'healthy' : 'unhealthy'}">
        ${esc(friendly(c.state))}
      </span>
    </header>
    ${communityView}
  </section>`;
}
function managerLogsView(m) {
  const logs = m.logs || [];
  const entries =
    logs
      .map((log) => {
        const context = Object.fromEntries(
          Object.entries(log).filter(
            ([key]) => !['timestamp', 'service', 'level', 'event', 'message'].includes(key),
          ),
        );
        return `<article
          class="log-${esc(log.level.toLowerCase())}"
          data-log-level="${esc(log.level)}"
        >
          <time>${esc(new Date(log.timestamp).toLocaleString())}</time>
          <strong>${esc(log.service)} · ${esc(log.level)} · ${esc(log.event)}</strong>
          ${log.message ? `<span>${esc(log.message)}</span>` : ''}
          ${Object.keys(context).length ? `<code>${esc(JSON.stringify(context))}</code>` : ''}
        </article>`;
      })
      .join('') || '<p class="system-empty">No matching log entries.</p>';
  const levels = ['INFO', 'WARN', 'ERROR']
    .map((level) => `<option ${state.logLevel === level ? 'selected' : ''}>${level}</option>`)
    .join('');

  return `<section class="system-section manager-log-panel">
    <header>
      <div><h2>Application logs</h2><p>Credentials are redacted before entries reach this view.</p></div>
      <span aria-live="polite">${logs.length} entries</span>
    </header>
    <div class="log-toolbar">
      <label>
        Service
        <select id="manager-service">
          <option value="">All services</option>
          <option value="server" ${state.logService === 'server' ? 'selected' : ''}>Server</option>
          <option value="worker" ${state.logService === 'worker' ? 'selected' : ''}>Worker</option>
        </select>
      </label>
      <label>
        Level
        <select id="manager-level"><option value="">All levels</option>${levels}</select>
      </label>
      <button class="danger" data-action="clear-logs">Clear all application logs</button>
    </div>
    <div class="log-view">${entries}</div>
    <p class="docker-hint">
      Clearing removes current and rotated server and worker logs from this dashboard. Database
      audit records and service data remain intact. <code>npm run docker:logs</code> follows live
      server, worker and Redis output.
    </p>
  </section>`;
}
function managerConfigurationView(m) {
  const runtime = m.runtimeSettings;
  if (!runtime)
    return `<section class="system-section">
      <div class="system-empty">
        <strong>Loading configuration</strong>
        <p>Runtime settings are being read from the server.</p>
      </div>
    </section>`;
  const writable = runtime.definitions.filter((item) => item.writable),
    booleans = writable.filter((item) => item.type === 'boolean'),
    numbers = writable.filter((item) => item.type === 'bytes'),
    locked = runtime.definitions.filter((item) => !item.writable),
    updated = runtime.updatedAt ? new Date(runtime.updatedAt).toLocaleString() : 'Not recorded';
  const toggles = booleans
    .map((item) => {
      const unavailable = item.available === false,
        notes = [];
      if (unavailable)
        notes.push(`Requires ${(item.requires || []).join(', ')} in the environment.`);
      if (item.enforcement === 'client-declared')
        notes.push('Applies to identified companion clients only.');
      if (Object.hasOwn(item, 'effective'))
        notes.push(item.effective ? 'Effective now.' : 'Currently not effective.');
      const note = notes.length ? ' ' + esc(notes.join(' ')) : '';
      return `<label class="runtime-toggle" for="runtime-${esc(item.key)}">
        <span>
          <strong>${esc(item.label)}</strong>
          <small>${esc(runtimeSettingCopy[item.key] || 'Applies to new requests.')}${note}</small>
        </span>
        <input
          id="runtime-${esc(item.key)}"
          name="${esc(item.key)}"
          type="checkbox"
          role="switch"
          ${runtime.settings[item.key] ? 'checked' : ''}
        >
      </label>`;
    })
    .join('');
  const numberSettings = numbers
    .map(
      (item) => `<label for="runtime-${esc(item.key)}">
        <span>
          <strong>${esc(item.label)}</strong>
          <small>
            ${esc(runtimeSettingCopy[item.key] || 'Applied before new work starts.')}
            Current: ${bytes(runtime.settings[item.key])}
          </small>
        </span>
        <span class="runtime-number">
          <input
            id="runtime-${esc(item.key)}"
            name="${esc(item.key)}"
            type="number"
            min="0"
            max="8388607"
            step="0.25"
            required
            value="${esc(runtime.settings[item.key] / GIB)}"
          >
          <b>GB</b>
        </span>
      </label>`,
    )
    .join('');
  const lockedSettings = locked
    .map(
      (item) => `<div>
        <span><strong>${esc(item.label)}</strong><code>${esc(item.env)}</code></span>
        <span class="setting-lock ${item.secret ? 'secret' : ''}">
          ${item.secret ? 'Secret hidden' : 'Restart required'}
        </span>
      </div>`,
    )
    .join('');

  return `<section class="system-section runtime-panel">
    <header>
      <div>
        <h2>Runtime configuration</h2>
        <p>These safe settings apply immediately and persist across restarts.</p>
      </div>
      <span>Revision ${esc(runtime.revision)}</span>
    </header>
    <form id="runtime-settings" class="runtime-settings-form">
      <div class="runtime-toggle-list">${toggles}</div>
      <div class="runtime-number-list">${numberSettings}</div>
      <footer>
        <span>Last changed ${esc(updated)}</span>
        <button class="primary" type="submit" disabled>Apply changes</button>
      </footer>
    </form>
  </section>
  <section class="system-section restart-settings">
    <header>
      <div>
        <h2>Environment &amp; restart settings</h2>
        <p>Infrastructure paths, origins and credentials stay outside the browser.</p>
      </div>
      <span>${locked.length} settings</span>
    </header>
    <div class="restart-setting-list">${lockedSettings}</div>
    <p class="restart-note">
      Edit these values in the server environment, then restart or recreate the affected service.
      Secret values are never returned to this page.
    </p>
  </section>`;
}
function managerView() {
  if (state.user.role !== 'ADMIN') return accountView();
  const m = state.manager || {},
    s = m.status || {},
    services = s.services || {},
    managed = s.managedServices || [],
    tabs = [
      ['overview', 'Overview'],
      ['jobs', 'Jobs'],
      ['access', 'Access'],
      ['logs', 'Logs'],
      ['configuration', 'Configuration'],
    ],
    tab = tabs.some(([key]) => key === state.managerTab) ? state.managerTab : 'overview',
    loaded = Boolean(m.status),
    healthy =
      loaded &&
      ['api', 'database', 'redis'].every((key) => services[key]?.status === 'CONNECTED') &&
      services.worker?.status === 'CONNECTED' &&
      s.queue?.consumerRunning === true &&
      (!managed.length || managed.every((item) => item.status === 'RUNNING')),
    views = {
      overview: () => managerOverview(m, healthy),
      jobs: () => managerJobsView(m),
      access: () => managerAccessView(m),
      logs: () => managerLogsView(m),
      configuration: () => managerConfigurationView(m),
    };
  const healthTone = loaded ? (healthy ? 'healthy' : 'unhealthy') : '';
  const healthLabel = loaded
    ? healthy
      ? 'Operational'
      : 'Attention required'
    : 'Loading snapshot';
  const tabButtons = tabs
    .map(
      ([key, label]) => `<button
        id="system-tab-${key}"
        role="tab"
        aria-selected="${tab === key}"
        aria-controls="system-panel-${key}"
        tabindex="${tab === key ? '0' : '-1'}"
        data-manager-tab="${key}"
      >${esc(label)}</button>`,
    )
    .join('');

  return `<section class="standard-page system-page">
    <header class="page-heading system-heading">
      <div>
        <h1>Server administration</h1>
        <p>Operate this Library Server without exposing infrastructure secrets.</p>
      </div>
      <div class="system-heading-actions">
        <span class="health-dot ${healthTone}">${healthLabel}</span>
        <button data-action="refresh-manager">Refresh</button>
      </div>
    </header>
    <nav class="system-tabs" role="tablist" aria-label="Server administration">
      <div>${tabButtons}</div>
    </nav>
    <div
      id="system-panel-${tab}"
      class="system-tab-panel"
      role="tabpanel"
      aria-labelledby="system-tab-${tab}"
      tabindex="0"
    >${views[tab]()}</div>
  </section>`;
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
  try {
    localStorage.setItem('ps5lib.page', page);
  } catch {
    /* storage unavailable */
  }
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
        (state.page === 'Preparing' ? preparationItems() : downloadPageJobs()).filter(
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
    if (state.page === 'Preparing' && !preparationItems().length) state.page = 'Downloads';
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
async function details(id) {
  state.game = state.catalog.find((g) => g.id === id);
  if (!state.game?.releases?.length)
    throw Error('No downloadable releases are available for this game');
  state.release = state.game.releases.find(installedEntry) || state.game.releases[0];
  state.plan = null;
  detailVineUntil = Date.now() + 800;
  drawDetails();
  await updatePlan(false);
}
function setDetailOrigin(element) {
  const rect = element?.getBoundingClientRect?.();
  if (!rect) return;
  const width = globalThis.innerWidth || document.documentElement?.clientWidth || 1,
    height = globalThis.innerHeight || document.documentElement?.clientHeight || 1;
  dialog.style?.setProperty?.(
    '--detail-origin-x',
    `${Math.max(0, Math.min(100, Math.round(((rect.left + rect.width / 2) * 100) / width)))}%`,
  );
  dialog.style?.setProperty?.(
    '--detail-origin-y',
    `${Math.max(0, Math.min(100, Math.round(((rect.top + rect.height / 2) * 100) / height)))}%`,
  );
}
async function updatePlan(redraw = true) {
  const request = ++planRequest,
    releaseId = state.release?.id,
    consoleId = state.selectedConsole;
  state.plan = null;
  if (redraw) drawDetails();
  if (!releaseId || !consoleId || installedEntry(state.release)) return;
  try {
    const plan = await api('/transfers/plan', 'POST', { releaseId, consoleId });
    if (
      request !== planRequest ||
      releaseId !== state.release?.id ||
      consoleId !== state.selectedConsole
    )
      return;
    state.plan = { ...plan, releaseId, consoleId };
    drawDetails();
  } catch (error) {
    if (request === planRequest) throw error;
  }
}
function releaseActions(r) {
  const formats = new Set(r.artifacts.map((a) => a.format.toLowerCase())),
    build = r.sources.find((s) => ['folder', 'zip', 'rar', '7z'].includes(s.format)),
    source = build || r.sources[0],
    id = esc(source?.id),
    active = state.jobs.find(
      (j) =>
        j.kind === 'BUILD' &&
        j.sourceReleaseId === source?.id &&
        !['COMPLETED', 'ERROR', 'CANCELLED'].includes(j.state),
    ),
    admin = state.user?.role === 'ADMIN',
    actions = [];
  if (active)
    actions.push(
      `<span class="pill">${esc(active.progress?.stage || friendly(active.state))}</span>`,
    );
  else if (formats.has('pkg')) actions.push('<span class="pill">FPKG ready on server</span>');
  else if (build && admin)
    actions.push(
      `<button class="primary" data-prepare="FPKG" data-source-release="${id}">Prepare FPKG on server</button>`,
    );
  else if (build) actions.push('<span class="pill">Administrator preparation required</span>');
  else if (source)
    actions.push(
      `<button class="primary" data-action="download" data-source-release="${id}">Download to server</button>`,
    );
  if (!active) {
    if (formats.has('ffpkg'))
      actions.push('<span class="pill">ShadowMount image ready on server</span>');
    else if (build && admin)
      actions.push(
        `<button data-prepare="SHADOWMOUNT" data-source-release="${id}">Prepare ShadowMount image</button>`,
      );
  }
  return actions.length ? `<div class="row">${actions.join('')}</div>` : '';
}
function trailerPanel(g) {
  let content;
  if (g.trailer) {
    content = `<video
      controls
      preload="none"
      src="${esc(g.trailer.url)}"
      aria-label="Trailer for ${esc(g.title)}"
    ></video>
    ${g.canManage ? '<button data-action="remove-trailer">Remove trailer</button>' : ''}`;
  } else if (g.trailerState && g.trailerState !== 'ERROR') {
    content = '<p>Preparing your trailer?</p><progress aria-label="Preparing trailer"></progress>';
  } else {
    const upload = g.canManage
      ? `<label>
          Add an authorized MP4 trailer (up to 512 MB)
          <input id="trailer-upload" type="file" accept="video/mp4">
        </label>`
      : '<p>No trailer available yet.</p>';
    const error =
      g.trailerState === 'ERROR'
        ? '<p class="error">Preparation failed. Choose a valid MP4 and try again.</p>'
        : '';
    content = `<p>On PS5, highlight this game for five seconds to play its trailer with sound.</p>
      ${upload}${error}`;
  }

  return `<section id="trailer-panel" class="card">
    <h2>Hero trailer</h2>
    ${content}
    <div id="trailer-upload-progress" aria-live="polite"></div>
  </section>`;
}
function sharingView(shares) {
  const globalSharing = shares.sharedToAll
    ? `<aside class="card">
        <strong>Visible to every server member</strong>
        <p>This title also has server-wide sharing enabled.</p>
        ${
          state.user.role === 'ADMIN'
            ? '<button class="danger" data-action="stop-global-sharing">Stop server-wide sharing</button>'
            : ''
        }
      </aside>`
    : '';
  const users = shares.users.length
    ? shares.users
        .map(
          (user) => `<label class="share-user">
            <input
              type="checkbox"
              name="userId"
              value="${esc(user.id)}"
              ${user.granted ? 'checked' : ''}
            >
            <span>
              <strong>${esc(user.username)}</strong>
              <small>Local Library Node account</small>
            </span>
          </label>`,
        )
        .join('')
    : '<p>No other accounts exist yet. Create an invitation from Account first.</p>';

  return `<button class="close" data-action="back-to-game">Back to game</button>
    <h1>Share ${esc(state.game.title)}</h1>
    <p>
      Choose the accounts that may browse and download this title. Their consoles, jobs and
      private libraries remain separate.
    </p>
    ${globalSharing}
    <form id="game-sharing" class="stack">
      ${users}
      <button class="primary">Save access</button>
    </form>`;
}
async function uploadTrailer(file) {
  if (file.size > 512 * 1024 ** 2) throw Error('Choose a trailer smaller than 512 MB');
  const id = state.game.id;
  await new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', `/api/v1/games/${id}/trailer`);
    request.setRequestHeader('Content-Type', 'video/mp4');
    request.timeout = 600000;
    request.upload.onprogress = (e) => {
      const box = document.querySelector('#trailer-upload-progress');
      if (box)
        box.innerHTML = `<progress
          aria-label="Uploading trailer"
          ${e.lengthComputable ? `value="${e.loaded}" max="${e.total}"` : ''}
        ></progress>
        <p>
          ${bytes(e.loaded)} uploaded${e.lengthComputable ? ' / ' + bytes(e.total) : ''}
        </p>`;
    };
    request.onload = () =>
      request.status === 202
        ? resolve()
        : reject(Error('Trailer upload failed: ' + request.status));
    request.onerror = () => reject(Error('Trailer upload failed'));
    request.ontimeout = () => reject(Error('Trailer upload timed out'));
    request.send(file);
  });
  await refresh(false);
  if (state.game?.id === id) {
    state.game = state.catalog.find((g) => g.id === id);
    drawDetails();
  }
  toast('Trailer queued for preparation');
}
function removalButtons(game) {
  return state.library
    .filter((e) => e.titleId === game.titleId && e.canDelete)
    .map(
      (e) =>
        `<button class="danger" data-remove-game="${esc(e.releaseId)}" data-storage="${esc(e.storageId)}">Delete from PS5</button>`,
    )
    .join('');
}
function drawDetails() {
  const g = state.game,
    r = state.release,
    p = state.plan;
  if (!g || !r) return;
  const opening = Date.now() < detailVineUntil,
    installed = installedEntry(r),
    transfer = activeDetailTransfer(),
    console = state.consoles.find((c) => c.id === state.selectedConsole),
    storage = console?.storage?.find((s) => s.storageId === installed?.storageId),
    remove = removalButtons(g),
    manage = g.canManage ? '<button data-action="manage-sharing">Manage access</button>' : '';
  let transferPanel;
  if (installed) {
    transferPanel = `<h2>Installed on this PS5</h2>
      <strong>Ready to play</strong>
      <p>
        ${esc(console?.name || 'Selected PS5')}${storage ? ` · ${esc(storage.displayName)}` : ''}
      </p>`;
  } else if (transfer) {
    transferPanel = `<h2>Send to PS5</h2>${detailTransferProgress(transfer)}`;
  } else {
    const destinations =
      p?.storage
        .map(
          (destination) => `<label class="destination">
            <span>
              <input
                type="radio"
                name="destination"
                value="${esc(destination.storageId)}"
                ${destination.allowed ? '' : 'disabled'}
              >
              <span>${esc(destination.displayName)} · ${bytes(destination.freeBytes)} free</span>
            </span>
            <small>
              ${
                destination.allowed
                  ? 'Enough space available'
                  : 'Insufficient space or unsupported method'
              }
            </small>
          </label>`,
        )
        .join('') || '';
    transferPanel = `<h2>Send to PS5</h2>
      <strong>${esc(p ? friendly(p.compatibility.status) : 'Checking compatibility…')}</strong>
      ${p ? `<p>${esc(friendly(p.reason))}</p>` : ''}
      ${destinations}
      ${p?.allowed ? '<button class="primary" data-action="transfer">Download to this PS5</button>' : ''}`;
  }
  const releaseControls = installed
    ? ''
    : `${releaseActions(r)}
      <p class="detail-cache-note">
        <small>
          ${
            r.artifacts.length
              ? 'A verified copy is cached on your server and can be reused.'
              : 'The server will verify your selected content before publishing it.'
          }
        </small>
      </p>`;
  const detailActions =
    manage || remove ? `<div class="detail-actions">${manage}${remove}</div>` : '';

  setDialog(
    `<div class="detail-shell">
      <img class="detail-backdrop" src="${esc(g.heroUrl || g.coverUrl)}" alt="">
      <div class="detail-shell-shade"></div>
      <button class="close" data-action="close">Close</button>
      <div class="detail-grid">
        <div class="detail-art-frame">
          <img class="detail-cover" src="${esc(g.coverUrl)}" alt="Cover for ${esc(g.title)}">
        </div>
        <svg
          class="detail-vine"
          data-animate="${opening}"
          aria-hidden="true"
          viewBox="0 0 64 140"
          focusable="false"
        >
          <path class="detail-vine-stem" pathLength="1" d="M4 126C50 118 12 38 60 18"/>
          <path
            class="detail-vine-leaf"
            pathLength="1"
            d="M31 82c9-10 18-8 17 3-5 7-11 6-17-3ZM43 52c-8-8-15-4-13 5 5 5 10 3 13-5Z"
          />
        </svg>
        <div class="detail-copy">
          <h1>${esc(g.title)}</h1>
          <p class="detail-description">${esc(g.description || 'Description unavailable.')}</p>
          <div class="facts">
            ${esc(g.publisher || '')} · ${esc(g.developer || '')}<br>
            ${esc((g.genres || []).join(' / '))}
          </div>
          <div class="detail-selectors">
            <label>Release<select id="release-select">${releaseOptions(g, r)}</select></label>
            ${consoleSelect('transfer')}
          </div>
          <section class="transfer-panel">${transferPanel}</section>
          ${releaseControls}
        </div>
      </div>
      ${detailActions}
      <div class="detail-extras">${trailerPanel(g)}</div>
    </div>`,
    '[data-action="close"]',
    true,
  );
}
async function showRemotePlay(id) {
  const console = state.consoles.find((value) => value.id === id);
  if (!console) throw Error('Console unavailable');
  let pairing = await api(`/consoles/${id}/remote-play/pairing`, 'POST', {});
  setDialog(remotePlayView(console, pairing), '[data-action="close"]');
  while (dialog.open && ['REQUESTED', 'READY'].includes(pairing.state)) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (!dialog.open) return;
    pairing = await api(`/consoles/${id}/remote-play/pairing/${pairing.id}`);
    setDialog(remotePlayView(console, pairing), '[data-action="close"]', true);
  }
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
      state.page =
        location.pathname === '/pair'
          ? 'My PS5s'
          : location.pathname === '/profile'
            ? 'Profile'
            : 'Server library';
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
        selectedGameId: '',
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
  if (location.pathname === '/pair') state.page = 'My PS5s';
  else if (location.pathname === '/profile') state.page = 'Profile';
  // otherwise keep the page restored from localStorage (ps5lib.page) so a refresh stays put
  try {
    await refresh();
  } catch {
    render();
  }
  connect();
})();
