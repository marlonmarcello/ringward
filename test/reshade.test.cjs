const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Manager, me3Profile } = require('../src/manager.cjs');
const { DLL, PACKS, RUNTIME, recoverLegacyConfig, stagePreset } = require('../src/reshade.cjs');

test('ReShade and the immutable Vanilla gameplay profile are independently selectable', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ringward-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manager = new Manager(path.join(root, 'data'));
  manager.assertClosed = async () => {};
  await manager.init({ game: '', me3: '', saves: '' });

  const source = path.join(root, 'pack');
  await fs.mkdir(path.join(source, 'reshade-shaders', 'Shaders'), { recursive: true });
  await fs.writeFile(path.join(source, 'Look.ini'), 'Techniques=Look@Look.fx\nTechniqueSorting=Inactive@Other.fx\n');
  await fs.writeFile(path.join(source, 'reshade-shaders', 'Shaders', 'Look.fx'), 'technique Look {}');
  await fs.writeFile(path.join(source, 'dxgi.dll'), 'bundled binary');
  const gameplay = manager.state.active;
  assert.equal((await manager.importMod(source, gameplay, {}, true)).reshadePreset, true);
  const [mod] = manager.state.mods;
  assert.deepEqual(mod.natives, []);
  assert.deepEqual(manager.profile(manager.state, gameplay).mods, []);
  assert.deepEqual(mod.reshadePresets, [{ file: 'Look.ini', effects: ['Look.fx'] }]);

  const stage = path.join(root, 'stage');
  const options = {
    target: stage, base: path.join(root, 'reshade'), modRoot: manager.modRoot(mod.id),
    files: mod.files, presetFile: 'Look.ini', toolsRoot: manager.at('tools')
  };
  await stagePreset(options);
  assert.deepEqual(await fs.readdir(path.join(stage, 'Shaders')), ['Look.fx']);
  await assert.rejects(stagePreset({ ...options, files: [] }), /Missing ReShade effects: Look.fx/);

  await manager.selectVisual(mod.id, 'Look.ini');
  await manager.editProfile({ action: 'select', id: 'vanilla' });
  assert.equal(manager.snapshot().visual.id, mod.id);
  await assert.rejects(manager.profileMod({ action: 'add', profile: 'vanilla', modId: mod.id }), /cannot contain gameplay mods/);
  await assert.rejects(manager.editProfile({ action: 'remove', id: 'vanilla' }), /built-in/);
  const profile = me3Profile(manager.profile(manager.state, 'vanilla'), null, [], manager.reshadeDll());
  assert.match(profile, /ReShade64\.dll"\nload_early = true/);
  assert.doesNotMatch(profile, /\[\[packages\]\]|savefile/);

  await manager.editProfile({ action: 'select', id: gameplay });
  await manager.selectVisual(null);
  assert.equal(manager.state.active, gameplay);
  assert.equal(manager.snapshot().visual, null);
  await manager.selectVisual(mod.id, 'Look.ini');
  await manager.editProfile({ action: 'remove', id: gameplay });
  assert.equal(manager.state.active, 'vanilla');
  assert.deepEqual(manager.snapshot().profiles.map(profile => profile.id), ['vanilla']);
  assert.equal(manager.snapshot().visual.id, mod.id);
  await manager.editProfile({ action: 'create', id: 'vanilla', name: 'Another loadout' });
  assert.notEqual(manager.state.active, 'vanilla');
});

test('ReShade keeps tutorial progress and edits to each preset across launches', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ringward-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = path.join(root, 'reshade');
  const runs = path.join(root, 'runs');
  const legacy = path.join(runs, 'launch-old', 'reshade');
  const legacyLog = path.join(legacy, 'ReShade.log');
  const modRoot = path.join(root, 'mod');
  await fs.mkdir(legacy, { recursive: true });
  await fs.mkdir(modRoot);
  await fs.writeFile(path.join(legacy, 'ReShade.ini'), '[GENERAL]\nPresetPath=./Preset.ini\n\n[OVERLAY]\nTutorialProgress=4\n');
  const firstPreset = 'Techniques=\n[Look.fx]\nValue=1\n';
  await fs.writeFile(path.join(modRoot, 'First.ini'), firstPreset);
  await fs.writeFile(path.join(modRoot, 'Second.ini'), 'Techniques=\n[Look.fx]\nValue=3\n');
  await recoverLegacyConfig(base, runs, legacyLog);

  const config = path.join(base, 'ReShade.ini');
  const options = { base, modRoot, files: ['First.ini', 'Second.ini'], toolsRoot: path.join(root, 'tools') };
  const run = (id, presetFile) => stagePreset({ ...options, target: path.join(runs, id), presetFile });
  const activePreset = async () => path.join(base, (await fs.readFile(config, 'utf8')).match(/^StartupPresetPath=(.+)$/m)[1]);
  await run('launch-one', 'First.ini');
  const firstCopy = await activePreset();
  assert.equal(await fs.readFile(firstCopy, 'utf8'), firstPreset);
  await fs.writeFile(firstCopy, firstPreset.replace('Value=1', 'Value=2'));
  await fs.appendFile(config, '[INPUT]\nKeyOverlay=35,0,0,0\n');

  await run('launch-two', 'Second.ini');
  assert.notEqual(await activePreset(), firstCopy);
  await run('launch-three', 'First.ini');
  assert.equal(await activePreset(), firstCopy);
  assert.match(await fs.readFile(firstCopy, 'utf8'), /Value=2/);
  assert.equal(await fs.readFile(path.join(modRoot, 'First.ini'), 'utf8'), firstPreset);

  await recoverLegacyConfig(base, runs, legacyLog);
  const settings = await fs.readFile(config, 'utf8');
  assert.match(settings, /\[OVERLAY\]\nTutorialProgress=4/);
  assert.match(settings, /\[INPUT\]\nKeyOverlay=35,0,0,0/);
  assert.match(settings, /^EffectSearchPaths=\.\.\/runs\/launch-three\/Shaders\/\*\*$/m);
  assert.doesNotMatch(settings, /launch-one|PresetPath=\.\/Preset\.ini/);
});

test('uninstall removes only the managed ReShade installation and clears the active preset', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ringward-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manager = new Manager(root);
  manager.assertClosed = async () => {};
  await manager.init({ game: '', me3: '', saves: '' });
  const gameplay = manager.state.active;
  const preset = path.join(root, 'Look.ini');
  await fs.writeFile(preset, 'Techniques=Look@Look.fx\n');
  await manager.importMod(preset, gameplay);
  const [mod] = manager.state.mods;
  await manager.selectVisual(mod.id, mod.reshadePresets[0].file);

  const tools = manager.at('tools');
  await fs.mkdir(path.join(tools, RUNTIME.folder));
  await fs.writeFile(path.join(tools, RUNTIME.folder, DLL), 'installed runtime');
  await fs.writeFile(path.join(tools, 'another-tool.txt'), 'keep');
  assert.equal((await manager.toolStatus()).reshadeInstalled, true);
  assert.equal((await manager.toolStatus()).reshade, false);
  for (const pack of PACKS) await fs.mkdir(path.join(tools, pack.folder, pack.subfolder, 'Shaders'), { recursive: true });
  assert.equal((await manager.toolStatus()).reshade, true);

  await manager.uninstallReShade();
  assert.equal((await manager.toolStatus()).reshadeInstalled, false);
  assert.equal(manager.snapshot().visual, null);
  assert.equal(manager.state.active, gameplay);
  assert.equal(manager.state.mods[0].id, mod.id);
  await fs.access(path.join(manager.modRoot(mod.id), mod.reshadePresets[0].file));
  assert.deepEqual(await fs.readdir(tools), ['another-tool.txt']);
  await manager.uninstallReShade();
});
