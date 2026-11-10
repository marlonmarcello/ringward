const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { exists, atomicWrite, saveFiles, assertSaveTarget } = require('./platform.cjs');

const parkedBackupPath = folder => folder + '.deleting';
const BACKUP_ID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

async function backupDirectoryExists(folder) {
  const entry = await fs.lstat(folder).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!entry) return false;
  if (!entry.isDirectory()) throw new Error('This backup path is not a regular folder.');
  return true;
}

class BackupStorage {
  constructor(root, readState, update, assertClosed) {
    this.root = root;
    this.readState = readState;
    this.update = update;
    this.assertClosed = assertClosed;
  }

  async create(reason, profileId, subset = null) {
    const root = this.readState().settings.saves;
    const files = subset || await saveFiles(root);
    if (!files.length) return null;
    const backup = { id: randomUUID(), time: new Date().toISOString(), reason, profile: profileId, files };
    await fs.mkdir(this.root, { recursive: true });
    const dest = path.join(await this.resolvedRoot(), backup.id);
    await fs.mkdir(dest);
    try {
      for (const relative of files) {
        const source = await assertSaveTarget(root, relative);
        const output = path.join(dest, relative);
        await fs.mkdir(path.dirname(output), { recursive: true });
        await fs.copyFile(source, output);
      }
      await this.update(state => { state.backups.unshift(backup); });
      return backup;
    } catch (error) {
      await fs.rm(dest, { recursive: true, force: true });
      throw error;
    }
  }

  async createManual() {
    await this.assertClosed();
    if (!await this.create('Manual', this.readState().active)) throw new Error('No Elden Ring saves were found in the configured folder.');
  }

  record(backupId) {
    const backup = this.readState().backups.find(item => item.id === backupId);
    if (!backup || !BACKUP_ID.test(backup.id)) {
      throw new Error('This backup is unavailable.');
    }
    return backup;
  }

  resolvedRoot() {
    return fs.realpath(this.root);
  }

  async folder(backupId) {
    const { id } = this.record(backupId);
    const folder = path.join(await this.resolvedRoot(), id);
    // A backup parked by an interrupted delete is still usable while it is listed.
    if (await backupDirectoryExists(folder)) return folder;
    const parked = parkedBackupPath(folder);
    if (await backupDirectoryExists(parked)) return parked;
    return folder;
  }

  async mainSaveFolder() {
    const root = this.readState().settings.saves;
    if (!root) throw new Error('Choose the Elden Ring save folder in Settings.');
    const saves = await saveFiles(root);
    const accounts = new Set(saves.map(file => path.posix.dirname(file)));
    return accounts.size === 1 ? path.join(root, accounts.values().next().value) : root;
  }

  async rename(backupId, value) {
    this.record(backupId);
    if (typeof value !== 'string' || !value.trim()) throw new Error('Enter a backup name.');
    await this.update(state => { state.backups.find(item => item.id === backupId).name = value.trim().slice(0, 120); });
  }

  async protectSaveFolder(...folders) {
    const configured = this.readState().settings.saves;
    if (!configured) return;
    const configuredPath = path.resolve(configured);
    const resolved = await fs.realpath(configured).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return configuredPath;
    });
    for (const folder of folders) {
      if ([configuredPath, resolved].some(savePath => {
        const relative = path.relative(folder, savePath);
        return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
      })) {
        throw new Error('This backup contains the configured save folder. Choose a different save folder before deleting it.');
      }
    }
  }

  async retryDeletions() {
    const pending = this.readState().pendingBackupDeletions;
    if (!pending?.length) return;
    const root = await this.resolvedRoot();
    const remaining = [];
    for (const item of pending) {
      // If storage was redirected again, wait until the original location is available.
      if (path.relative(root, item.root) || !BACKUP_ID.test(item.id) || this.readState().backups.some(backup => backup.id === item.id)) {
        remaining.push(item);
        continue;
      }
      const parked = parkedBackupPath(path.join(root, item.id));
      try {
        if (await backupDirectoryExists(parked)) {
          await this.protectSaveFolder(parked);
          await fs.rm(parked, { recursive: true, force: true, maxRetries: 3 });
        }
      } catch {
        remaining.push(item);
      }
    }
    if (remaining.length !== pending.length) await this.update(state => { state.pendingBackupDeletions = remaining; });
  }

  async delete(backupId) {
    this.record(backupId);
    const root = await this.resolvedRoot();
    const original = path.join(root, backupId);
    const parked = parkedBackupPath(original);
    await this.protectSaveFolder(original, parked);
    const present = await backupDirectoryExists(original);
    const alreadyParked = await backupDirectoryExists(parked);
    if (present && alreadyParked) throw new Error('Two folders were found for this backup. Resolve the duplicate before deleting it.');
    if (present) await fs.rename(original, parked);
    try {
      await this.update(state => {
        state.backups = state.backups.filter(item => item.id !== backupId);
        if (present || alreadyParked) (state.pendingBackupDeletions ??= []).push({ id: backupId, root });
      });
    } catch (error) {
      if (present) await fs.rename(parked, original);
      throw error;
    }
    await this.retryDeletions().catch(() => {});
    if (this.readState().pendingBackupDeletions?.some(item => item.id === backupId)) {
      return { remaining: parked };
    }
  }

  async restore(backupId) {
    await this.assertClosed();
    const backup = this.record(backupId);
    const folder = await this.folder(backupId);
    const root = this.readState().settings.saves;
    if (!root) throw new Error('Choose the Elden Ring save folder in Settings.');
    const live = new Map((await saveFiles(root)).map(file => [file.toLowerCase(), file]));
    const targets = await Promise.all(backup.files.map(async relative => {
      const source = await assertSaveTarget(folder, relative);
      if (!await exists(source)) throw new Error('A file is missing from this backup.');
      const current = live.get(relative.toLowerCase()) ?? relative;
      return { relative, source, target: await assertSaveTarget(root, current) };
    }));
    const rollback = await this.create('Before restore', this.readState().active, [...live.values()]);
    const rollbackFolder = rollback && await this.folder(rollback.id);
    await this.assertClosed();
    const written = [];
    try {
      for (const { relative, source, target } of targets) {
        const data = await fs.readFile(source);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await atomicWrite(target, data);
        written.push({ relative, target });
      }
    } catch (error) {
      const recoveries = await Promise.allSettled(written.map(async ({ relative, target }) => {
        const original = live.get(relative.toLowerCase());
        if (original) {
          const data = await fs.readFile(path.join(rollbackFolder, original));
          await atomicWrite(target, data);
        } else {
          await fs.rm(target);
        }
      }));
      if (recoveries.some(item => item.status === 'rejected')) throw new Error('Restore was interrupted. A before-restore backup is available.');
      throw error;
    }
    return { preserved: Boolean(rollback) };
  }
}

module.exports = { BackupStorage };
