const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Manager } = require('../src/manager.cjs');

test('startup logo preferences are passed only to ME3', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ringward-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const gameDir = path.join(root, 'game');
  await fs.mkdir(gameDir);
  const game = path.join(gameDir, 'eldenring.exe');
  const argsFile = path.join(gameDir, 'args.json');
  await fs.writeFile(game, '');
  // Use Node as a stand-in for ME3 to record the actual launch arguments.
  await fs.writeFile(path.join(gameDir, 'launch'),
    'require("node:fs").writeFileSync("args.json", JSON.stringify(process.argv.slice(2)));');

  const manager = new Manager(path.join(root, 'data'));
  manager.assertClosed = async () => {};
  await manager.init({ game, me3: process.execPath, saves: '' });
  const profile = manager.state.active;
  for (const [setting, expected] of [[null, undefined], [true, '--show-logos=false'], [false, '--show-logos=true']]) {
    await manager.setSkipLogos(setting);
    const ended = new Promise(resolve => { manager.onLaunchEnd = resolve; });
    assert.deepEqual(await manager.launch(profile), { launched: true });
    assert.equal(await ended, 0);
    const args = JSON.parse(await fs.readFile(argsFile, 'utf8'));
    assert.equal(args.find(arg => arg.startsWith('--show-logos=')), expected);
  }

  await manager.setSkipLogos(true);
  await fs.unlink(argsFile);
  await manager.editProfile({ action: 'select', id: 'vanilla' });
  assert.deepEqual(await manager.launch('vanilla'), { vanilla: true });
  await assert.rejects(fs.access(argsFile), { code: 'ENOENT' });
});
