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
        const online = onlineDeviceCount(account);
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
