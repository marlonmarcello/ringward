const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Manager } = require('../src/manager.cjs');

const directoryLink = process.platform === 'win32' ? 'junction' : 'dir';
const mainSave = '76561198000000001/ER0000.sl2';

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ringward-backups-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const saves = path.join(root, 'saves');
  const manager = new Manager(path.join(root, 'data'));
  manager.assertClosed = async () => {};
  await manager.init({ game: '', me3: '', saves });
  return { manager, saves };
}

async function writeSave(root, relative, content) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

test('restoring a partial backup preserves every current save in a separate snapshot', async t => {
  const { manager, saves } = await setup(t);
  const stock = '76561198000000001/ER0000.sl2';
  const other = '76561198000000002/Offline.co2';
  await writeSave(saves, stock, 'older');
  assert.equal(await manager.backups.mainSaveFolder(), path.dirname(path.join(saves, stock)));
  const backup = await manager.backups.create('Before Favorites edit', null, [stock]);
  await writeSave(saves, stock, 'current');
  await writeSave(saves, other, 'other account');

  assert.equal(await manager.backups.mainSaveFolder(), saves);
  assert.deepEqual(await manager.backups.restore(backup.id), { preserved: true });
  const [beforeRestore] = manager.snapshot().backups;
  assert.equal(beforeRestore.reason, 'Before restore');
  assert.equal(beforeRestore.count, 2);
  const preserved = await manager.backups.folder(beforeRestore.id);
  assert.equal(await fs.readFile(path.join(preserved, stock), 'utf8'), 'current');
  assert.equal(await fs.readFile(path.join(preserved, other), 'utf8'), 'other account');
  assert.equal(await fs.readFile(path.join(saves, stock), 'utf8'), 'older');
  assert.equal(await fs.readFile(path.join(saves, other), 'utf8'), 'other account');

  await writeSave(saves, '76561198000000002/ER0000.sl2', 'another main save');
  assert.equal(await manager.backups.mainSaveFolder(), saves);
});

test('renaming and deleting a backup leaves live saves intact', async t => {
  const { manager, saves } = await setup(t);
  const relative = '76561198000000001/ER0000.sl2';
  await writeSave(saves, relative, 'live');
  const backup = await manager.backups.create('Manual', manager.state.active);
  const folder = await manager.backups.folder(backup.id);
  await assert.rejects(manager.backups.rename(backup.id, '  '), /Enter a backup name/);
  await manager.backups.rename(backup.id, ' Before the DLC ');
  assert.equal(manager.snapshot().backups[0].name, 'Before the DLC');
  assert.equal(await manager.backups.folder(backup.id), folder);

  const commit = manager.commit;
  manager.commit = async () => { throw new Error('Cannot write backup index'); };
  await assert.rejects(manager.backups.delete(backup.id), /Cannot write backup index/);
  manager.commit = commit;
  assert.equal(await fs.readFile(path.join(folder, relative), 'utf8'), 'live');
  assert.equal(manager.snapshot().backups.length, 1);

  // Simulate a process exit after parking the backup but before deleting the record.
  await fs.rename(folder, folder + '.deleting');
  assert.equal(await manager.backups.folder(backup.id), folder + '.deleting');
  await manager.backups.delete(backup.id);
  assert.deepEqual(manager.snapshot().backups, []);
  await assert.rejects(fs.access(folder + '.deleting'), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(saves, relative), 'utf8'), 'live');
});

test('deletion protects a backup that contains the configured save folder', async t => {
  const { manager, saves } = await setup(t);
  await writeSave(saves, mainSave, 'protected');
  const backup = await manager.backups.create('Manual', manager.state.active);
  const folder = await manager.backups.folder(backup.id);
  const alias = path.join(path.dirname(saves), 'save-alias');
  await fs.symlink(folder, alias, directoryLink);

  for (const target of [folder, path.dirname(path.join(folder, mainSave)), alias]) {
    await manager.setSetting('saves', target);
    await assert.rejects(manager.backups.delete(backup.id), /contains the configured save folder/);
    assert.equal(await fs.readFile(path.join(folder, mainSave), 'utf8'), 'protected');
    assert.equal(manager.snapshot().backups.length, 1);
  }
});

test('startup retries a delete that could not finish after the index was committed', async t => {
  const { manager, saves } = await setup(t);
  await writeSave(saves, mainSave, 'live');
  const backup = await manager.backups.create('Manual', manager.state.active);
  const parked = (await manager.backups.folder(backup.id)) + '.deleting';
  const remove = fs.rm;
  const locked = t.mock.method(fs, 'rm', (file, options) => {
    if (file === parked) throw new Error('Windows still has the folder open');
    return remove(file, options);
  });
  assert.deepEqual(await manager.backups.delete(backup.id), { remaining: parked });
  locked.mock.restore();
  assert.deepEqual(manager.snapshot().backups, []);

  // The cleanup must respect a save folder selected after the initial delete attempt.
  await manager.setSetting('saves', parked);
  const reopened = new Manager(manager.root);
  await reopened.init({});
  assert.equal(await fs.readFile(path.join(parked, mainSave), 'utf8'), 'live');
  await reopened.setSetting('saves', saves);
  await reopened.init({});
  await assert.rejects(fs.access(parked), { code: 'ENOENT' });
  assert.deepEqual(reopened.state.pendingBackupDeletions, []);
  assert.equal(await fs.readFile(path.join(saves, mainSave), 'utf8'), 'live');
});

test('redirected backup storage supports existing snapshots and new backups', async t => {
  const { manager, saves } = await setup(t);
  await writeSave(saves, mainSave, 'older');
  const first = await manager.backups.create('Manual', manager.state.active);
  const storage = manager.at('backups');
  const redirected = path.join(path.dirname(saves), 'redirected');
  await fs.rename(storage, redirected);
  await fs.symlink(redirected, storage, directoryLink);

  const folder = path.join(await fs.realpath(redirected), first.id);
  assert.equal(await manager.backups.folder(first.id), folder);
  await writeSave(saves, mainSave, 'current');
  assert.deepEqual(await manager.backups.restore(first.id), { preserved: true });
  assert.equal(await fs.readFile(path.join(saves, mainSave), 'utf8'), 'older');
  const preserved = await manager.backups.folder(manager.snapshot().backups[0].id);
  assert.equal(await fs.readFile(path.join(preserved, mainSave), 'utf8'), 'current');
  await manager.backups.delete(first.id);
  await assert.rejects(fs.access(folder), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(preserved, mainSave), 'utf8'), 'current');
});
