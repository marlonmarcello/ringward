const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');

const run = promisify(execFile);

async function exists(file) {
  return file ? fs.access(file).then(() => true, () => false) : false;
}

async function atomicWrite(file, data, beforeReplace) {
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temp, data, { flag: 'wx' });
    if (beforeReplace) await beforeReplace();
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

async function detect() {
  const roots = [path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Steam')];
  try {
    const { stdout } = await run('reg.exe', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { windowsHide: true });
    const steam = stdout.match(/SteamPath\s+REG_SZ\s+(.+)/i)?.[1].trim();
    if (steam) roots.unshift(steam);
  } catch {}
  for (const root of [...roots]) {
    const libraries = await fs.readFile(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8').catch(() => '');
    for (const match of libraries.matchAll(/"path"\s+"([^"]+)"/g)) roots.push(match[1].replaceAll('\\\\', '\\'));
  }
  let game = '';
  for (const root of new Set(roots)) {
    const apps = path.join(root, 'steamapps');
    const manifest = await fs.readFile(path.join(apps, 'appmanifest_1245620.acf'), 'utf8').catch(() => '');
    const install = manifest.match(/"installdir"\s+"([^"]+)"/)?.[1] || 'ELDEN RING';
    const candidate = path.join(apps, 'common', install, 'Game', 'eldenring.exe');
    if (await exists(candidate)) {
      game = candidate;
      break;
    }
  }
  const usualMe3 = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'garyttierney', 'me3', 'bin', 'me3.exe');
  let me3 = await exists(usualMe3) ? usualMe3 : '';
  if (!me3) {
    const { stdout } = await run('where.exe', ['me3.exe'], { windowsHide: true }).catch(() => ({ stdout: '' }));
    me3 = stdout.split(/\r?\n/)[0].trim();
  }
  return { game, me3, saves: path.join(process.env.APPDATA || '', 'EldenRing') };
}

async function gameRunning() {
  const { stdout } = await run('tasklist.exe', ['/FI', 'IMAGENAME eq eldenring.exe', '/FO', 'CSV', '/NH'], {
    windowsHide: true, timeout: 8000
  });
  return /^"eldenring\.exe"/im.test(stdout);
}

const SAVE = /^[a-z0-9_-]+\.(sl2|co2|mod)(\.bak)?$/i;
const ACCOUNT = /^\d{10,20}$/;

async function saveFiles(root) {
  if (!await exists(root)) return [];
  const result = [];
  const accounts = await fs.readdir(root, { withFileTypes: true });
  for (const account of accounts.filter(dir => dir.isDirectory() && ACCOUNT.test(dir.name))) {
    const items = await fs.readdir(path.join(root, account.name), { withFileTypes: true });
    for (const item of items.filter(file => file.isFile() && SAVE.test(file.name))) {
      result.push(account.name + '/' + item.name);
    }
  }
  return result.sort();
}

async function assertSaveTarget(root, relative) {
  const [account, filename, extra] = relative.split('/');
  if (extra || !ACCOUNT.test(account) || !SAVE.test(filename)) throw new Error('Invalid backup file.');
  const accountPath = path.join(root, account);
  const dir = await fs.lstat(accountPath).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (dir && !dir.isDirectory()) throw new Error('The save account path is not a regular folder.');
  const target = path.join(accountPath, filename);
  const entry = await fs.lstat(target).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (entry && !entry.isFile()) throw new Error('The save path is not a regular file.');
  return target;
}

module.exports = { run, exists, atomicWrite, detect, gameRunning, saveFiles, assertSaveTarget };
