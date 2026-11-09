const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Manager } = require('../src/manager.cjs');

test('absolute load-order positions and asset winners use the full profile order', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ringward-loadout-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manager = new Manager(path.join(root, 'data'));
  await manager.init({ game: '', me3: '', saves: '' });
  const profile = manager.state.active;
  for (const name of ['First', 'Disabled', 'Last']) {
    const source = path.join(root, name);
    await fs.mkdir(path.join(source, 'parts'), { recursive: true });
    await fs.writeFile(path.join(source, 'parts', 'Armor.partsbnd.dcx'), name);
    await manager.importMod(source, profile, {}, true);
  }
  const [first, disabled, last] = manager.state.mods.map(item => item.id);
  await manager.profileMod({ action: 'toggle', profile, modId: disabled, enabled: false });

  const plan = () => manager.plan(profile);
  const move = (modId, position) => manager.profileMod({ action: 'position', profile, modId, position });
  assert.deepEqual(plan().report.conflicts, [['parts/Armor.partsbnd.dcx', [
    { name: 'First', position: 1 }, { name: 'Last', position: 3 }
  ]]]);
  await assert.rejects(move(first, 0), /position from 1 to 3/);
  await assert.rejects(move(first, 1.5), /position from 1 to 3/);
  await assert.rejects(move(first, 4), /position from 1 to 3/);
  await move(first, 3);
  assert.deepEqual(plan().profile.mods.map(item => item.id), [disabled, last, first]);
  assert.deepEqual(plan().report.conflicts[0][1], [{ name: 'Last', position: 2 }, { name: 'First', position: 3 }]);
  assert.equal(plan().winners.get('parts/armor.partsbnd.dcx').id, first);
  await move(first, 1);
  assert.deepEqual(plan().profile.mods.map(item => item.id), [first, disabled, last]);
  assert.equal(plan().winners.get('parts/armor.partsbnd.dcx').id, last);
});
