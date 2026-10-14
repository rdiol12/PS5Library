import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readWebAppSource } from './web-assets.js';

async function load(handlers = false) {
  const source = await readWebAppSource(),
    listeners: Record<string, Function[]> = {};
  const root = { innerHTML: '', querySelector: () => null, contains: () => false };
  const dialog = {
    open: false,
    innerHTML: '',
    addEventListener() {},
    querySelector: () => null,
    prepend() {},
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
    },
    setAttribute() {},
    removeAttribute() {},
  };
  const toast = { textContent: '' };
  const document = {
    activeElement: null,
    querySelector: (selector: string) =>
      selector === '#app'
        ? root
        : selector === '#detail'
          ? dialog
          : selector === '#toast'
            ? toast
            : null,
    querySelectorAll: () => [],
    addEventListener: (type: string, listener: Function) => (listeners[type] ??= []).push(listener),
  };
  const context = vm.createContext({
    document,
    URLSearchParams,
    location: { search: '', pathname: '/' },
    history: { replaceState() {} },
    setTimeout() {},
    setInterval() {},
  });
  const end = handlers
    ? source.indexOf("(async()=>{try{state.user=await api('/me')")
    : source.indexOf('document.addEventListener(');
  vm.runInContext(source.slice(0, end), context);
  return { context, listeners, dialog };
}

test('save backup sends the reported local user id', async () => {
  const { context, listeners } = await load(true);
  context.calls = [];
  vm.runInContext(
    "state.consoles=[{id:'console',presence:'ONLINE',capabilities:{saveBackup:true}}];state.saveBackups=[]",
    context,
  );
  context.selected = {
    id: 'console',
    saveData: [
      {
        localUserId: '1234abcd',
        platform: 'PS5',
        gameTitleId: 'PPSA10001',
        saveTitleId: 'PPSA10000',
        directory: 'autosave',
        title: 'Game',
        sizeBytes: 1,
        modifiedAt: 1,
      },
    ],
  };
  assert.match(
    vm.runInContext('saveBackupsView(selected)', context),
    /data-local-user-id="1234abcd"/,
  );
  vm.runInContext(
    'api=async(...args)=>{calls.push(args);return {}};refresh=async()=>{};toast=()=>{}',
    context,
  );
  const button = {
    dataset: {
      backupSave: 'console',
      localUserId: '1234abcd',
      platform: 'PS5',
      gameTitle: 'PPSA10001',
      saveTitle: 'PPSA10000',
      directory: 'autosave',
    },
    disabled: false,
    setAttribute() {},
    removeAttribute() {},
  };
  await listeners.click[1]({ target: { closest: () => button } });
  assert.deepEqual(JSON.parse(JSON.stringify(context.calls[0])), [
    '/consoles/console/saves/backups',
    'POST',
    {
      localUserId: '1234abcd',
      platform: 'PS5',
      gameTitleId: 'PPSA10001',
      saveTitleId: 'PPSA10000',
      directory: 'autosave',
    },
  ]);
});

test('only the latest transfer plan can be used or submitted', async () => {
  const { context, listeners, dialog } = await load(true);
  context.pending = [];
  context.calls = [];
  vm.runInContext(
    'drawDetails=()=>{};api=(url,method,body)=>new ' +
      "Promise(resolve=>pending.push({body,resolve}));state.release={id:'release-1'};state.selectedConsole='console-1'",
    context,
  );
  const first = vm.runInContext('updatePlan()', context);
  vm.runInContext("state.release={id:'release-2'};state.selectedConsole='console-2'", context);
  const second = vm.runInContext('updatePlan()', context);
  context.pending[1].resolve({ artifactId: 'artifact-2' });
  await second;
  context.pending[0].resolve({ artifactId: 'artifact-1' });
  await first;
  assert.equal(vm.runInContext('state.plan.artifactId', context), 'artifact-2');
  assert.equal(
    vm.runInContext('state.plan.releaseId+":"+state.plan.consoleId', context),
    'release-2:console-2',
  );
  dialog.querySelector = () => ({ value: 'internal' });
  dialog.open = true;
  vm.runInContext(
    "state.release={id:'release-3'};api=async(...args)=>{calls.push(args)};reportError=e=>globalThis.error=e.message",
    context,
  );
  const button = {
    dataset: { action: 'transfer' },
    disabled: false,
    setAttribute() {},
    removeAttribute() {},
  };
  await listeners.click[1]({ target: { closest: () => button } });
  assert.equal(context.calls.length, 0);
  assert.match(context.error, /current/i);
});

test('the first available game drives the initial hero and console select ids stay contextual', async () => {
  const { context } = await load();
  vm.runInContext(
    `state.user = {username:'owner',role:'ADMIN'};
    state.consoles = [{id:'console',name:'PS5',presence:'ONLINE'}];
    state.library = [];
    state.page = 'Server library';
    state.catalog = [
      {
        id:'other',
        title:'Other',
        titleId:'PPSA00001',
        coverUrl:'/other-cover',
        heroUrl:'/other-hero',
        releases:[{
          id:'other-release',
          kind:'BASE',
          version:'1',
          sources:[{}],
          artifacts:[]
        }]
      },
      {
        id:'featured',
        title:'Featured',
        titleId:'PPSA00002',
        coverUrl:'/featured-cover',
        heroUrl:'/featured-hero',
        releases:[{
          id:'featured-release',
          kind:'BASE',
          version:'1',
          sources:[{}],
          artifacts:[]
        }]
      }
    ];`,
    context,
  );
  let html = vm.runInContext('catalogView()', context);
  assert.match(html, /Other/);
  assert.match(html, /src="\/other-hero"/);
  vm.runInContext("state.selectedGameId='other'", context);
  html = vm.runInContext('catalogView()', context);
  assert.match(html, /src="\/other-hero"/);
  vm.runInContext(
    "state.page='My library';state.selectedGameId='';state.library=[{releaseId:'other-release',state:'READY_ON_PS5'}]",
    context,
  );
  html = vm.runInContext('catalogView()', context);
  assert.match(html, /Other/);
  assert.doesNotMatch(html, /Featured/);
  const page = vm.runInContext("consoleSelect('library')", context),
    modal = vm.runInContext("consoleSelect('transfer')", context);
  assert.match(page, /id="console-select-library"[^>]*data-console-select="library"/);
  assert.match(modal, /id="console-select-transfer"[^>]*data-console-select="transfer"/);
});

test('members see prepared packages but cannot start package conversion', async () => {
  const { context } = await load();
  vm.runInContext("state.user={username:'member',role:'MEMBER'};state.jobs=[]", context);
  const release = { sources: [{ id: 'source', format: 'folder' }], artifacts: [] };
  context.release = release;
  const member = vm.runInContext('releaseActions(release)', context);
  assert.doesNotMatch(member, /data-prepare/);
  assert.match(member, /administrator/i);
  vm.runInContext("state.user={username:'owner',role:'ADMIN'}", context);
  assert.match(vm.runInContext('releaseActions(release)', context), /data-prepare="FPKG"/);
});

test('game details select the installed release and do not plan another transfer', async () => {
  const { context, dialog } = await load();
  context.calls = [];
  vm.runInContext(
    `state.selectedConsole = 'console';
    state.library = [{releaseId:'installed',state:'READY_ON_PS5'}];
    state.catalog = [{
      id:'game',
      title:'Installed game',
      titleId:'PPSA00003',
      coverUrl:'/cover',
      heroUrl:'/hero',
      genres:[],
      releases:[
        {id:'server',kind:'BASE',version:'01.00',sources:[{}],artifacts:[{format:'pkg'}],backports:[]},
        {id:'installed',kind:'BASE',version:'01.01',sources:[],artifacts:[],backports:[]}
      ]
    }];
    api = async (...args) => {
      calls.push(args);
      return {
        allowed:false,
        compatibility:{status:'UNSUPPORTED_METHOD'},
        storage:[]
      };
    };`,
    context,
  );
  await vm.runInContext("details('game')", context);
  assert.equal(vm.runInContext('state.release.id', context), 'installed');
  assert.equal(context.calls.length, 0);
  assert.match(dialog.innerHTML, /Installed on this PS5/);
  assert.doesNotMatch(dialog.innerHTML, /Send to PS5|Download to this PS5|Unsupported method/);
  assert.doesNotMatch(
    dialog.innerHTML,
    /verify your selected content|Prepare FPKG|Download to server/,
  );
});

test('game details replace the transfer action with live measured progress', async () => {
  const { context, dialog } = await load();
  vm.runInContext(
    `state.selectedConsole = 'console';
    state.library = [];
    state.consoles = [{id:'console',name:'PS5',storage:[]}];
    state.game = {
      id:'game',
      title:'Queued game',
      titleId:'PPSA00004',
      coverUrl:'/cover',
      heroUrl:'/hero',
      genres:[],
      releases:[{
        id:'release',
        kind:'BASE',
        version:'01.00',
        sources:[],
        artifacts:[{format:'pkg'}],
        backports:[]
      }]
    };
    state.release = state.game.releases[0];
    state.plan = {
      allowed:true,
      releaseId:'release',
      consoleId:'console',
      compatibility:{status:'NATIVE_COMPATIBLE'},
      storage:[]
    };
    state.jobs = [{
      id:'transfer',
      kind:'TRANSFER',
      releaseId:'release',
      consoleId:'console',
      state:'TRANSFERRING',
      downloadedBytes:25,
      totalBytes:100,
      speedBytesPerSecond:10,
      etaSeconds:8
    }];`,
    context,
  );
  vm.runInContext('drawDetails()', context);
  assert.match(dialog.innerHTML, /Download in progress/);
  assert.match(dialog.innerHTML, /data-detail-job-id="transfer"/);
  assert.match(dialog.innerHTML, /value="25"/);
  assert.match(dialog.innerHTML, /25%/);
  assert.doesNotMatch(dialog.innerHTML, /Download to this PS5/);

  const progress = { dataset: { detailJobId: 'transfer' }, outerHTML: '' };
  dialog.querySelector = (selector: string) =>
    selector === '[data-detail-job-id]' ? progress : null;
  context.message = {
    data: JSON.stringify({
      type: 'events',
      events: [
        {
          id: 2,
          jobId: 'transfer',
          state: 'TRANSFERRING',
          createdAt: '2026-10-02T00:00:00Z',
          progress: {
            downloadedBytes: 50,
            totalBytes: 100,
            speedBytesPerSecond: 20,
            etaSeconds: 3,
          },
        },
      ],
    }),
  };
  vm.runInContext('liveMessage(message)', context);
  assert.match(progress.outerHTML, /value="50"/);
  assert.match(progress.outerHTML, /50%/);
});

test('queuing a transfer immediately keeps the game open with an indeterminate progress card', async () => {
  const { context, listeners, dialog } = await load(true);
  dialog.open = true;
  dialog.querySelector = (selector: string) =>
    selector === 'input[name="destination"]:checked' ? { value: 'm2' } : null;
  vm.runInContext(
    `state.selectedConsole = 'console';
    state.library = [];
    state.consoles = [{id:'console',name:'PS5',storage:[]}];
    state.game = {
      id:'game',
      title:'Queued game',
      titleId:'PPSA00004',
      coverUrl:'/cover',
      heroUrl:'/hero',
      genres:[],
      releases:[{
        id:'release',
        kind:'BASE',
        version:'01.00',
        sources:[],
        artifacts:[{format:'pkg'}],
        backports:[]
      }]
    };
    state.release = state.game.releases[0];
    state.plan = {
      allowed:true,
      artifactId:'artifact',
      releaseId:'release',
      consoleId:'console',
      compatibility:{status:'NATIVE_COMPATIBLE'},
      storage:[]
    };
    api = async () => ({id:'transfer'});
    refresh = async () => false;
    toast = () => {};`,
    context,
  );
  const button = {
    dataset: { action: 'transfer' },
    disabled: false,
    setAttribute() {},
    removeAttribute() {},
  };
  await listeners.click[1]({ target: { closest: () => button } });
  assert.equal(dialog.open, true);
  assert.match(dialog.innerHTML, /Download in progress/);
  assert.match(dialog.innerHTML, /data-detail-job-id="transfer"/);
  assert.doesNotMatch(dialog.innerHTML, /Download to this PS5/);
  assert.equal(vm.runInContext('state.jobs[0].state', context), 'QUEUED_FOR_PS5');
});

test('a completed transfer reconciles the open game to ready on PS5', async () => {
  const { context, dialog } = await load();
  dialog.open = true;
  vm.runInContext(
    `state.selectedConsole = 'console';
    state.library = [];
    state.consoles = [{
      id:'console',
      name:'PS5',
      storage:[{storageId:'m2',displayName:'M.2 SSD'}]
    }];
    state.game = {
      id:'game',
      title:'Ready game',
      titleId:'PPSA00005',
      coverUrl:'/cover',
      heroUrl:'/hero',
      genres:[],
      releases:[{
        id:'release',
        kind:'BASE',
        version:'01.00',
        sources:[],
        artifacts:[{format:'pkg'}],
        backports:[]
      }]
    };
    state.release = state.game.releases[0];
    state.jobs = [{
      id:'transfer',
      kind:'TRANSFER',
      releaseId:'release',
      consoleId:'console',
      storageId:'m2',
      state:'TRANSFERRING',
      downloadedBytes:50,
      totalBytes:100,
      updatedAt:'2026-10-01T00:00:00Z'
    }];
    refresh = async () => {
      state.library = [{releaseId:'release',storageId:'m2',state:'READY_ON_PS5'}];
      return true;
    };
    renderPage = () => {};`,
    context,
  );
  context.message = {
    data: JSON.stringify({
      type: 'events',
      events: [
        {
          id: 3,
          jobId: 'transfer',
          state: 'READY_ON_PS5',
          createdAt: '2026-10-02T00:00:00Z',
          progress: { downloadedBytes: 100, totalBytes: 100 },
        },
      ],
    }),
  };
  vm.runInContext('liveMessage(message)', context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(dialog.innerHTML, /Installed on this PS5/);
  assert.match(dialog.innerHTML, /Ready to play/);
  assert.doesNotMatch(dialog.innerHTML, /Download in progress|Download to this PS5/);
});

test('changing the modal console reloads that console inventory before planning', async () => {
  const { context, listeners, dialog } = await load(true);
  context.calls = [];
  dialog.open = true;
  vm.runInContext(
    `state.selectedConsole = 'old-console';
    state.library = [];
    state.consoles = [{id:'new-console',name:'New PS5',storage:[]}];
    state.game = {
      id:'game',
      title:'Installed game',
      titleId:'PPSA00003',
      coverUrl:'/cover',
      heroUrl:'/hero',
      genres:[],
      releases:[{
        id:'installed',
        kind:'BASE',
        version:'01.01',
        sources:[],
        artifacts:[],
        backports:[]
      }]
    };
    state.release = state.game.releases[0];
    api = async (...args) => {
      calls.push(args);
      if (args[0] === '/consoles/new-console/library') {
        return [{releaseId:'installed',state:'READY_ON_PS5'}];
      }
      return {
        allowed:false,
        compatibility:{status:'UNSUPPORTED_METHOD'},
        storage:[]
      };
    };`,
    context,
  );
  await listeners.change[0]({
    target: { dataset: { consoleSelect: 'transfer' }, value: 'new-console' },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(context.calls)), [['/consoles/new-console/library']]);
  assert.match(dialog.innerHTML, /Installed on this PS5/);
});

test('profile presence class reflects the selected console', async () => {
  const { context } = await load();
  vm.runInContext(
    `state.user = {username:'owner'};
    state.catalog = [];
    state.profile = {
      username:'owner',
      consoles:[{id:'console',name:'PS5',games:[]}]
    };
    state.consoles = [{id:'console',presence:'OFFLINE',storage:[],capabilities:{}}];
    state.selectedConsole = 'console';`,
    context,
  );
  assert.match(vm.runInContext('profileView()', context), /class="profile-presence offline"/);
  vm.runInContext("state.consoles[0].presence='ONLINE'", context);
  assert.match(vm.runInContext('profileView()', context), /class="profile-presence online"/);
  vm.runInContext("state.profile.consoles=[];state.consoles=[];state.selectedConsole=''", context);
  assert.match(vm.runInContext('profileView()', context), /class="profile-presence offline"/);
});

test('runtime settings collect only changed writable values', async () => {
  const { context } = await load();
  context.runtime = {
    settings: { companionApp: true, quotaBytes: 1073741824 },
    definitions: [
      { key: 'companionApp', label: 'Companion app', type: 'boolean', writable: true },
      { key: 'quotaBytes', label: 'Storage quota', type: 'bytes', writable: true },
      { key: 'DATABASE_URL', label: 'Database', type: 'secret', writable: false },
    ],
  };
  context.form = {
    elements: {
      namedItem: (key: string) =>
        key === 'companionApp' ? { checked: false } : key === 'quotaBytes' ? { value: '2' } : null,
    },
  };
  assert.deepEqual(
    JSON.parse(JSON.stringify(vm.runInContext('runtimeSettingsChanges(form,runtime)', context))),
    { companionApp: false, quotaBytes: 2147483648 },
  );
  context.form.elements.namedItem = (key: string) =>
    key === 'quotaBytes' ? { value: '-1' } : { checked: true };
  assert.throws(
    () => vm.runInContext('runtimeSettingsChanges(form,runtime)', context),
    /non-negative storage size/,
  );
});

test('settings shortcuts and system tabs select the requested workspace', async () => {
  const { context, listeners } = await load(true);
  vm.runInContext(
    `state.user = {role:'ADMIN'};
    state.page = 'Server manager';
    renderPage = () => {
      globalThis.rendered = state.managerTab;
    };
    navigate = async page => {
      state.page = page;
      globalThis.navigated = page;
    };`,
    context,
  );
  const shortcut = {
    dataset: { page: 'Server manager', managerTabTarget: 'configuration' },
    disabled: false,
    setAttribute() {},
    removeAttribute() {},
  };
  await listeners.click[1]({ target: { closest: () => shortcut } });
  assert.equal(context.rendered, 'configuration');
  const tab = {
    dataset: { managerTab: 'logs' },
    disabled: false,
    setAttribute() {},
    removeAttribute() {},
  };
  await listeners.click[1]({ target: { closest: () => tab } });
  assert.equal(vm.runInContext('state.managerTab', context), 'logs');
  assert.equal(context.rendered, 'logs');
});

test('runtime configuration applies an optimistic patch and reloads conflicts', async () => {
  const { context, listeners } = await load(true);
  context.calls = [];
  context.messages = [];
  context.FormData = class {
    *[Symbol.iterator]() {}
  };
  vm.runInContext(
    `state.manager.runtimeSettings = {
      revision:4,
      settings:{companionApp:true,quotaBytes:1073741824},
      definitions:[
        {key:'companionApp',label:'Companion app',type:'boolean',writable:true},
        {key:'quotaBytes',label:'Storage quota',type:'bytes',writable:true}
      ]
    };
    api = async (...args) => {
      calls.push(args);
      return {
        ...state.manager.runtimeSettings,
        revision:5,
        settings:{companionApp:false,quotaBytes:2147483648}
      };
    };
    renderPage = () => {};
    toast = message => messages.push(message);`,
    context,
  );
  const controls: any = { companionApp: { checked: false }, quotaBytes: { value: '2' } },
    form: any = {
      id: 'runtime-settings',
      dataset: {},
      elements: { namedItem: (key: string) => controls[key] },
    };
  await listeners.submit[0]({ preventDefault() {}, target: form });
  assert.deepEqual(JSON.parse(JSON.stringify(context.calls[0])), [
    '/admin/runtime-settings',
    'PATCH',
    { revision: 4, settings: { companionApp: false, quotaBytes: 2147483648 } },
  ]);
  assert.equal(context.messages.at(-1), 'Runtime configuration applied');

  context.calls = [];
  context.messages = [];
  vm.runInContext(
    `state.manager.runtimeSettings.revision = 5;
    state.manager.runtimeSettings.settings.companionApp = false;
    api = async (...args) => {
      calls.push(args);
      if (args[1] === 'PATCH') {
        const error = Error('changed');
        error.status = 409;
        throw error;
      }
      return {...state.manager.runtimeSettings,revision:6};
    };`,
    context,
  );
  controls.companionApp.checked = true;
  controls.quotaBytes.value = '2';
  await listeners.submit[0]({ preventDefault() {}, target: form });
  assert.deepEqual(JSON.parse(JSON.stringify(context.calls.map((call: any[]) => call[0]))), [
    '/admin/runtime-settings',
    '/admin/runtime-settings',
  ]);
  assert.match(context.messages.at(-1), /another session/i);
});

test('log filters fetch only the filtered log stream', async () => {
  const { context } = await load();
  context.calls = [];
  vm.runInContext(
    "state.logService='worker';state.logLevel='ERROR';state.manager={logs:[]};api=async " +
      "url=>{calls.push(url);return [{service:'worker'}]};renderPage=()=>{}",
    context,
  );
  await vm.runInContext('refreshManagerLogs()', context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.calls)), [
    '/admin/logs?limit=200&service=worker&level=ERROR',
  ]);
  assert.equal(vm.runInContext('state.manager.logs[0].service', context), 'worker');
});
