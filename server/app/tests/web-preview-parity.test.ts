import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { browserBundles } from '../src/api/app.js';
import { readWebAppSource, readWebStyles, webScripts, webStyles } from './web-assets.js';

test('the browser bundles every script and stylesheet in its declared order', async () => {
  const index = await readFile('app/public/index.html', 'utf8');
  assert.ok(index.indexOf('/style.css') < index.indexOf('/app.js'));
  assert.deepEqual(
    browserBundles.map(([url, files, type]) => [url, [...files], type]),
    [
      ['/app.js', webScripts, 'application/javascript'],
      ['/style.css', webStyles, 'text/css'],
    ],
  );
});

test('live web views use the approved library-manager composition with real controls', async () => {
  const [source, styles] = await Promise.all([readWebAppSource(), readWebStyles()]);
  const context = vm.createContext({
    document: { querySelector: () => ({}) },
    URLSearchParams,
    location: { search: '', pathname: '/' },
  });
  vm.runInContext(source.slice(0, source.indexOf('document.addEventListener(')), context);
  vm.runInContext(
    `
    state.user = {username:'Player',role:'ADMIN'};
    state.page = 'Server library';
    state.selectedConsole = 'console';
    state.catalog = [{
      id:'game',
      title:'Real Game',
      titleId:'PPSA00001',
      publisher:'Studio',
      genres:['Action'],
      description:'Real description',
      coverUrl:'/cover.webp',
      heroUrl:'/hero.webp',
      releases:[{
        id:'release',
        kind:'BASE',
        version:'01.00',
        sources:[{format:'folder'}],
        artifacts:[]
      }]
    }];
    state.jobs = [{
      id:'job',
      releaseId:'release',
      consoleId:'console',
      storageId:'usb',
      title:'Real Game',
      kind:'TRANSFER',
      state:'TRANSFERRING',
      downloadedBytes:75,
      totalBytes:100,
      speedBytesPerSecond:10,
      etaSeconds:5,
      location:'USB SSD / game.pkg'
    }];
    state.consoles = [{
      id:'console',
      name:'Living Room PS5',
      presence:'ONLINE',
      firmware:'4.50',
      runtime:'kstuff',
      games:1,
      storage:[{
        storageId:'usb',
        displayName:'USB SSD',
        totalBytes:1000,
        freeBytes:250,
        installMethodsSupported:['FPKG']
      }],
      capabilities:{shadowMount:true},
      isDefault:true
    }];
    state.profile = {
      username:'Player',
      avatarUrl:null,
      consoles:[{
        id:'console',
        name:'Living Room PS5',
        lastSeen:'2026-10-01T12:00:00Z',
        trophySummary:{earnedTrophies:{platinum:1,gold:2,silver:3,bronze:4}},
        games:[{
          gameId:'game',
          title:'Real Game',
          platform:'PS5',
          available:true,
          coverUrl:'/cover.webp'
        }],
        saveData:[]
      }]
    };
  `,
    context,
  );
  const catalog = vm.runInContext('catalogView()', context),
    downloads = vm.runInContext('jobsView()', context),
    profile = vm.runInContext('profileView()', context),
    navigation = vm.runInContext('nav()', context);
  assert.match(navigation, /class="site-sidebar"/);
  assert.match(navigation, /class="brand-mark"/);
  assert.match(navigation, /class="side-nav"/);
  assert.match(navigation, /class="header-tools"/);
  assert.match(navigation, />Library</);
  assert.match(catalog, /class="catalog-workspace"/);
  assert.match(catalog, /class="web-game-grid"/);
  assert.match(catalog, /class="web-game" data-game="game"/);
  assert.match(catalog, /src="\/hero\.webp"/);
  assert.match(downloads, /class="downloads-page"/);
  assert.match(downloads, /class="download-job"/);
  assert.match(downloads, /class="download-job-cover"[^>]*src="\/cover\.webp"/);
  assert.match(downloads, /75%/);
  assert.match(downloads, /data-control="job"/);
  assert.match(downloads, /class="job-stages"/);
  assert.match(profile, /class="profile-head"/);
  assert.match(profile, /class="console-overview"/);
  assert.match(profile, /class="storage-list"/);
  assert.match(profile, /class="trophies"/);
  assert.match(profile, /data-profile-tab="saves"/);
  assert.match(profile, /data-page="My PS5s"/);
  assert.match(styles, /\.app-shell\s*\{[^}]*grid-template-columns:\s*252px/s);
  assert.match(styles, /\.site-sidebar\s*\{[^}]*height:\s*100svh/s);
  assert.match(styles, /\.web-game-grid\s*\{[^}]*grid-template-columns:/s);
  assert.match(styles, /\.app-shell \.downloads-layout\s*\{[^}]*grid-template-columns:/s);
  assert.match(styles, /\.console-overview\s*\{[^}]*grid-template-columns:/s);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*?\.app-shell\s*\{[^}]*display:\s*block/s);
  assert.match(
    styles,
    /@media \(max-width: 720px\)[\s\S]*?\.site-sidebar\s*\{[^}]*height:\s*62px/s,
  );
  assert.match(
    styles,
    /@media \(max-width: 520px\)[\s\S]*?\.web-game-grid\s*\{[^}]*grid-template-columns:\s*1fr/s,
  );
  assert.match(styles, /\.profile-edit:focus-within\s*\{[^}]*outline:\s*3px solid var\(--focus\)/s);
  assert.match(styles, /\.profile-presence\.offline i\s*\{[^}]*box-shadow:\s*none/s);
});

test('console manager presents status storage capabilities and existing actions as an actionable dashboard', async () => {
  const [source, styles] = await Promise.all([readWebAppSource(), readWebStyles()]);
  const context = vm.createContext({
    document: { querySelector: () => ({}) },
    URLSearchParams,
    location: { search: '', pathname: '/' },
  });
  vm.runInContext(source.slice(0, source.indexOf('document.addEventListener(')), context);
  vm.runInContext(
    `
    state.user = {username:'Player',role:'ADMIN'};
    state.selectedConsole = 'console';
    state.catalog = [{id:'game',releases:[{id:'update',kind:'UPDATE'}]}];
    state.jobs = [{
      id:'job',
      consoleId:'console',
      releaseId:'update',
      kind:'TRANSFER',
      state:'TRANSFERRING'
    }];
    state.consoles = [{
      id:'console',
      name:'Living Room PS5',
      presence:'ONLINE',
      lastSeen:'2026-10-09T12:00:00Z',
      firmware:'4.50',
      runtime:'kstuff',
      runtimeStatus:'READY',
      clientKind:'PS5',
      games:12,
      isDefault:true,
      storage:[{
        storageId:'m2',
        displayName:'M.2 SSD',
        totalBytes:1000,
        freeBytes:250,
        writable:true,
        installMethodsSupported:['FPKG','SHADOWMOUNT']
      }],
      capabilities:{
        nativeNotifications:true,
        fpkgInstall:true,
        shadowMount:true,
        backportOverlay:true,
        inventoryScan:true
      }
    }];
  `,
    context,
  );
  const page = vm.runInContext('consolesView()', context);
  assert.match(page, /class="standard-page console-page"/);
  assert.match(page, /class="console-summary"/);
  assert.match(page, /class="console-grid"/);
  assert.match(page, /class="console-pair"/);
  assert.doesNotMatch(page, /class="console-pair"\s+open/);
  assert.match(page, /class="console-action-group"/);
  assert.match(page, /class="console-card online"/);
  assert.match(page, /Last seen/);
  assert.match(page, /Firmware/);
  assert.match(page, /Runtime/);
  assert.match(page, /class="console-storage-grid"/);
  assert.match(page, /M\.2 SSD/);
  assert.match(page, /FPKG/);
  assert.match(page, /Writable destination/);
  assert.match(page, /class="console-card-section console-services"/);
  assert.match(page, /aria-label="6 of 6 services available"/);
  assert.match(page, /class="console-capabilities"/);
  assert.match(page, /ShadowMount/);
  assert.match(page, /Backport overlay/);
  assert.match(page, /data-default="console"/);
  assert.match(page, /data-refresh-console="console"/);
  assert.match(page, /data-revoke="console"/);
  assert.match(page, /data-forget-console="console"/);
  assert.match(styles, /\.console-card\s*\{[^}]*transition:/s);
  assert.match(styles, /\.console-storage-grid\s*\{[^}]*display:\s*grid/s);
  assert.match(
    styles,
    /\.console-service\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/s,
  );
  assert.match(
    styles,
    /@media (?:screen and )?\(max-width: 720px\)[\s\S]*?\.console-summary\s*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/s,
  );
  assert.match(
    styles,
    /@media (?:screen and )?\(max-width: 720px\)[\s\S]*?\.console-grid\s*\{[^}]*grid-template-columns:\s*1fr/s,
  );
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.console-card\s*\{[^}]*transition:\s*none/s,
  );
});
