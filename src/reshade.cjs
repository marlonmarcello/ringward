const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { createHash } = require('node:crypto');
const { extractZip } = require('./archive.cjs');
const { atomicWrite } = require('./platform.cjs');

const VERSION = '6.8.0';
const INI = /\.ini$/i;
const INI_LIMIT = 1024 ** 2;
const LIMIT = 64 * 1024 ** 2;
const DLL = 'ReShade64.dll';
const DLL_HASH = 'b2945c29e7095491a901746b400e58db9b1592ab092bacf2a888ce37f02d08da';
const RUNTIME = {
  name: 'ReShade ' + VERSION,
  folder: 'ReShade-' + VERSION,
  limit: 8 * 1024 ** 2,
  url: 'https://reshade.me/downloads/ReShade_Setup_' + VERSION + '.exe',
  hash: '207aea16205fbf952bc8fe1879966672454cf04002e7ad34237c7990a5b3c0b4'
};

// The official setup's effect catalog lists these projects. The older PD80
// revision includes the Bonus LUT effect referenced by existing presets.
const PACKS = [
  ['Standard effects', 'crosire/reshade-shaders', 'fd0022170615ce0d8162d219bff07232fa6dd84f', 'a3b110ba5118f3b944d74f0b0746c21280071d389ed98d615bf3c4b3a1778586'],
  ['SweetFX', 'CeeJayDK/SweetFX', '93ddf39b357f5da534ed6d34ba4ec8cc7dcfa361', 'e1e1d6515d29c65fcf115c9692a1c5f91ffb8d9734e6871bcf67ac48588dbbce'],
  ['FXShaders', 'luluco250/FXShaders', '76365e35c48e30170985ca371e67d8daf8eb9a98', 'f8abdb10c4239ab0a3f90863da05229f9d0939b717e450c813fab81e6983a4fa'],
  ['brussell1 shaders', 'brussell1/Shaders', '3869218ea004d4d7d5c596fbb6179e2d38c0cc55', '0c148bd0acb8b4db1c5c785ca70b7e024dcb1d615e4ed7cc9efd431ca408e6a3'],
  ['fubax shaders', 'Fubaxiusz/fubax-shaders', 'd902cc2e8216f10801019b02b09f7bd55449fd79', '578473bc1266ac4d498313ea39e611e4d9405bf29b8e2393e7f381d53046607d'],
  ['qUINT', 'martymcmodding/qUINT', '98fed77b26669202027f575a6d8f590426c21ebd', '2f6ff2f5dd39ff400c07ecbbfd1156604459f44d9028d07fa6d98b84d4cfbfa9'],
  ['prod80 shaders', 'prod80/prod80-ReShade-Repository', '4c97c51bf6f7c2c042af6713feb317e8eb293169', 'dce7d85b84d9a40db9d60a17a2e2d716988af441db76397bdceecf31057c3be8']
].map(([name, repo, commit, hash]) => ({
  name, folder: 'ReShade-effects-' + commit.slice(0, 12), limit: LIMIT, hash,
  url: 'https://codeload.github.com/' + repo + '/zip/' + commit,
  subfolder: repo.split('/')[1] + '-' + commit
}));

async function unpackRuntime(file, target) {
  // ReShade Setup carries a ZIP starting at a 512-byte boundary in the EXE.
  const bytes = await fs.readFile(file);
  for (let offset = 0; offset + 30 < bytes.length; offset += 512) {
    if (bytes.readUInt32LE(offset) !== 0x04034b50 || !bytes.subarray(offset + 4, offset + 30).some(Boolean)) continue;
    // Authenticode data follows the ZIP. Trim it before passing the ZIP to yauzl.
    const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (end < offset || end + 22 > bytes.length) break;
    const zipEnd = end + 22 + bytes.readUInt16LE(end + 20);
    if (zipEnd > bytes.length || offset + bytes.readUInt32LE(end + 16) + bytes.readUInt32LE(end + 12) !== end) break;
    const zip = path.join(path.dirname(file), 'reshade.zip');
    await fs.writeFile(zip, bytes.subarray(offset, zipEnd));
    await extractZip(zip, target, LIMIT);
    return;
  }
  throw new Error('The ReShade installer is missing its runtime archive.');
}

async function readPreset(file) {
  if ((await fs.stat(file)).size > INI_LIMIT) return null;
  const bytes = await fs.readFile(file);
  const text = bytes[0] === 0xff && bytes[1] === 0xfe
    ? bytes.toString('utf16le').slice(1) : bytes.toString('utf8').replace(/^\uFEFF/, '');
  const top = text.split(/^\s*\[/m, 1)[0];
  const techniques = top.match(/^[\t ]*Techniques[\t ]*=([^\r\n]*)/im);
  if (!techniques) return null;
  const effects = new Map();
  for (const technique of techniques[1].split(',')) {
    const name = technique.trim().match(/@([^@\\/:*?"<>|]+\.fx)$/i)?.[1];
    if (name) effects.set(name.toLowerCase(), name);
  }
  return { text, effects: [...effects.values()] };
}

async function inspectPresets(folder, files) {
  const presets = [];
  for (const file of files.filter(file => INI.test(file) && !file.startsWith('__MACOSX/'))) {
    const preset = await readPreset(path.join(folder, file));
    if (preset) presets.push({ file, effects: preset.effects });
  }
  return presets;
}

function bundledFiles(files, presetFile) {
  const presetDir = path.posix.dirname(presetFile);
  const prefix = presetDir === '.' ? '' : presetDir + '/';
  const result = new Map();
  for (const file of files) {
    if (!file.startsWith(prefix) || file.startsWith('__MACOSX/')) continue;
    const parts = file.slice(prefix.length).split('/');
    const top = parts.findIndex(part => /^(shaders|textures)$/i.test(part));
    const name = parts.at(-1);
    const shader = /\.fxh?$/i.test(name);
    const texture = /\.(bmp|dds|gif|hdr|jpeg|jpg|png|tga|tif|tiff|webp)$/i.test(name);
    if (!shader && !(texture && top >= 0 && /^textures$/i.test(parts[top]))) continue;
    const relative = shader && top < 0 ? name : parts.slice(top + 1).join('/');
    if (!relative) continue;
    const dest = (shader ? 'Shaders/' : 'Textures/') + relative;
    if (!result.has(dest.toLowerCase())) result.set(dest.toLowerCase(), { file, dest });
  }
  return [...result.values()];
}

async function collectEffects(root) {
  const effects = new Set();
  for (const entry of await fs.readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && /\.fx$/i.test(entry.name)) effects.add(entry.name.toLowerCase());
  }
  return effects;
}

function ignoreMissing(error) {
  if (error.code !== 'ENOENT') throw error;
}

async function recoverLegacyConfig(base, runs, log) {
  if (!log || !/^launch-[^\\/]+[\\/]reshade[\\/]ReShade\.log$/i.test(path.relative(runs, log))) return;
  await fs.mkdir(base, { recursive: true });
  await fs.copyFile(path.join(path.dirname(log), 'ReShade.ini'), path.join(base, 'ReShade.ini'), constants.COPYFILE_EXCL).catch(error => {
    if (error.code !== 'EEXIST') ignoreMissing(error);
  });
}

function setIniSection(text, section, required, defaults = {}) {
  const blocks = text.split(/(?=^[\t ]*\[)/m);
  const header = '[' + section + ']';
  const index = blocks.findIndex(block => block.split(/\r?\n/, 1)[0].trim() === header);
  const lines = index === -1 ? [] : blocks[index].trimEnd().split(/\r?\n/).slice(1);
  const entries = new Map(Object.entries(defaults));
  const kept = lines.filter(line => {
    const key = line.split('=', 1)[0].trim();
    entries.delete(key);
    return !Object.hasOwn(required, key);
  });
  const added = [...Object.entries(required), ...entries].map(([key, value]) => key + '=' + value);
  const block = [header, ...added, ...kept, '', ''].join('\n');
  if (index === -1) return text.trimEnd() ? text.trimEnd() + '\n\n' + block : block;
  blocks[index] = block;
  return blocks.join('');
}

async function stagePreset({ target, base, modRoot, files, presetFile, toolsRoot }) {
  const key = createHash('sha256').update(presetFile).digest('hex');
  const working = path.join(base, 'presets', path.basename(modRoot), key + '.ini');
  const saved = await readPreset(working).catch(ignoreMissing);
  const preset = saved === undefined ? await readPreset(path.join(modRoot, presetFile)) : saved;
  if (!preset) throw new Error('The selected file is no longer a ReShade preset.');
  const bundled = bundledFiles(files, presetFile);
  const effects = new Set(bundled.map(({ dest }) => path.posix.basename(dest).toLowerCase()));
  const search = { Shaders: [path.join(target, 'Shaders')], Textures: [path.join(target, 'Textures')] };
  for (const pack of PACKS) {
    for (const kind of Object.keys(search)) {
      const folder = path.join(toolsRoot, pack.folder, pack.subfolder, kind);
      const info = await fs.stat(folder).catch(ignoreMissing);
      if (!info?.isDirectory()) continue;
      search[kind].push(folder);
      if (kind === 'Shaders') for (const effect of await collectEffects(folder)) effects.add(effect);
    }
  }
  const missing = preset.effects.filter(effect => !effects.has(effect.toLowerCase()));
  if (missing.length) throw new Error('Missing ReShade effects: ' + missing.join(', ') +
    '. Import a preset pack with these shader files in its Shaders folder.');
  const directories = [search.Shaders[0], search.Textures[0], path.join(base, 'cache'), path.dirname(working)];
  await Promise.all(directories.map(dir => fs.mkdir(dir, { recursive: true })));
  for (const { file, dest } of bundled) {
    const output = path.join(target, dest);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.copyFile(path.join(modRoot, file), output);
  }
  if (saved === undefined) await atomicWrite(working, preset.text);

  const relativePath = file => {
    const relative = path.relative(base, file).replaceAll('\\', '/').replaceAll(',', ',,');
    return relative.startsWith('../') ? relative : './' + relative;
  };
  const searchPaths = folders => folders.map(folder => relativePath(folder) + '/**').join(',');
  const configPath = path.join(base, 'ReShade.ini');
  const existing = await fs.readFile(configPath, 'utf8').catch(ignoreMissing) ?? '';
  const general = setIniSection(existing.replace(/^\uFEFF/, ''), 'GENERAL', {
    PresetPath: relativePath(working),
    StartupPresetPath: relativePath(working),
    EffectSearchPaths: searchPaths(search.Shaders),
    TextureSearchPaths: searchPaths(search.Textures)
  }, { SkipLoadingDisabledEffects: '1', IntermediateCachePath: './cache' });
  await atomicWrite(configPath, setIniSection(general, 'SCREENSHOT', {}, { SavePath: './' }));
}

async function assertNoExternalHooks(game, reshadeEnabled = false) {
  const names = await fs.readdir(path.dirname(game));
  const foreign = names.filter(name =>
    /^(?:dxgi|d3d9|d3d10|d3d11|d3d12|dinput8?|opengl32|winmm|version|reshade(?:32|64)?)\.dll$/i.test(name) ||
    (reshadeEnabled && /^reshade\.ini$/i.test(name)));
  if (foreign.length) throw new Error('Move these files out of the Elden Ring Game folder before continuing: ' +
    foreign.join(', ') + '. They were installed outside Ringward.');
}

module.exports = {
  VERSION, RUNTIME, DLL, DLL_HASH, PACKS, INI, INI_LIMIT,
  unpackRuntime, inspectPresets, recoverLegacyConfig, stagePreset, assertNoExternalHooks
};
