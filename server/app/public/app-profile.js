const onlineDeviceCount = (account) =>
  account.devices.filter((device) => device.presence === 'ONLINE' && !device.revokedAt).length;

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
      const online = onlineDeviceCount(account);
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
