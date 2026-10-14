import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { readWebAppSource, readWebStyles } from './web-assets.js';

const compactSource = (source: string) => source.replace(/\s+/g, '');

test('builds show their real stage and only measured work gets a percentage', async () => {
  const source = await readWebAppSource();
  // Exercise the actual view functions without registering browser event handlers.
  const context = vm.createContext({ document: { querySelector: () => ({}) } });
  vm.runInContext(source.slice(0, source.indexOf('document.addEventListener(')), context);
  context.job = {
    kind: 'BUILD',
    state: 'BUILDING',
    progress: {
      stage: 'Building package',
      completedStages: 3,
      totalStages: 7,
      package: { method: 'FPKG', state: 'BUILDING' },
      fakelib: { state: 'SEPARATED' },
    },
  };
  const memberBuild = vm.runInContext("state.user={role:'MEMBER'};progress(job)", context);
  assert.match(memberBuild, /Building package/);
  assert.doesNotMatch(memberBuild, /FPKG preparation|Compatibility files preparation|value=|\d+%/);
  const building = vm.runInContext("state.user={role:'ADMIN'};progress(job)", context);
  assert.match(building, /FPKG preparation/);
  assert.match(building, /Compatibility files preparation/);
  assert.doesNotMatch(building, /value=|\d+%/);
  context.job = {
    kind: 'BUILD',
    state: 'BUILDING',
    compatibilityFilesSupplied: true,
    progress: {
      stage: 'Building package',
      package: { method: 'FPKG', state: 'BUILDING' },
      fakelib: { state: 'NOT_REQUIRED' },
    },
  };
  const supplied = vm.runInContext('progress(job)', context);
  assert.match(supplied, /Compatibility files preparation/);
  assert.match(supplied, /Files supplied/);
  assert.doesNotMatch(supplied, /No libraries supplied/);
  context.job = {
    kind: 'BUILD',
    state: 'EXTRACTING',
    progress: { stage: 'Extracting archive', extraction: { completedBytes: 25, totalBytes: 100 } },
  };
  assert.match(vm.runInContext('progress(job)', context), /25%/);
  assert.match(
    vm.runInContext("state.user={role:'MEMBER'};progress(job)", context),
    /Extracting archive/,
  );
  context.job = {
    kind: 'BUILD',
    state: 'BUILDING',
    progress: { stage: 'Copying to staging', staging: { completedBytes: 50, totalBytes: 100 } },
  };
  assert.match(vm.runInContext('progress(job)', context), /50%/);
  context.job = {
    kind: 'BUILD',
    state: 'BUILDING',
    downloadedBytes: 104857600,
    totalBytes: 104857600,
    progress: {
      stage: 'Building package',
      operation: { completedBytes: 78643200, totalBytes: 314572800 },
      staging: { completedBytes: 104857600, totalBytes: 104857600 },
    },
  };
  const conversion = vm.runInContext('downloadJob(job)', context);
  assert.match(conversion, /25%/);
  assert.match(conversion, /75 MB/);
  assert.match(conversion, /300 MB/);
  assert.doesNotMatch(conversion, /100 MB \/ 100 MB/);
  context.job = {
    kind: 'BUILD',
    state: 'PUBLISHING',
    progress: {
      stage: 'Verifying package for publish',
      operation: { completedBytes: 52428800, totalBytes: 209715200 },
    },
  };
  const publishing = vm.runInContext('downloadJob(job)', context);
  assert.match(publishing, /25%/);
  assert.match(publishing, /50 MB \/ 200 MB/);
  context.job = {
    kind: 'BUILD',
    state: 'DOWNLOADING',
    downloadedBytes: 20,
    totalBytes: 100,
    progress: { stage: 'Downloading source' },
  };
  assert.match(vm.runInContext('progress(job)', context), /20%/);
  assert.match(vm.runInContext('progress(job)', context), /Downloaded source bytes/);
  context.job = { kind: 'TRANSFER', state: 'TRANSFERRING', downloadedBytes: 25, totalBytes: 100 };
  assert.match(vm.runInContext("state.user={role:'MEMBER'};progress(job)", context), /25%/);
  context.job = { ...context.job, totalBytes: null };
  assert.doesNotMatch(vm.runInContext('progress(job)', context), /%|value=/);
  vm.runInContext(
    `state.catalog = [
      {id:'server',title:'Server copy',releases:[
        {id:'s',kind:'BASE',sources:[{}],artifacts:[{format:'pkg'}]}
      ]},
      {id:'dump',title:'Unprepared dump',releases:[
        {id:'d',kind:'BASE',sources:[{format:'folder'}],artifacts:[]}
      ]},
      {id:'console',title:'Console copy',releases:[
        {id:'c',kind:'BASE',sources:[],artifacts:[]}
      ]}
    ];
    state.library = [{releaseId:'c',state:'READY_ON_PS5'}];
    state.page = 'Server library';`,
    context,
  );
  const serverLibrary = vm.runInContext('catalogView()', context);
  assert.match(serverLibrary, /Server copy/);
  assert.match(serverLibrary, /Unprepared dump/);
  assert.doesNotMatch(serverLibrary, /Console copy/);
  vm.runInContext(
    "state.page='My library';state.selectedConsole='console';state.consoles=[{id:'console',name:'Living Room PS5',presence:'ONLINE'}]",
    context,
  );
  const consoleLibrary = vm.runInContext('catalogView()', context);
  assert.match(consoleLibrary, /Console copy/);
  assert.doesNotMatch(consoleLibrary, /Server copy/);
  assert.doesNotMatch(
    consoleLibrary,
    /Available on this console|Games confirmed by your selected PS5/,
  );
  assert.doesNotMatch(
    source,
    /Available on this console|Games confirmed by your selected PS5|Available on this PS5|Available on PS5|On This PS5/,
  );
  const nativeSource = await readFile('../frontend/ps5/frontend/main.cpp', 'utf8');
  assert.doesNotMatch(
    nativeSource,
    /On This PS5|ON THIS PS5|Available on your selected PS5|:"On PS5"/,
  );
  const consoleNavigation = vm.runInContext("state.user.username='member';nav()", context);
  assert.match(consoleNavigation, /<nav class="side-nav" aria-label="Library manager">/);
  assert.match(consoleNavigation, /class="server-state online"/);
  assert.match(consoleNavigation, />My PS5</);
  vm.runInContext(
    "state.page='Server " +
      "library';state.catalog[0].heroUrl='/artwork/server/hero';state.catalog[0].description='Selected " +
      "from the real catalog'",
    context,
  );
  const library = vm.runInContext('catalogView()', context);
  assert.match(library, /class="web-game-grid"/);
  assert.match(library, /src="\/artwork\/server\/hero"/);
  assert.match(library, /data-game="server"/);
  context.game = {
    releases: [
      {
        id: 'base',
        kind: 'BASE',
        version: '01.00',
        size: 59225127809,
        artifacts: [{ format: 'pkg', size: 30713540612 }],
      },
      { id: 'dlc1', kind: 'DLC', title: 'First expansion', version: '01.00', size: 30 },
      { id: 'dlc2', kind: 'DLC', title: 'Second expansion', version: '01.00', size: 40 },
    ],
  };
  const choices = vm.runInContext('releaseOptions(game,{id:"dlc2"})', context);
  assert.match(choices, /<optgroup label="DLC">/);
  assert.match(choices, /First expansion/);
  assert.match(choices, /Second expansion/);
  assert.match(choices, /value="dlc2" selected/);
  assert.match(choices, /28\.6 GB/);
  assert.doesNotMatch(choices, /55\.2 GB/);
  context.release = { sources: [{ format: 'folder' }], artifacts: [{ format: 'pkg' }] };
  const cached = vm.runInContext('releaseActions(release)', context);
  assert.match(cached, /FPKG ready on server/);
  assert.doesNotMatch(cached, /Prepare FPKG|Download to server/);
  context.release = { sources: [{ id: 'source-release-1', format: 'folder' }], artifacts: [] };
  const memberActions = vm.runInContext('releaseActions(release)', context);
  assert.match(memberActions, /Administrator preparation required/);
  assert.doesNotMatch(memberActions, /data-prepare="FPKG"/);
  const actions = vm.runInContext("state.user={role:'ADMIN'};releaseActions(release)", context);
  assert.match(actions, /Prepare FPKG on server/);
  assert.match(actions, /data-source-release="source-release-1"/);
  vm.runInContext(
    "state.jobs=[{id:'build',kind:'BUILD',sourceReleaseId:'source-release-1',state:'BUILDING',progress:{stage:'Building package'}}]",
    context,
  );
  const active = vm.runInContext('releaseActions(release)', context);
  assert.match(active, /Building package/);
  assert.doesNotMatch(active, /data-prepare="FPKG"/);
  assert.match(
    compactSource(source),
    /sourceReleaseId:b\.dataset\.sourceRelease,method:b\.dataset\.prepare/,
  );
  assert.match(source, /reportError\(e\)/);
});

test('a finished build phase does not make the active job look complete', async () => {
  const source = await readWebAppSource(),
    context = vm.createContext({ document: { querySelector: () => ({}) } });
  vm.runInContext(source.slice(0, source.indexOf('document.addEventListener(')), context);
  vm.runInContext("state.user={role:'ADMIN'};state.catalog=[]", context);

  context.job = {
    id: 'build',
    title: 'Baldur’s Gate 3',
    kind: 'BUILD',
    state: 'BUILDING',
    progress: { stage: 'Building package', operation: { completedBytes: 100, totalBytes: 100 } },
  };
  assert.match(
    vm.runInContext('progress(job)', context),
    /100%/,
    'the measured phase may report its own completion',
  );
  const phaseComplete = vm.runInContext('downloadJob(job)', context);
  assert.doesNotMatch(phaseComplete, /100%/);
  assert.doesNotMatch(phaseComplete, /<progress[^>]*value=/);

  context.event = {
    state: 'BUILDING',
    progress: {
      conversion: {
        stage: 'Finalizing package',
        completedStages: 3,
        totalStages: 7,
        package: { state: 'FINALIZING' },
      },
    },
  };
  vm.runInContext('mergeJobEvent(job,event)', context);
  const finalizing = vm.runInContext('downloadJob(job)', context);
  assert.match(finalizing, /Finalizing package/);
  assert.match(finalizing, /<progress\s+aria-label="Finalizing package"\s+max="100"/);
  assert.doesNotMatch(finalizing, /%|<progress[^>]*value=/);

  vm.runInContext("job.state='COMPLETED'", context);
  const completed = vm.runInContext('downloadJob(job)', context);
  assert.match(completed, /value="100"/);
  assert.match(completed, /100%/);
});

test('package preparation has a temporary page and downloads stay separate', async () => {
  const source = await readWebAppSource(),
    context = vm.createContext({ document: { querySelector: () => ({}) } });
  vm.runInContext(source.slice(0, source.indexOf('document.addEventListener(')), context);
  vm.runInContext(
    `state.user={username:'owner',role:'ADMIN'};state.catalog=[];state.consoles=[];
    state.jobs=[
      {id:'build-active',title:'RoadCraft',kind:'BUILD',state:'BUILDING',queuePosition:1,progress:{stage:'Building package'}},
      {id:'download',title:'Source download',kind:'DOWNLOAD',state:'QUEUED',queuePosition:2,downloadedBytes:0,totalBytes:100},
      {id:'build-done',title:'Old build',kind:'BUILD',state:'COMPLETED'}
    ]`,
    context,
  );
  const navigation = vm.runInContext('nav()', context),
    downloads = vm.runInContext('jobsView()', context),
    preparing = vm.runInContext('preparationsView()', context);
  assert.match(navigation, /data-page="Preparing"/);
  assert.match(downloads, /Source download/);
  assert.doesNotMatch(downloads, /RoadCraft|Old build/);
  assert.match(preparing, /RoadCraft/);
  assert.doesNotMatch(preparing, /Source download|Old build/);
  vm.runInContext(
    "state.jobs=[{id:'build-done',title:'Old build',kind:'BUILD',state:'COMPLETED'}]",
    context,
  );
  assert.match(vm.runInContext('nav()', context), /data-page="Preparing"/);
  vm.runInContext(
    "state.jobs=[{id:'build-paused',title:'Paused build',kind:'BUILD',state:'PAUSED'}]",
    context,
  );
  assert.match(vm.runInContext('nav()', context), /data-page="Preparing"/);
});

test('queued jobs expose native drag ordering without moving hidden job kinds', async () => {
  const source = await readWebAppSource(),
    context = vm.createContext({ document: { querySelector: () => ({}) } });
  vm.runInContext(source.slice(0, source.indexOf('document.addEventListener(')), context);
  vm.runInContext(
    `state.user={role:'ADMIN'};state.catalog=[];state.jobs=[
    {id:'one',title:'One',kind:'DOWNLOAD',state:'QUEUED',queuePosition:1},
    {id:'build',title:'Build',kind:'BUILD',state:'QUEUED',queuePosition:2},
    {id:'two',title:'Two',kind:'DOWNLOAD',state:'QUEUED',queuePosition:3},
    {id:'running',title:'Running',kind:'DOWNLOAD',state:'DOWNLOADING',queuePosition:4}
  ]`,
    context,
  );
  assert.match(
    vm.runInContext('downloadJob(state.jobs[0])', context),
    /draggable="true"[^>]*data-queue-job="one"/,
  );
  assert.doesNotMatch(vm.runInContext('downloadJob(state.jobs[3])', context), /draggable="true"/);
  assert.deepEqual(Array.from(vm.runInContext("reorderedQueueIds('two','one',false)", context)), [
    'two',
    'build',
    'one',
  ]);
  assert.deepEqual(Array.from(vm.runInContext("reorderedQueueIds('one','two',true)", context)), [
    'two',
    'build',
    'one',
  ]);
  assert.match(compactSource(source), /api\('\/jobs\/reorder','POST',\{ids\}\)/);
});

test('queue cards preserve their slots and animate to the saved order', async () => {
  const source = await readWebAppSource(),
    animations: any[] = [];
  const classes = () => {
    const values = new Set<string>();
    return {
      add: (value: string) => values.add(value),
      remove: (value: string) => values.delete(value),
    };
  };
  const queue: any = {
    children: [] as any[],
    querySelectorAll() {
      return this.children.filter((row: any) => row.dataset?.queueJob);
    },
    replaceChildren(...rows: any[]) {
      this.children = rows;
    },
  };
  const row = (id: string | null) => ({
    dataset: id ? { queueJob: id } : {},
    classList: classes(),
    matches: (selector: string) => selector === '[data-queue-job]' && Boolean(id),
    getBoundingClientRect() {
      return { top: queue.children.indexOf(this) * 100 };
    },
    animate(frames: any, options: any) {
      animations.push({ id, frames, options });
      return { finished: Promise.resolve() };
    },
  });
  const active = row(null),
    one = row('one'),
    two = row('two'),
    history = row(null);
  queue.children = [active, one, two, history];
  const document = {
    querySelector: (selector: string) => (selector === '.download-queue' ? queue : {}),
    querySelectorAll: () => [],
  };
  const context = vm.createContext({ document, matchMedia: () => ({ matches: false }) });
  vm.runInContext(source.slice(0, source.indexOf('document.addEventListener(')), context);
  await vm.runInContext("animateQueueOrder(['two','one'])", context);
  assert.deepEqual(queue.children, [active, two, one, history]);
  assert.deepEqual(
    animations.map((value) => [value.id, value.frames[0].transform, value.options.duration]),
    [
      ['two', 'translateY(100px)', 220],
      ['one', 'translateY(-100px)', 220],
    ],
  );
});

test('queue drag handling does not cancel unrelated drops', async () => {
  const source = await readWebAppSource(),
    context = vm.createContext({ document: { querySelector: () => ({}) } });
  vm.runInContext(source.slice(0, source.indexOf('document.addEventListener(')), context);
  context.event = {
    target: { closest: () => null },
    preventDefault: () => {
      context.prevented = true;
    },
  };
  await vm.runInContext('queueDrop(event)', context);
  assert.equal(context.prevented, undefined);
});

test('queue ignores a second drag while a reorder is in flight', async () => {
  const source = await readWebAppSource(),
    context = vm.createContext({
      document: { querySelector: () => ({}), querySelectorAll: () => [] },
    });
  vm.runInContext(source.slice(0, source.indexOf('document.addEventListener(')), context);
  vm.runInContext(
    `state.user={role:'ADMIN'};state.jobs=[
    {id:'one',kind:'DOWNLOAD',state:'QUEUED',queuePosition:1},
    {id:'two',kind:'DOWNLOAD',state:'QUEUED',queuePosition:2}
  ];api=()=>{globalThis.posts=(globalThis.posts||0)+1;return new Promise(resolve=>globalThis.finish=resolve)};refresh=async()=>true;render=()=>{};toast=()=>{}`,
    context,
  );
  context.firstEvent = {
    target: { closest: () => ({ dataset: { queueJob: 'two' } }) },
    preventDefault: () => {},
  };
  context.secondEvent = {
    target: { closest: () => ({ dataset: { queueJob: 'one' } }) },
    preventDefault: () => {},
  };
  vm.runInContext(
    "queueDragId='one';globalThis.first=queueDrop(firstEvent);queueDragId='two';globalThis.second=queueDrop(secondEvent)",
    context,
  );
  assert.equal(context.posts, 1);
  context.finish({ ids: ['two', 'one'] });
  await Promise.all([context.first, context.second]);
});

test('queue waits for an in-flight refresh before loading the saved order', async () => {
  const source = await readWebAppSource(),
    context = vm.createContext({
      setTimeout,
      document: { querySelector: () => ({}), querySelectorAll: () => [] },
    });
  vm.runInContext(source.slice(0, source.indexOf('document.addEventListener(')), context);
  vm.runInContext(
    `state.user={role:'ADMIN'};state.jobs=[
    {id:'one',kind:'DOWNLOAD',state:'QUEUED',queuePosition:1},
    {id:'two',kind:'DOWNLOAD',state:'QUEUED',queuePosition:2}
  ];
  api = async () => ({ids:['two','one']});
  refresh = async () => {
    if (refreshing) globalThis.premature = true;
    else globalThis.refreshed = true;
    return !refreshing;
  };
  render = () => {};
  toast = () => {};
  refreshing = true;
  setTimeout(() => refreshing = false, 0);
  queueDragId = 'one';`,
    context,
  );
  context.event = {
    target: { closest: () => ({ dataset: { queueJob: 'two' } }) },
    preventDefault: () => {},
  };
  await vm.runInContext('queueDrop(event)', context);
  assert.equal(context.premature, undefined);
  assert.equal(context.refreshed, true);
});

test('live job events merge progress without refetching the dashboard', async () => {
  const source = await readWebAppSource(),
    context = vm.createContext({ document: { querySelector: () => ({}) } });
  vm.runInContext(source.slice(0, source.indexOf('document.addEventListener(')), context);
  vm.runInContext('refresh=()=>{throw Error("unexpected refresh")}', context);
  vm.runInContext(
    `state.page = 'Account';
    state.jobs = [{
      id:'job',
      kind:'BUILD',
      state:'BUILDING',
      updatedAt:'2026-10-01T00:00:00Z'
    }];
    state.manager.jobs = [{id:'job',kind:'BUILD',state:'BUILDING'}];`,
    context,
  );
  context.message = {
    data: JSON.stringify({
      type: 'events',
      events: [
        {
          id: 9,
          jobId: 'job',
          state: 'BUILDING',
          createdAt: '2026-10-01T00:00:01Z',
          progress: {
            downloadedBytes: 50,
            totalBytes: 100,
            speedBytesPerSecond: 10,
            etaSeconds: 5,
            conversion: {
              stage: 'Copying to staging',
              staging: { completedBytes: 50, totalBytes: 100 },
            },
          },
        },
      ],
    }),
  };
  vm.runInContext('liveMessage(message)', context);
  assert.equal(vm.runInContext('eventCursor', context), 9);
  assert.equal(vm.runInContext('state.jobs[0].downloadedBytes', context), 50);
  assert.equal(vm.runInContext('state.jobs[0].progress.stage', context), 'Copying to staging');
  assert.equal(
    vm.runInContext('state.manager.jobs[0].progress.stage', context),
    'Copying to staging',
  );
  vm.runInContext(
    'refresh=()=>Promise.resolve(globalThis.refreshed=(globalThis.refreshed||0)+1)',
    context,
  );
  context.message = {
    data: JSON.stringify({
      type: 'events',
      events: [
        {
          id: 10,
          jobId: 'job',
          state: 'ERROR',
          createdAt: '2026-10-01T00:00:02Z',
          progress: {
            downloadedBytes: 50,
            totalBytes: 100,
            speedBytesPerSecond: 0,
            etaSeconds: null,
            conversion: { stage: 'Building package' },
          },
        },
      ],
    }),
  };
  vm.runInContext('liveMessage(message)', context);
  assert.equal(vm.runInContext('globalThis.refreshed', context), 1);
});

test('preparation cards chart only measured network speed and prune bounded history', async () => {
  const source = await readWebAppSource(),
    style = await readWebStyles();
  const context = vm.createContext({ document: { querySelector: () => ({}) } });
  vm.runInContext(source.slice(0, source.indexOf('document.addEventListener(')), context);
  vm.runInContext(
    `state.page = 'Preparing';
    state.user = {role:'ADMIN'};
    state.catalog = [];
    job = {
      id:'build',
      title:'RoadCraft',
      kind:'BUILD',
      state:'DOWNLOADING',
      updatedAt:'2026-10-01T00:00:00Z',
      progress:{stage:'Downloading source'}
    };`,
    context,
  );

  assert.match(vm.runInContext('downloadJob(job)', context), /No network activity/);
  for (let sample = 1; sample <= 36; sample++) {
    context.event = {
      state: 'DOWNLOADING',
      createdAt: `2026-10-01T00:00:${String(sample).padStart(2, '0')}Z`,
      progress: { speedBytesPerSecond: sample * 1048576 },
    };
    vm.runInContext('mergeJobEvent(job,event,true)', context);
  }
  const card = vm.runInContext('downloadJob(job)', context);
  assert.match(card, /class="traffic-sparkline"[^>]*role="img"/);
  assert.match(card, /Current 36 MB\/s/);
  assert.match(card, /Peak 36 MB\/s/);
  assert.equal(vm.runInContext("trafficHistory.get('build').length", context), 30);
  assert.equal(vm.runInContext("trafficHistory.get('build')[0]", context), 7 * 1048576);

  context.event = {
    state: 'COMPLETED',
    createdAt: '2026-10-01T00:01:00Z',
    progress: { speedBytesPerSecond: 0 },
  };
  vm.runInContext('mergeJobEvent(job,event,true)', context);
  assert.equal(vm.runInContext("trafficHistory.has('build')", context), false);
  vm.runInContext(
    "recordTraffic({id:'removed',kind:'BUILD',state:'BUILDING',speedBytesPerSecond:1024});syncTrafficHistory([])",
    context,
  );
  assert.equal(vm.runInContext("trafficHistory.has('removed')", context), false);
  assert.match(style, /\.traffic-graph/);
});

test('live build state changes keep the temporary Preparing page filtered', async () => {
  const source = await readWebAppSource(),
    context = vm.createContext({ document: { querySelector: () => ({}) } });
  vm.runInContext(source.slice(0, source.indexOf('document.addEventListener(')), context);
  vm.runInContext(
    `state.page = 'Preparing';
    state.jobs = [{id:'build',kind:'BUILD',state:'BUILDING'}];
    patchVisibleJobs = () => {};
    renderPage = () => globalThis.renders = (globalThis.renders || 0) + 1;
    refresh = () => Promise.resolve(false);`,
    context,
  );
  context.message = {
    data: JSON.stringify({ type: 'events', events: [{ id: 11, jobId: 'build', state: 'PAUSED' }] }),
  };
  vm.runInContext('liveMessage(message)', context);
  assert.equal(vm.runInContext('state.page', context), 'Downloads');
  assert.equal(context.renders, 1);
});

test('live transfer progress patches only its visible row', async () => {
  const source = await readWebAppSource();
  let renders = 0;
  const root = {},
    detail = {},
    rate = { outerHTML: '' },
    row = { dataset: { jobId: 'job' }, outerHTML: '', contains: () => false };
  const document = {
    activeElement: null,
    querySelector: (selector: string) =>
      selector === '#app'
        ? root
        : selector === '#detail'
          ? detail
          : selector === '#downloads-rate'
            ? rate
            : null,
    querySelectorAll: (selector: string) => (selector === '[data-job-id]' ? [row] : []),
  };
  const context = vm.createContext({ document });
  vm.runInContext(source.slice(0, source.indexOf('document.addEventListener(')), context);
  vm.runInContext(
    `state.page = 'Downloads';
    state.user = {role:'MEMBER'};
    state.catalog = [];
    state.consoles = [];
    state.jobs = [{
      id:'job',
      title:'Game',
      kind:'TRANSFER',
      state:'TRANSFERRING',
      downloadedBytes:10,
      totalBytes:100,
      updatedAt:'2026-10-01T00:00:00Z'
    }];
    render = () => globalThis.renders++;`,
    context,
  );
  context.renders = 0;
  context.message = {
    data: JSON.stringify({
      type: 'events',
      events: [
        {
          id: 11,
          jobId: 'job',
          state: 'TRANSFERRING',
          createdAt: '2026-10-01T00:00:01Z',
          progress: {
            downloadedBytes: 50,
            totalBytes: 100,
            speedBytesPerSecond: 10,
            etaSeconds: 5,
          },
        },
      ],
    }),
  };
  vm.runInContext('liveMessage(message)', context);
  renders = Number(context.renders);
  assert.equal(renders, 0);
  assert.match(row.outerHTML, /data-job-id="job"/);
  assert.match(row.outerHTML, /50%/);
  assert.match(rate.outerHTML, /1 active/);
});

test('failed background refresh retains cached data and exposes an offline state', async () => {
  const source = await readWebAppSource(),
    root = {},
    detail = {},
    document = {
      activeElement: null,
      querySelector: (selector: string) =>
        selector === '#app' ? root : selector === '#detail' ? detail : null,
    };
  const context = vm.createContext({ document });
  vm.runInContext(source.slice(0, source.indexOf('document.addEventListener(')), context);
  vm.runInContext(
    "state.user={role:'MEMBER'};state.catalog=[{id:'cached'}];api=async()=>{throw Error('connection refused')}",
    context,
  );
  await assert.rejects(vm.runInContext('refresh(false)', context), /connection refused/);
  assert.equal(vm.runInContext('state.catalog[0].id', context), 'cached');
  assert.match(vm.runInContext('state.connectionError', context), /last loaded data/i);
});

test('game sharing UI selects exact local accounts', async () => {
  const source = await readWebAppSource(),
    context = vm.createContext({ document: { querySelector: () => ({}) } });
  vm.runInContext(source.slice(0, source.indexOf('document.addEventListener(')), context);
  vm.runInContext("state.game={title:'Private game'};state.user={role:'ADMIN'}", context);
  context.shares = {
    sharedToAll: false,
    users: [
      { id: '11111111-1111-4111-8111-111111111111', username: 'family-one', granted: true },
      { id: '22222222-2222-4222-8222-222222222222', username: 'family-two', granted: false },
    ],
  };
  const html = vm.runInContext('sharingView(shares)', context);
  assert.match(html, /family-one/);
  assert.match(html, /11111111-1111-4111-8111-111111111111"\s+checked/);
  assert.match(html, /family-two/);
  assert.doesNotMatch(html, /22222222-2222-4222-8222-222222222222" checked/);
  assert.doesNotMatch(html, /Share this title with server members/);
});

test('PC Remote Play setup stays actionable so offline errors are visible and renders native pairing data safely', async () => {
  const source = await readWebAppSource(),
    context = vm.createContext({ document: { querySelector: () => ({}) } });
  vm.runInContext(source.slice(0, source.indexOf('document.addEventListener(')), context);
  context.console = {
    id: 'console',
    name: 'Living Room',
    presence: 'ONLINE',
    capabilities: { remotePlayPairing: true },
  };
  assert.match(vm.runInContext('remotePlayButton(console)', context), /data-remote-play="console"/);
  context.console = { ...context.console, presence: 'OFFLINE' };
  const offlineButton = vm.runInContext('remotePlayButton(console)', context);
  assert.doesNotMatch(offlineButton, /\sdisabled(?:\s|>)/);
  assert.match(offlineButton, /PS5 agent must be online/);
  context.console = { ...context.console, capabilities: {} };
  assert.equal(vm.runInContext('remotePlayButton(console)', context), '');
  context.console = { ...context.console, name: '<script>' };
  context.pairing = { state: 'READY', pin: '12345678', accountId: 'AQIDBAUGBwg=' };
  const html = vm.runInContext('remotePlayView(console,pairing)', context);
  assert.match(html, /1234 5678/);
  assert.match(html, /AQIDBAUGBwg=/);
  assert.doesNotMatch(html, /<script>/);
});

test('save backup UI groups reported saves and shows real backup progress responsively', async () => {
  const [source, styles] = await Promise.all([readWebAppSource(), readWebStyles()]),
    context = vm.createContext({ document: { querySelector: () => ({}) }, setInterval() {} });
  vm.runInContext(source.slice(0, source.indexOf('document.addEventListener(')), context);
  vm.runInContext(
    `state.catalog = [
      {titleId:'PPSA10001',title:'Current Game',coverUrl:'/cover.webp'}
    ];
    state.consoles = [{
      id:'console',
      name:'Living Room',
      presence:'ONLINE',
      capabilities:{saveBackup:true}
    }];
    state.saveBackups = [{
      id:'backup',
      consoleId:'console',
      localUserId:'1234abcd',
      platform:'PS5',
      gameTitleId:'PPSA10001',
      saveTitleId:'PPSA10000',
      directory:'autosave',
      state:'UPLOADING',
      uploadedBytes:26214400,
      totalBytes:104857600,
      error:null,
      downloadUrl:null
    }];`,
    context,
  );
  context.selected = {
    id: 'console',
    name: 'Living Room',
    saveData: [
      {
        localUserId: '1234abcd',
        platform: 'PS5',
        gameTitleId: 'PPSA10001',
        saveTitleId: 'PPSA10000',
        directory: 'autosave',
        title: 'Current Game',
        subtitle: 'Autosave',
        detail: 'Mission 7',
        sizeBytes: 100,
        modifiedAt: 1,
      },
    ],
  };
  const html = vm.runInContext('saveBackupsView(selected)', context);
  assert.match(html, /Backup in progress/);
  assert.match(html, /value="26214400"\s+max="104857600"/);
  assert.match(html, /25 MB \/ 100 MB/);
  assert.match(html, /data-backup-save="console"[^>]*disabled/);
  assert.match(html, /aria-label="Uploading Current Game save"/);
  assert.match(html, /save-game/);
  assert.match(html, /loading="lazy"\s+decoding="async"/);
  assert.match(html, /Mission 7/);
  assert.match(html, /Backup history/);
  assert.match(html, /Living Room/);
  vm.runInContext('state.saveBackups=[]', context);
  assert.doesNotMatch(
    vm.runInContext('saveBackupsView(selected)', context),
    /data-backup-save="console"[^>]*disabled/,
  );
  assert.match(styles, /\.save-content\s*\{[^}]*grid-template-columns/s);
  assert.match(
    styles,
    /@media \(max-width: 720px\)[\s\S]*\.save-slot\s*\{[^}]*grid-template-columns: 1fr/,
  );
  vm.runInContext("state.page='Saved data'", context);
  assert.equal(vm.runInContext('savedDataVisible()', context), true);
  vm.runInContext("state.page='Profile';state.profileTab='saves'", context);
  assert.equal(vm.runInContext('savedDataVisible()', context), true);
  vm.runInContext("state.consoles[0].presence='OFFLINE'", context);
  assert.match(vm.runInContext('saveBackupsView(selected)', context), /disabled/);
});

test('browser library uses a responsive artwork grid and separates server from console content', async () => {
  const [source, styles] = await Promise.all([readWebAppSource(), readWebStyles()]),
    context = vm.createContext({ document: { querySelector: () => ({}) } });
  vm.runInContext(source.slice(0, source.indexOf('document.addEventListener(')), context);
  vm.runInContext(
    `state.user={username:'owner',role:'ADMIN'};state.page='Server library';state.library=[];state.consoles=[];
    state.catalog=[
      {
        id:'first',
        title:'First game',
        titleId:'PPSA00001',
        publisher:'Studio',
        genres:['Adventure'],
        heroUrl:'/first-hero.webp',
        coverUrl:'/first-cover.webp',
        releases:[{
          id:'first-release',
          kind:'BASE',
          version:'1.00',
          sources:[{format:'folder'}],
          artifacts:[]
        }]
      },
      {
        id:'second',
        title:'Second game',
        titleId:'PPSA00002',
        publisher:'Studio',
        genres:['Action'],
        heroUrl:'/second-hero.webp',
        coverUrl:'/second-cover.webp',
        releases:[{
          id:'second-release',
          kind:'BASE',
          version:'1.02',
          sources:[],
          artifacts:[{format:'pkg'}]
        }]
      }
    ];`,
    context,
  );
  const catalog = vm.runInContext('catalogView()', context),
    navigation = vm.runInContext('nav()', context);
  assert.match(catalog, /class="catalog-workspace"/);
  assert.match(catalog, /class="web-game-grid"/);
  assert.match(catalog, /data-game="first"/);
  assert.match(catalog, /data-game="second"/);
  assert.match(catalog, /src="\/first-hero\.webp"/);
  assert.match(catalog, /Ready on server/);
  assert.match(catalog, /Ready to prepare/);
  assert.match(navigation, /<aside class="site-sidebar">/);
  assert.match(navigation, /<nav class="side-nav" aria-label="Library manager">/);
  assert.match(navigation, /data-page="Server library"[^>]*class="active"[^>]*aria-current="page"/);
  assert.match(navigation, />Library</);
  assert.match(navigation, /data-page="My library"/);
  assert.match(navigation, />My PS5</);
  assert.doesNotMatch(navigation, />Discover</);
  assert.match(styles, /\.web-game-grid\s*\{[^}]*display:\s*grid/s);
  assert.match(styles, /\.web-game img\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*10/s);
  assert.match(styles, /\.web-game img\s*\{[^}]*object-fit:\s*cover/s);
  assert.match(catalog, /loading="lazy"\s+decoding="async"/);
  assert.match(styles, /@font-face\s*\{[^}]*font-family:\s*["']Space Grotesk["']/s);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});

test('library game grid remains keyboard and touch accessible without custom drag state', async () => {
  const [source, styles] = await Promise.all([readWebAppSource(), readWebStyles()]);
  const context = vm.createContext({ document: { querySelector: () => ({}) } });
  vm.runInContext(source.slice(0, source.indexOf('document.addEventListener(')), context);
  vm.runInContext(
    `state.user = {username:'owner',role:'ADMIN'};
    state.page = 'Server library';
    state.library = [];
    state.catalog = [{
      id:'game',
      title:'Game',
      titleId:'PPSA00001',
      coverUrl:'/cover.webp',
      releases:[{
        id:'release',
        kind:'BASE',
        version:'1.00',
        sources:[{format:'folder'}],
        artifacts:[]
      }]
    }];`,
    context,
  );
  const catalog = vm.runInContext('catalogView()', context);
  assert.match(catalog, /<button class="web-game" data-game="game">/);
  assert.match(catalog, /class="web-game-grid"/);
  assert.match(styles, /\.web-game:focus-visible/);
  assert.match(
    styles,
    /@media \(max-width: 520px\)[\s\S]*?\.web-game-grid\s*\{[^}]*grid-template-columns:\s*1fr/s,
  );
  assert.doesNotMatch(source, /startRailDrag|moveRailDrag|suppressRailClick/);
});

test('page navigation transitions content without replaying on live refresh', async () => {
  const [source, styles] = await Promise.all([readWebAppSource(), readWebStyles()]),
    script = compactSource(source);
  assert.match(source, /async function navigate\(page\)/);
  assert.match(source, /document\.startViewTransition\(draw\)/);
  assert.match(
    script,
    /if\(b\.dataset\.page\)\{if\(b\.dataset\.page===state\.page\)renderPage\(\);elseawaitnavigate\(b\.dataset\.page\)/,
  );
  assert.match(styles, /\.main\s*\{[^}]*view-transition-name:\s*page-content/s);
  assert.match(styles, /::view-transition-old\(page-content\)\s*\{[^}]*page-leave/s);
  assert.match(styles, /::view-transition-new\(page-content\)\s*\{[^}]*page-enter/s);
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.main\.page-enter\s*\{[^}]*animation:\s*none/s,
  );
});

test('game details open as a compact panel with a self-drawing cover vine', async () => {
  const [source, styles] = await Promise.all([readWebAppSource(), readWebStyles()]),
    script = compactSource(source);
  assert.match(source, /class="detail-shell"/);
  assert.match(source, /class="detail-vine"[^>]*aria-hidden="true"/);
  assert.match(source, /class="detail-vine"[^>]*data-animate="\$\{opening\}"/);
  assert.match(source, /class="detail-vine-stem"[^>]*pathLength="1"/);
  assert.match(source, /class="detail-vine-leaf"[^>]*pathLength="1"/);
  assert.match(script, /drawDetails\(\);awaitupdatePlan\(false\)/);
  assert.match(script, /detailVineUntil=Date\.now\(\)\+800/);
  assert.match(script, /setDetailOrigin\(b\);awaitdetails\(b\.dataset\.game\)/);
  assert.match(source, /--detail-origin-x/);
  assert.match(source, /--detail-origin-y/);
  assert.match(
    script,
    /asyncfunctionupdatePlan\(redraw=true\)[^{]*\{[\s\S]*?if\(redraw\)drawDetails\(\)/,
  );
  assert.match(
    styles,
    /dialog:has\(\.detail-grid\)\s*\{[^}]*width:\s*min\(900px,[^}]*max-height:\s*82vh/s,
  );
  assert.match(
    styles,
    /dialog\[open\]:has\(\.detail-grid\)\s*\{[^}]*transform-origin:\s*var\(--detail-origin-x,[^}]*var\(--detail-origin-y,/s,
  );
  assert.match(
    styles,
    /\.detail-vine\[data-animate=["']true["']\] \.detail-vine-stem\s*\{[^}]*animation:\s*detail-vine-grow 520ms/s,
  );
  assert.match(styles, /@keyframes detail-vine-grow\s*\{[^}]*stroke-dashoffset:\s*0/s);
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.detail-vine path\s*\{[^}]*animation:\s*none[^}]*stroke-dashoffset:\s*0/s,
  );
});

test('library artwork motion is restrained and respects reduced motion', async () => {
  const [source, styles] = await Promise.all([readWebAppSource(), readWebStyles()]);
  assert.match(source, /loading="lazy"\s+decoding="async"/);
  assert.match(styles, /\.web-game\s*\{[^}]*transition:\s*transform 180ms/s);
  assert.match(styles, /\.web-game:hover,\s*\.web-game:focus-visible\s*\{[^}]*translateY\(-3px\)/s);
  assert.match(
    styles,
    /dialog\[open\]:has\(\.detail-grid\)\s*\{[^}]*animation:\s*game-detail-in 260ms var\(--ease\) both/s,
  );
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.web-game,\s*\.web-game img\s*\{[^}]*transition:\s*none/s,
  );
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?dialog\[open\]:has\(\.detail-grid\)\s*\{[^}]*animation:\s*none/s,
  );
});

test('browser work pages keep their own responsive layout inside the shared shell', async () => {
  const [source, styles] = await Promise.all([readWebAppSource(), readWebStyles()]);
  const app = { innerHTML: '', contains: () => false },
    detail = { open: false },
    document = {
      activeElement: null,
      querySelector: (selector: string) =>
        selector === '#app' ? app : selector === '#detail' ? detail : {},
    };
  const context = vm.createContext({
    document,
    URLSearchParams,
    location: { search: '', pathname: '/' },
  });
  vm.runInContext(source.slice(0, source.indexOf('document.addEventListener(')), context);
  vm.runInContext(
    "state.user={username:'owner',role:'ADMIN'};state.consoles=[];state.jobs=[];state.sources=[];state.artifacts=[]",
    context,
  );
  for (const page of [
    'Downloads',
    'My PS5s',
    'Profile',
    'Server cache',
    'Sources',
    'Server manager',
    'Account',
  ]) {
    vm.runInContext(`state.page=${JSON.stringify(page)};render()`, context);
    assert.match(
      app.innerHTML,
      new RegExp(`class="main page-${page.toLowerCase().replaceAll(' ', '-')}"`),
    );
  }
  assert.match(styles, /\.page-downloads > \.job,[\s\S]*?background:\s*transparent/);
  assert.match(styles, /\.page-sources > \.cols\s*\{[^}]*grid-template-columns:/s);
  assert.match(
    styles,
    /@media \(max-width: 760px\)[\s\S]*?\.page-account > \.card\s*\{[^}]*grid-template-columns:\s*1fr/s,
  );
});

test('secondary manager pages present cache artwork, diagnostics, and task-based settings', async () => {
  const [source, styles] = await Promise.all([readWebAppSource(), readWebStyles()]);
  const stored = new Map<string, string>(),
    context = vm.createContext({
      document: { querySelector: () => ({}), documentElement: { setAttribute() {} } },
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
      },
      URLSearchParams,
      location: { search: '', pathname: '/' },
    });
  vm.runInContext(source.slice(0, source.indexOf('document.addEventListener(')), context);
  vm.runInContext(
    `state.user={username:'owner',role:'ADMIN'};
    state.catalog=[{id:'game',title:'RoadCraft',coverUrl:'/cover.webp',heroUrl:'/hero.webp',releases:[{id:'release',version:'01.00',kind:'BASE'}]}];
    state.artifacts=[{
      id:'artifact',
      releaseId:'release',
      title:'RoadCraft',
      version:'01.00',
      format:'pkg',
      size:1024,
      verified:true,
      builderVersion:'worker-1',
      createdAt:'2026-10-09T10:00:00Z'
    }];
    state.manager={
      updatedAt:Date.now(),
      status:{
        services:{
          api:{status:'CONNECTED',uptimeSeconds:20},
          database:{status:'CONNECTED'},
          redis:{status:'CONNECTED'},
          worker:{status:'CONNECTED'}
        },
        features:{companionApp:true},
        queue:{name:'jobs',consumerRunning:true},
        managedServices:[],
        users:1,
        consoles:1,
        onlineConsoles:1,
        sources:1,
        activeJobs:0,
        failedJobs:0,
        pendingPairings:0,
        artifactBytes:1024
      },
      jobs:[],
      logs:[],
      accounts:[],
      community:{configured:false,state:'DISCONNECTED'},
      runtimeSettings:{
        settings:{
          companionApp:true,
          ps5Connections:true,
          accountRegistration:false,
          community:true,
          newDownloads:true,
          homeUpdateBridge:false,
          quotaBytes:1073741824,
          diskMarginBytes:536870912
        },
        revision:3,
        updatedAt:'2026-10-09T10:00:00Z',
        definitions:[
          {
            key:'companionApp',
            env:'ENABLE_COMPANION_APP',
            label:'Companion app',
            type:'boolean',
            apply:'immediate',
            writable:true,
            enforcement:'client-declared'
          },
          {
            key:'quotaBytes',
            env:'QUOTA_BYTES',
            label:'Storage quota',
            type:'bytes',
            apply:'immediate',
            writable:true
          },
          {
            key:'DATABASE_URL',
            env:'DATABASE_URL',
            label:'Database connection',
            type:'secret',
            apply:'restart',
            writable:false,
            secret:true
          }
        ]
      }
    };`,
    context,
  );
  const cache = vm.runInContext('cacheView()', context),
    settings = vm.runInContext('accountView()', context),
    manager = vm.runInContext('managerView()', context);
  assert.match(cache, /class="cache-gallery"/);
  assert.match(cache, /src="\/hero\.webp"/);
  assert.match(cache, /data-delete="artifact"/);
  assert.match(settings, /class="settings-grid"/);
  assert.match(settings, /data-page="Profile"/);
  assert.match(settings, /data-action="logout"/);
  assert.match(settings, /data-manager-tab-target="configuration"/);
  assert.match(settings, /data-appearance="mono" aria-pressed="false"/);
  vm.runInContext("setAppearance('mono')", context);
  assert.equal(stored.get('ps5library.appearance'), 'mono');
  assert.equal((manager.match(/role="tab"/g) || []).length, 5);
  assert.match(manager, /aria-selected="true"[^>]*data-manager-tab="overview"/);
  assert.match(manager, /class="system-status-strip"/);
  assert.doesNotMatch(manager, /id="manager-service"/);
  vm.runInContext('state.manager.status.queue.consumerRunning=false', context);
  assert.match(vm.runInContext('managerView()', context), /Attention required/);
  const logs = vm.runInContext("state.managerTab='logs';managerView()", context);
  assert.match(logs, /class="system-section manager-log-panel"/);
  assert.match(logs, /id="manager-service"/);
  assert.match(logs, /Clear all application logs/);
  assert.doesNotMatch(logs, /class="system-status-strip"/);
  const configuration = vm.runInContext("state.managerTab='configuration';managerView()", context);
  assert.match(configuration, /id="runtime-settings"/);
  assert.match(configuration, /name="companionApp"[^>]*checked/);
  assert.match(configuration, /name="quotaBytes"[^>]*value="1"/);
  assert.match(
    configuration,
    /Maximum managed storage used by this server\. Set 0 for unlimited\./,
  );
  assert.match(configuration, /<b>GB<\/b>/);
  assert.match(configuration, /Secret hidden/);
  assert.doesNotMatch(configuration, /name="DATABASE_URL"/);
  assert.match(styles, /\.cache-artifact\s*\{[^}]*transition:/s);
  assert.match(styles, /\.cache-artifact:hover[^}]*transform:/s);
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.cache-artifact[^}]*transition:\s*none/s,
  );
  assert.match(
    styles,
    /@media \(max-width: 720px\)[\s\S]*?\.settings-grid[^}]*grid-template-columns:\s*1fr/s,
  );
  assert.match(styles, /\.system-tabs\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(
    styles,
    /@media screen and \(max-width: 720px\)[\s\S]*?\.runtime-toggle[^}]*grid-template-columns:\s*1fr/s,
  );
});

test('console notices are dismissible and do not permanently block the library', async () => {
  const source = await readWebAppSource(),
    stored = new Map<string, string>(),
    context = vm.createContext({
      document: { querySelector: () => ({}) },
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
      },
    });
  vm.runInContext(source.slice(0, source.indexOf('document.addEventListener(')), context);
  vm.runInContext(
    "state.selectedConsole='console';state.notices=[{id:'notice',consoleId:'console',message:'Backport files are missing'}]",
    context,
  );
  assert.match(vm.runInContext('noticesView()', context), /data-dismiss-notice="notice"/);
  vm.runInContext("dismissedNotices.add('notice')", context);
  assert.equal(vm.runInContext('noticesView()', context), '');
});

test('completed download history can be dismissed without deleting its artifact', async () => {
  const source = await readWebAppSource(),
    context = vm.createContext({ document: { querySelector: () => ({}) } });
  vm.runInContext(source.slice(0, source.indexOf('document.addEventListener(')), context);
  vm.runInContext(
    "state.user={role:'ADMIN'};state.jobs=[{id:'job',title:'Space Marine 2',kind:'DOWNLOAD',state:'COMPLETED'}]",
    context,
  );
  assert.match(vm.runInContext('jobsView()', context), /data-dismiss-job="job">Dismiss<\/button>/);
  assert.match(compactSource(source), /api\(`\/jobs\/\$\{b\.dataset\.dismissJob\}`,'DELETE'\)/);
});

test('shared dialog derives its accessible name from the current content', async () => {
  const source = await readWebAppSource(),
    title: { id?: string } = {},
    attributes = new Map<string, string>();
  const detail = {
    open: false,
    innerHTML: '',
    querySelector: (selector: string) => (selector === 'h1,h2' ? title : { focus() {} }),
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
    showModal() {
      this.open = true;
    },
  };
  const context = vm.createContext({
    document: { querySelector: (selector: string) => (selector === '#detail' ? detail : {}) },
  });
  vm.runInContext(source.slice(0, source.indexOf('document.addEventListener(')), context);
  vm.runInContext("setDialog('<h1>Confirm removal</h1>')", context);
  assert.equal(title.id, 'dialog-title');
  assert.equal(attributes.get('aria-labelledby'), 'dialog-title');
  assert.equal(detail.open, true);
});

test('game details close from the backdrop after the exit animation', async () => {
  const source = await readWebAppSource(),
    classes = new Set<string>();
  let closed = 0,
    scheduled: Function | undefined;
  const root = {},
    detail = {},
    dialog = {
      open: true,
      classList: {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
        contains: (name: string) => classes.has(name),
      },
      querySelector: (selector: string) => (selector === '.detail-grid' ? detail : null),
      getBoundingClientRect: () => ({ left: 100, right: 500, top: 100, bottom: 500 }),
      close() {
        closed++;
        this.open = false;
      },
    };
  const document = {
    querySelector: (selector: string) =>
      selector === '#app' ? root : selector === '#detail' ? dialog : {},
  };
  const context = vm.createContext({
    document,
    setTimeout: (run: Function) => {
      scheduled = run;
    },
    matchMedia: () => ({ matches: false }),
  });
  vm.runInContext(source.slice(0, source.indexOf('document.addEventListener(')), context);
  Object.assign(context, {
    inside: { target: dialog, clientX: 200, clientY: 200 },
    outside: { target: dialog, clientX: 50, clientY: 200 },
  });
  vm.runInContext('closeDialogFromBackdrop(inside)', context);
  assert.equal(classes.has('closing'), false);
  vm.runInContext('closeDialogFromBackdrop(outside)', context);
  assert.equal(classes.has('closing'), true);
  assert.equal(closed, 0);
  scheduled?.();
  assert.equal(closed, 1);
  assert.equal(classes.has('closing'), false);
  const script = compactSource(source);
  assert.match(script, /if\(b\.dataset\.action==='close'\)closeDialog\(\)/);
  assert.match(script, /dialog\.addEventListener\('click',closeDialogFromBackdrop\)/);
});

test('live refresh preserves interaction and destructive actions require confirmation', async () => {
  const source = await readWebAppSource(),
    script = compactSource(source);
  assert.match(script, /functionfocusIdentity\(/);
  assert.match(script, /functionrender\(\)\{constfocused=focusIdentity\(root\)/);
  assert.match(script, /!root\.contains\(document\.activeElement\)/);
  assert.match(
    source,
    /\[\s*'My library',\s*'Server library',\s*'Downloads',\s*'Preparing',\s*'Server cache'\s*\]\.includes\(state\.page\)/,
  );
  const savePollStart = script.indexOf('setInterval(async()=>'),
    nextPollStart = script.indexOf('setInterval(()=>', savePollStart + 1);
  assert.ok(savePollStart >= 0 && nextPollStart > savePollStart, 'save polling loop must exist');
  const savePoll = script.slice(savePollStart, nextPollStart);
  assert.doesNotMatch(savePoll, /\brender\(\)/);
  assert.match(script, /if\(b\.dataset\.deleteSaveBackup\)askConfirmation\(/);
  assert.match(script, /if\(b\.dataset\.revoke\)askConfirmation\(/);
  assert.match(script, /if\(b\.dataset\.delete\)askConfirmation\(/);
  assert.match(script, /if\(b\.dataset\.action==='remove-trailer'\)askConfirmation\(/);
  assert.match(script, /if\(action==='disconnect-community'\)askConfirmation\(/);
});
