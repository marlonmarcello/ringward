const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const path = require('node:path');
const { atomicWrite } = require('./platform.cjs');

const FOLDERS = ['library', 'backups', 'tools', 'reshade', 'builds', 'runs'];
const FILES = ['manager.json', 'nexus-key.bin', 'window-state.json'];
const TRANSFER_MARKER = '.ringward-transfer.json';

function within(parent, child) {
  const relative = path.relative(parent, child);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}

function localFolder(folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder) || folder.startsWith('\\\\')) {
    throw new Error('Choose a folder on a local drive. Network storage is not supported by ME3.');
  }
}

async function metadata(file) {
  return fs.lstat(file, { bigint: true }).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
}

async function hash(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function inventory(root) {
  const files = [];
  async function visit(relative) {
    const entry = await metadata(path.join(root, relative));
    if (!entry) return;
    if (entry.isSymbolicLink()) throw new Error('Storage contains a redirected file or folder. Remove its redirection before transferring.');
    if (entry.isDirectory()) {
      for (const name of (await fs.readdir(path.join(root, relative))).sort()) await visit(path.join(relative, name));
    } else if (entry.isFile()) {
      files.push({ relative, size: entry.size, modified: entry.mtimeNs });
    } else {
      throw new Error('Storage contains an unsupported file. Transfer canceled.');
    }
  }
  for (const name of [...FOLDERS, ...FILES]) await visit(name);
  return files;
}

async function readState(root) {
  const file = path.join(root, 'manager.json');
  const info = await metadata(file);
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error('Choose a Ringward data folder containing manager.json.');
  const state = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!state.settings || !Array.isArray(state.mods) || !Array.isArray(state.profiles) || !Array.isArray(state.backups)) {
    throw new Error('This folder does not contain valid Ringward data.');
  }
  return state;
}

function relocateState(state, source, target) {
  const next = structuredClone(state);
  next.storageRoot = target;
  const rebase = value => typeof value === 'string' && path.isAbsolute(value) && within(source, value)
    ? path.join(target, path.relative(source, value)) : value;
  for (const field of ['me3', 'smithbox']) {
    if (next.settings[field] && within(path.join(source, 'tools'), next.settings[field])) {
      next.settings[field] = rebase(next.settings[field]);
    }
  }
  next.lastLog = rebase(next.lastLog);
  if (next.lastVisualLog) next.lastVisualLog = rebase(next.lastVisualLog);
  for (const item of next.pendingBackupDeletions ?? []) {
    if (item.root && !path.relative(path.join(source, 'backups'), item.root)) item.root = path.join(target, 'backups');
  }
  return next;
}

class Storage {
  constructor(defaultRoot) {
    this.defaultRoot = path.resolve(defaultRoot);
    this.root = this.defaultRoot;
    this.pointer = path.join(this.defaultRoot, 'storage-location.json');
    this.journal = path.join(this.defaultRoot, 'storage-transfer.json');
  }

  async load() {
    await this.recoverTransfer();
    const saved = await fs.readFile(this.pointer, 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (saved === null) {
      this.root = this.defaultRoot;
      return this.root;
    }
    const { directory } = JSON.parse(saved);
    localFolder(directory);
    const root = await fs.realpath(directory);
    localFolder(root);
    const state = await readState(root);
    if (state.storageRoot && path.isAbsolute(state.storageRoot) && path.relative(state.storageRoot, root)) {
      await this.useExisting(root);
    }
    this.root = root;
    return root;
  }

  async useExisting(directory) {
    localFolder(directory);
    const root = await fs.realpath(directory);
    localFolder(root);
    const state = await readState(root);
    if (state.storageRoot && path.isAbsolute(state.storageRoot) && path.relative(state.storageRoot, root)) {
      await atomicWrite(path.join(root, 'manager.json'), JSON.stringify(relocateState(state, state.storageRoot, root), null, 2));
    }
    await atomicWrite(this.pointer, JSON.stringify({ directory: root }));
    this.root = root;
  }

  async prepare(directory, protectedFolders = []) {
    localFolder(directory);
    const source = await fs.realpath(this.root);
    const target = await fs.realpath(directory);
    localFolder(target);
    if (path.dirname(target) === target) throw new Error('Choose a dedicated folder inside the drive.');
    if (within(source, target) || within(target, source)) {
      throw new Error('Choose a separate folder outside the current Ringward data folder.');
    }
    for (const folder of protectedFolders.filter(Boolean)) {
      const resolved = await fs.realpath(folder).catch(() => path.resolve(folder));
      if (within(resolved, target) || within(target, resolved)) {
        throw new Error('Choose a dedicated data folder outside the game, save, and Ringward installation folders.');
      }
    }
    if ((await fs.readdir(target)).length) throw new Error('Choose an empty folder. Ringward will transfer your existing data into it.');
    const state = await readState(source);
    if (state.settings.saves) {
      const saves = await fs.realpath(state.settings.saves).catch(() => path.resolve(state.settings.saves));
      if (within(source, saves) || within(source, path.resolve(state.settings.saves))) {
        throw new Error('Your live save folder is inside Ringward’s data folder. Choose an external save folder before transferring.');
      }
    }
    const files = await inventory(source);
    const bytes = files.reduce((total, file) => total + file.size, 0n);
    const space = await fs.statfs(target, { bigint: true });
    if (space.bavail * space.bsize < bytes + 1024n * 1024n) throw new Error('The destination does not have enough free space for this transfer.');
    return { source, target, files, bytes };
  }

  async transfer(plan, assertClosed, progress) {
    const { source, target, files } = plan;
    if (path.relative(source, await fs.realpath(this.root))) throw new Error('The active storage folder changed. Choose the destination again.');
    await assertClosed();
    const stage = await fs.mkdtemp(path.join(path.dirname(target), '.ringward-transfer-'));
    const record = { stage, target, token: randomUUID() };
    let installed = false;
    try {
      await atomicWrite(path.join(stage, TRANSFER_MARKER), JSON.stringify(record));
      await atomicWrite(this.journal, JSON.stringify(record));
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        progress('Transferring ' + file.relative, index / files.length);
        const input = path.join(source, file.relative);
        const output = path.join(stage, file.relative);
        await fs.mkdir(path.dirname(output), { recursive: true });
        await fs.copyFile(input, output);
        const [original, copied] = await Promise.all([hash(input), hash(output)]);
        if (original !== copied) throw new Error('A copied file could not be verified. Your original data is still active.');
      }
      const current = await inventory(source);
      if (current.length !== files.length || current.some((file, index) =>
        file.relative !== files[index].relative || file.size !== files[index].size || file.modified !== files[index].modified)) {
        throw new Error('Storage files changed during the transfer. Close programs editing these files and try again.');
      }
      const next = relocateState(await readState(stage), source, target);
      await atomicWrite(path.join(stage, 'manager.json'), JSON.stringify(next, null, 2));
      await assertClosed();
      // Removing only an empty directory avoids overwriting anything added to the destination.
      await fs.rmdir(target);
      await fs.rename(stage, target);
      installed = true;
      await atomicWrite(this.pointer, JSON.stringify({ directory: target }));
      this.root = target;
      await fs.rm(path.join(target, TRANSFER_MARKER), { force: true }).catch(() => {});
      await fs.rm(this.journal, { force: true }).catch(() => {});
    } catch (error) {
      if (!installed) await this.clearStage(record).catch(() => {});
      else throw new Error('Your original storage is still active. A verified copy is available at ' + target + '.', { cause: error });
      throw error;
    }
  }

  async clearStage(record) {
    if (!path.isAbsolute(record.stage) || !path.isAbsolute(record.target) ||
        !path.basename(record.stage).startsWith('.ringward-transfer-') ||
        path.dirname(record.stage) !== path.dirname(record.target)) return;
    const entry = await metadata(record.stage);
    if (entry?.isDirectory() && !entry.isSymbolicLink()) {
      const saved = JSON.parse(await fs.readFile(path.join(record.stage, TRANSFER_MARKER), 'utf8'));
      if (saved.token !== record.token || saved.stage !== record.stage || saved.target !== record.target) return;
      await fs.rm(record.stage, { recursive: true, force: true });
    }
    await fs.rm(this.journal, { force: true });
  }

  async recoverTransfer() {
    const saved = await fs.readFile(this.journal, 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (saved) {
      try { await this.clearStage(JSON.parse(saved)); } catch {}
    }
  }
}

module.exports = { Storage };
