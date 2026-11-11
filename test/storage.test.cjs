const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Storage } = require('../src/storage.cjs');
const { Manager } = require('../src/manager.cjs');

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ringward-storage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const source = path.join(root, 'old');
  let target = path.join(root, 'new');
  await fs.mkdir(target);
  target = await fs.realpath(target);
  const manager = new Manager(source);
  await manager.init({ saves: path.join(root, 'saves'), game: '', me3: '' });
  const storage = new Storage(source);
  const write = async (relative, value) => {
    const file = path.join(source, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value);
  };
  return { root, source, target, manager, storage, write };
}

test('storage transfer preserves data and rebases managed tool, log, and backup paths', async t => {
  const { source, target, manager, storage, write } = await setup(t);
  await write('library/mod/config.ini', 'mod settings');
  await write('reshade/ReShade.ini', 'TutorialProgress=4');
  await write('reshade/presets/mod/preset.ini', 'saved shader values');
  await write('backups/backup/save.sl2', 'snapshot');
  await write('tools/me3/bin/me3.exe', 'tool');
  await write('nexus-key.bin', Buffer.from([1, 2, 3]));
  await write('window-state.json', '{"maximized":true}');
  await manager.update(state => {
    state.settings.me3 = path.join(source, 'tools', 'me3', 'bin', 'me3.exe');
    state.settings.smithbox = path.join(source, 'tools', 'smithbox');
    state.lastLog = path.join(source, 'runs', 'launch', 'me3.log');
    state.lastVisualLog = path.join(source, 'reshade', 'ReShade.log');
    state.pendingBackupDeletions = [{ id: 'backup', root: path.join(source, 'backups') }];
  });
  const original = await fs.readFile(manager.db, 'utf8');
  let closedChecks = 0;
  await storage.transfer(await storage.prepare(target), async () => { closedChecks++; }, () => {});
  assert.equal(closedChecks, 2);
  assert.equal(await new Storage(source).load(), target);
  assert.equal(await fs.readFile(path.join(target, 'library/mod/config.ini'), 'utf8'), 'mod settings');
  assert.equal(await fs.readFile(path.join(target, 'reshade/ReShade.ini'), 'utf8'), 'TutorialProgress=4');
  assert.equal(await fs.readFile(path.join(target, 'backups/backup/save.sl2'), 'utf8'), 'snapshot');
  assert.deepEqual(await fs.readFile(path.join(target, 'nexus-key.bin')), Buffer.from([1, 2, 3]));
  const moved = JSON.parse(await fs.readFile(path.join(target, 'manager.json'), 'utf8'));
  assert.equal(moved.settings.me3, path.join(target, 'tools', 'me3', 'bin', 'me3.exe'));
  assert.equal(moved.settings.smithbox, path.join(target, 'tools', 'smithbox'));
  assert.equal(moved.lastLog, path.join(target, 'runs', 'launch', 'me3.log'));
  assert.equal(moved.lastVisualLog, path.join(target, 'reshade', 'ReShade.log'));
  assert.equal(moved.pendingBackupDeletions[0].root, path.join(target, 'backups'));
  assert.deepEqual(moved.profiles, manager.state.profiles);
  assert.equal(moved.settings.saves, manager.state.settings.saves);
  assert.equal(await fs.readFile(manager.db, 'utf8'), original);
});

test('interrupted transfers and newly started games keep the original location active', async t => {
  const { root, target, storage, write } = await setup(t);
  await write('library/mod/file.bin', 'asset');
  const plan = await storage.prepare(target);
  let closedChecks = 0;
  await assert.rejects(storage.transfer(plan, async () => {
    if (++closedChecks === 2) throw new Error('Game started');
  }, () => {}), /Game started/);
  assert.equal(await new Storage(storage.defaultRoot).load(), storage.defaultRoot);
  assert.deepEqual(await fs.readdir(target), []);
  assert.equal((await fs.readdir(root)).some(name => name.startsWith('.ringward-transfer-')), false);
});

test('a failed location switch leaves the original and the verified destination intact', async t => {
  const { source, target, storage, write } = await setup(t);
  await write('library/file.bin', 'asset');
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === storage.pointer) throw new Error('Pointer is read-only');
    return rename(from, to);
  });
  await assert.rejects(storage.transfer(await storage.prepare(target), async () => {}, () => {}), /original storage is still active/);
  assert.equal(await new Storage(source).load(), source);
  assert.equal(await fs.readFile(path.join(target, 'library/file.bin'), 'utf8'), 'asset');
  assert.equal(await fs.readFile(path.join(source, 'library/file.bin'), 'utf8'), 'asset');
});

test('storage rejects nested folders, game folders, nonempty targets, and redirected contents', async t => {
  const { source, target, storage, write } = await setup(t);
  await fs.mkdir(path.join(source, 'nested'));
  await assert.rejects(storage.prepare(path.join(source, 'nested')), /separate folder/);
  await assert.rejects(storage.prepare(target, [target]), /dedicated data folder/);
  await fs.writeFile(path.join(target, 'existing.txt'), 'do not overwrite');
  await assert.rejects(storage.prepare(target), /empty folder/);
  await fs.unlink(path.join(target, 'existing.txt'));
  await write('library/mod.txt', 'asset');
  await fs.symlink(target, path.join(source, 'library', 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(storage.prepare(target), /redirected/);
});

test('unavailable custom storage is not replaced with an empty library and can be relocated', async t => {
  const { root, source, target, manager, storage } = await setup(t);
  await manager.update(state => { state.settings.me3 = path.join(source, 'tools', 'me3.exe'); });
  await storage.transfer(await storage.prepare(target), async () => {}, () => {});
  let renamed = path.join(root, 'relocated');
  await fs.rename(target, renamed);
  renamed = await fs.realpath(renamed);
  const reopened = new Storage(source);
  await assert.rejects(reopened.load(), { code: 'ENOENT' });
  await assert.rejects(fs.access(target), { code: 'ENOENT' });
  await reopened.useExisting(renamed);
  assert.equal(await new Storage(source).load(), renamed);
  const state = JSON.parse(await fs.readFile(path.join(renamed, 'manager.json'), 'utf8'));
  assert.equal(state.settings.me3, path.join(renamed, 'tools', 'me3.exe'));
});

test('startup removes only a marked incomplete transfer and preserves unrelated folders', async t => {
  const { root, source, target, storage } = await setup(t);
  const parentAlias = path.join(root, 'transfer-parent');
  await fs.symlink(root, parentAlias, process.platform === 'win32' ? 'junction' : 'dir');
  const stage = await fs.mkdtemp(path.join(parentAlias, '.ringward-transfer-'));
  const record = { stage, target, token: 'owned-transfer' };
  await fs.writeFile(path.join(stage, '.ringward-transfer.json'), JSON.stringify(record));
  await fs.writeFile(path.join(stage, 'partial.bin'), 'incomplete');
  await fs.writeFile(storage.journal, JSON.stringify(record));
  assert.equal(await storage.load(), source);
  await assert.rejects(fs.access(stage), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(target), []);

  const unrelated = path.join(root, 'unrelated');
  await fs.mkdir(unrelated);
  await fs.writeFile(path.join(unrelated, 'keep.txt'), 'preserved');
  await fs.writeFile(storage.journal, JSON.stringify({ ...record, stage: unrelated }));
  assert.equal(await storage.load(), source);
  assert.equal(await fs.readFile(path.join(unrelated, 'keep.txt'), 'utf8'), 'preserved');
});

test('managed paths are rebased when the source was opened through a path alias', async t => {
  const { root, source, target, manager } = await setup(t);
  const alias = path.join(root, 'alias');
  await fs.symlink(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await manager.update(state => { state.settings.me3 = path.join(alias, 'tools', 'me3.exe'); });
  const storage = new Storage(alias);
  await storage.transfer(await storage.prepare(target), async () => {}, () => {});
  const state = JSON.parse(await fs.readFile(path.join(target, 'manager.json'), 'utf8'));
  assert.equal(state.settings.me3, path.join(target, 'tools', 'me3.exe'));
});
