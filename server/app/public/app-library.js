'use strict';

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
      const count = page === 'Preparing' ? activePreparations().length : 0;
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
    const stageView = `<h4>${esc(stage)}</h4>${stageProgress}<p class="metrics">${metrics}</p>`;
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
function jobMeta(job, measured = jobBytes(job)) {
  const meta = measured
    ? [`${bytes(measured.completedBytes)} / ${bytes(measured.totalBytes)}`]
    : [];
  if (job.speedBytesPerSecond) meta.push(`${bytes(job.speedBytesPerSecond)}/s`);
  if (job.etaSeconds != null)
    meta.push(`About ${Math.max(1, Math.ceil(job.etaSeconds / 60))} minutes`);
  return meta;
}
const progressBar = (stage, percent) => `<progress
  aria-label="${esc(stage)}"
  max="100"
  ${percent == null ? '' : `value="${percent}"`}
></progress>`;
function detailTransferProgress(job) {
  const measured = jobBytes(job),
    percent = jobPercent(job),
    stage = job.state === 'TRANSFERRING' ? 'Downloading to PS5' : friendly(job.state),
    meta = jobMeta(job, measured);
  const percentLabel = percent == null ? '' : `<strong>${percent}%</strong>`;
  const metrics = meta.length
    ? `<div class="detail-transfer-meta">
        ${meta.map((value) => `<span>${esc(value)}</span>`).join('')}
      </div>`
    : '';

  return `<div class="detail-transfer-progress" data-detail-job-id="${esc(job.id)}">
    <button class="primary" disabled>Download in progress</button>
    <div class="detail-transfer-stage"><span>${esc(stage)}</span>${percentLabel}</div>
    ${progressBar(stage, percent)}
    ${metrics}
  </div>`;
}
function jobTimeline(job) {
  const pipelines = {
      BUILD: [
        ['Download', ['DOWNLOADING']],
        ['Extract', ['EXTRACTING']],
        ['Inspect', ['INSPECTING']],
        ['Prepare', ['STAGING', 'PREPARING']],
        ['Build', ['BUILDING']],
        ['Check', ['VERIFYING']],
        ['Publish', ['PUBLISHING']],
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
    current = steps.findIndex(([, states]) => states.includes(job.state));
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
    stage =
      job.kind === 'BUILD'
        ? job.progress?.stage || friendly(job.state)
        : job.kind === 'TRANSFER' && job.state === 'TRANSFERRING'
          ? 'Downloading to ' + (job.location?.split(' / ')[0] || 'PS5')
          : friendly(job.state),
    meta = jobMeta(job, measured);
  if (job.location) meta.push(job.location.split(' / ')[0]);
  if (job.queuePosition) meta.push(`Queue position ${job.queuePosition}`);
  let actions = '';
  if (job.kind === 'DOWNLOAD' && !['COMPLETED', 'CANCELLED'].includes(job.state)) {
    const command = job.state === 'ERROR' ? 'retry' : job.state === 'PAUSED' ? 'resume' : 'pause';
    const label = job.state === 'ERROR' ? 'Retry' : job.state === 'PAUSED' ? 'Resume' : 'Pause';
    actions = `<button data-control="${esc(job.id)}" data-command="${command}">${label}</button>`;
    if (job.state !== 'ERROR')
      actions += `<button data-control="${esc(job.id)}" data-command="cancel">Cancel</button>`;
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
      ${progressBar(stage, percent)}
      ${metadata}
      ${jobTimeline(job)}
      ${state.page === 'Preparing' && !terminal ? trafficGraph(job) : ''}
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
    activePreparations(),
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
