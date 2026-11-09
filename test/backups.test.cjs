const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Manager } = require('../src/manager.cjs');

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
  const backup = await manager.makeBackup('Before Favorites edit', null, [stock]);
  await writeSave(saves, stock, 'current');
  await writeSave(saves, other, 'other account');

  assert.equal(await manager.mainSaveFolder(), path.dirname(path.join(saves, stock)));
  assert.deepEqual(await manager.restore(backup.id), { preserved: true });
  const [beforeRestore] = manager.snapshot().backups;
  assert.equal(beforeRestore.reason, 'Before restore');
  assert.equal(beforeRestore.count, 2);
  const preserved = await manager.backupFolder(beforeRestore.id);
  assert.equal(await fs.readFile(path.join(preserved, stock), 'utf8'), 'current');
  assert.equal(await fs.readFile(path.join(preserved, other), 'utf8'), 'other account');
  assert.equal(await fs.readFile(path.join(saves, stock), 'utf8'), 'older');
  assert.equal(await fs.readFile(path.join(saves, other), 'utf8'), 'other account');

  await writeSave(saves, '76561198000000002/ER0000.sl2', 'another main save');
  assert.equal(await manager.mainSaveFolder(), saves);
});

test('renaming and deleting a backup leaves live saves intact', async t => {
  const { manager, saves } = await setup(t);
  const relative = '76561198000000001/ER0000.sl2';
  await writeSave(saves, relative, 'live');
  const backup = await manager.makeBackup('Manual', manager.state.active);
  const folder = await manager.backupFolder(backup.id);
  await assert.rejects(manager.renameBackup(backup.id, '  '), /Enter a backup name/);
  await manager.renameBackup(backup.id, ' Before the DLC ');
  assert.equal(manager.snapshot().backups[0].name, 'Before the DLC');
  assert.equal(await manager.backupFolder(backup.id), folder);

  const commit = manager.commit;
  manager.commit = async () => { throw new Error('Cannot write backup index'); };
  await assert.rejects(manager.deleteBackup(backup.id), /Cannot write backup index/);
  manager.commit = commit;
  assert.equal(await fs.readFile(path.join(folder, relative), 'utf8'), 'live');
  assert.equal(manager.snapshot().backups.length, 1);

  // Simulate a process exit after parking the backup but before deleting the record.
  await fs.rename(folder, folder + '.deleting');
  assert.equal(await manager.backupFolder(backup.id), folder + '.deleting');
  await manager.deleteBackup(backup.id);
  assert.deepEqual(manager.snapshot().backups, []);
  await assert.rejects(fs.access(folder + '.deleting'), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(saves, relative), 'utf8'), 'live');
});
