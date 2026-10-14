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
