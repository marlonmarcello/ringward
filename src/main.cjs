const { app, BrowserWindow, Menu, dialog, ipcMain, safeStorage, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Manager } = require('./manager.cjs');
const { atomicWrite, detect, exists } = require('./platform.cjs');
const { assertNoExternalHooks } = require('./reshade.cjs');
const nexus = require('./nexus.cjs');

app.setName('Ringward');
app.setAppUserModelId('app.ringward.manager');
const urls = {
  nexus: nexus.NEXUS + '/mods/',
  apiKey: 'https://www.nexusmods.com/users/myaccount?tab=api%20access',
  eldenSliders: 'https://eldensliders.com/',
  eldenBling: 'https://eldenblingsliders.com/',
  me3: 'https://github.com/garyttierney/me3/releases/latest',
  smithbox: 'https://github.com/vawser/Smithbox/releases/tag/2.2.6',
  reshade: 'https://reshade.me/'
};
const protocolArgs = process.defaultApp ? [path.resolve(__dirname, '..')] : [];
let window;
let manager;
let account = null;
let credential = '';
let busy = false;
const pending = [];

function send(channel, data) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, data);
}

function queueLinks(argv) {
  for (const arg of argv) {
    if (/^nxm:\/\//i.test(arg)) pending.push(arg);
  }
  if (pending.length) send('nexus:incoming');
}

function protocolRegistered() {
  return app.isDefaultProtocolClient('nxm', process.execPath, protocolArgs);
}

async function getState() {
  return { ...manager.snapshot(), tools: await manager.toolStatus(), account, protocol: protocolRegistered() };
}

function register(name, handler, exclusive = false) {
  ipcMain.handle(name, async (event, ...args) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('Unknown request source.');
    }
    if (exclusive && busy) throw new Error('Wait for the current operation to finish.');
    if (exclusive) busy = true;
    try {
      return await handler(...args);
    } finally {
      if (exclusive) {
        busy = false;
        send('operation:progress', null);
      }
    }
  });
}

async function reveal(file) {
  if (!await exists(file)) throw new Error('This path is unavailable.');
  const error = await shell.openPath(file);
  if (error) throw new Error(error);
}

function registerActions() {
  const secret = manager.at('nexus-key.bin');
  register('state', getState);
  register('profile:edit', data => manager.editProfile(data), true);
  register('profile:mod', data => manager.profileMod(data), true);
  register('mods:import', async (mode, profile, dropped) => {
    if (mode === 'drop' && !Array.isArray(dropped)) throw new Error('No files were dropped.');
    const folder = mode === 'folder';
    const preset = mode === 'preset';
    const visual = mode === 'reshade';
    const selection = mode === 'drop' ? { filePaths: dropped } : await dialog.showOpenDialog(window, {
      title: visual ? 'Choose ReShade packs or preset INIs' : preset ? 'Choose preset JSON files' :
        folder ? 'Choose an extracted mod' : 'Choose mods or presets',
      properties: folder ? ['openDirectory'] : ['openFile', 'multiSelections'],
      filters: preset ? [{ name: 'JSON presets', extensions: ['json'] }]
        : visual ? [{ name: 'ReShade packs and presets', extensions: ['zip', '7z', 'rar', 'ini'] }]
          : [{ name: 'Mods and presets', extensions: ['zip', '7z', 'rar', 'csv', 'json', 'ini'] }]
    });
    const imported = [];
    const errors = [];
    for (const file of selection.filePaths) {
      try {
        const isFolder = folder || (mode === 'drop' && (await fs.stat(file)).isDirectory());
        imported.push(await manager.importMod(file, visual ? null : profile, { visualOnly: visual }, isFolder));
      } catch (error) {
        errors.push(path.basename(file) + ' — ' + error.message);
      }
    }
    return { imported, errors };
  }, true);
  register('mods:rename', (id, name) => manager.renameMod(id, name), true);
  register('mods:remove', id => manager.removeMod(id), true);
  register('mods:folder', id => reveal(manager.modRoot(manager.mod(id).id)));
  register('mods:slider-sheet', async (id, index) => reveal(await manager.sliderSheet(id, index)));
  register('mods:appearance-saves', () => manager.appearanceSaves());
  register('mods:apply-appearance', (id, relative) => manager.applyAppearance(id, relative), true);
  register('presets:state', relative => manager.favoritesState(relative));
  register('presets:paste', text => manager.importPresetJson(text), true);
  register('presets:apply', (id, relative, slot) => manager.applyAppearance(id, relative, slot), true);
  register('presets:remove', (relative, slot) => manager.removeAppearance(relative, slot), true);
  register('mods:config-read', (id, file) => manager.config(id, file));
  register('mods:config-write', (id, file, content) => manager.config(id, file, content), true);
  register('settings:pick', async field => {
    if (!['game', 'me3', 'saves', 'smithbox'].includes(field)) throw new Error('Unknown setting.');
    const folder = field === 'saves' || field === 'smithbox';
    const selected = await dialog.showOpenDialog(window, {
      defaultPath: manager.state.settings[field] || undefined,
      properties: folder ? ['openDirectory'] : ['openFile'],
      filters: folder ? undefined : [{ name: 'Executable', extensions: ['exe'] }]
    });
    if (!selected.canceled) await manager.setSetting(field, selected.filePaths[0]);
  }, true);
  register('settings:detect', async () => manager.autodetect(await detect()), true);
  register('settings:skip-logos', value => manager.setSkipLogos(value), true);
  register('settings:smithbox', () => manager.installSmithbox(), true);
  register('settings:me3-install', () => manager.installMe3(), true);
  register('reshade:install', () => manager.installReShade(), true);
  register('reshade:uninstall', () => manager.uninstallReShade(), true);
  register('reshade:select', (id, file) => manager.selectVisual(id, file), true);
  register('reshade:me3', async () => {
    if (!(await manager.me3Status()).compatible) await manager.installMe3(true);
  }, true);
  register('settings:me3-version', async () => {
    const me3 = await manager.me3Status(true);
    if (!me3.ready) throw new Error('Choose me3.exe first.');
    if (!me3.version) throw new Error('The installed ME3 version could not be read.');
    return me3.version;
  });
  register('saves:backup', () => manager.backup(), true);
  register('saves:restore', id => manager.restore(id), true);
  register('merge:review', id => manager.review(id), true);
  register('merge:build', async (id, approval) => {
    const result = await manager.buildRegulation(id, approval);
    if (result.file) shell.showItemInFolder(result.file);
    return result;
  }, true);
  register('game:launch', async (id, approval) => {
    const result = await manager.launch(id, approval);
    if (result.vanilla) {
      const { game } = await detect();
      if (!game) throw new Error('Steam could not be located for a fully vanilla launch.');
      await assertNoExternalHooks(game);
      await manager.assertClosed();
      await shell.openExternal('steam://rungameid/1245620');
    }
    return result;
  }, true);
  register('game:log', async kind => {
    const log = kind === 'reshade' ? manager.state.lastVisualLog : manager.state.lastLog;
    if (!log || !await exists(log)) return '';
    const handle = await fs.open(log, 'r');
    try {
      const { size } = await handle.stat();
      const buffer = Buffer.alloc(Math.min(size, 96_000));
      await handle.read(buffer, 0, buffer.length, size - buffer.length);
      return buffer.toString('utf8').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    } finally {
      await handle.close();
    }
  });
  register('nexus:connect', async key => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows credential encryption is unavailable.');
    const value = String(key).trim();
    if (!value || value.length > 512 || /\s/.test(value)) throw new Error('Enter your personal Nexus Mods API key.');
    const identity = await nexus.account(value);
    await atomicWrite(secret, safeStorage.encryptString(JSON.stringify({ key: value, account: identity })));
    account = identity;
    credential = value;
  }, true);
  register('nexus:disconnect', async () => {
    await fs.rm(secret, { force: true });
    account = null;
    credential = '';
  }, true);
  register('nexus:mod', input => nexus.modDetails(credential, input));
  register('nexus:download', (data, profile) => {
    const request = data.link ? nexus.parseNxm(data.link) : { modId: data.modId, fileId: data.fileId };
    return manager.download(request, credential, profile);
  }, true);
  register('nexus:register', () => {
    if (!app.setAsDefaultProtocolClient('nxm', process.execPath, protocolArgs)) throw new Error('Windows could not register Ringward for Nexus links.');
    if (!protocolRegistered()) throw new Error('Select Ringward for NXM links in Windows Default Apps.');
  }, true);
  register('nexus:pending', () => pending.splice(0));
  register('open:external', (key, params) => {
    let url = Object.hasOwn(urls, key) ? urls[key] : '';
    if (key === 'nexus-file') {
      if (![params.modId, params.fileId].every(value => /^[1-9][0-9]{0,14}$/.test(value))) throw new Error('Invalid Nexus file.');
      url = nexus.NEXUS + '/mods/' + params.modId + '?tab=files&file_id=' + params.fileId + '&nmm=1';
    }
    if (!url) throw new Error('Unknown external link.');
    return shell.openExternal(url);
  });
  register('open:data', key => {
    if (key === 'library' || key === 'backups') return reveal(manager.at(key));
    if (key === 'saves') return reveal(manager.state.settings.saves);
    throw new Error('Unknown folder.');
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  queueLinks(process.argv);
  app.on('second-instance', (_event, argv) => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
    queueLinks(argv);
  });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    const root = app.getPath('userData');
    const worker = app.isPackaged
      ? path.join(process.resourcesPath, 'merge', 'Ringward.Merge.exe')
      : path.join(__dirname, '..', '.tools', 'merge', 'Ringward.Merge.exe');
    manager = new Manager(root, worker, data => send('operation:progress', data));
    await manager.init(await detect());
    try {
      const stored = JSON.parse(safeStorage.decryptString(await fs.readFile(manager.at('nexus-key.bin'))));
      credential = stored.key;
      account = stored.account;
    } catch {}
    manager.onLaunchEnd = code => send('game:ended', code);
    registerActions();
    window = new BrowserWindow({
      width: 1330, height: 910, minWidth: 830, minHeight: 650,
      show: false, backgroundColor: '#131714', title: 'Ringward',
      icon: path.join(__dirname, 'ui', 'assets', 'icon.ico'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true, sandbox: true, nodeIntegration: false
      }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.once('ready-to-show', () => window.show());
    await window.loadFile(path.join(__dirname, 'ui', 'index.html'));
  }).catch(error => {
    dialog.showErrorBox('Ringward could not start', error.message);
    app.exit(1);
  });
  app.on('window-all-closed', () => app.quit());
}
