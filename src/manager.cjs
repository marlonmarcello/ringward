const fs = require('node:fs/promises');
const path = require('node:path');
const { createReadStream, createWriteStream } = require('node:fs');
const { randomUUID, createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { TextDecoder } = require('node:util');
const {
  extractZip, extractModArchive, importFolder, inspectFiles, packageFiles,
  findSliderSheets, isSliderImage, ARCHIVE_LIMIT, MOD_ARCHIVE, CSV_PATCH
} = require('./archive.cjs');
const { exists, atomicWrite, run, gameRunning, saveFiles, assertSaveTarget } = require('./platform.cjs');
const {
  PRESET_FILE, PRESET_LIMIT, readAppearancePreset, readPcSave,
  appearanceKey, listFavorites, addFavorite, removeFavorite
} = require('./appearance.cjs');
const nexus = require('./nexus.cjs');
const reshade = require('./reshade.cjs');

const SMITHBOX = {
  name: 'Smithbox 2.2.6',
  folder: 'Smithbox-2.2.6',
  limit: 512 * 1024 ** 2,
  url: 'https://github.com/vawser/Smithbox/releases/download/2.2.6/Smithbox_2_2_6_2026_09_20_b.zip',
  hash: '9a147c319dccad4b6dd2a5adcc6f2ba3a5c11c40b079520c05260cb19994b3d7'
};
const ME3 = {
  name: 'ME3 0.13.0',
  folder: 'ME3-0.13.0',
  limit: 32 * 1024 ** 2,
  url: 'https://github.com/garyttierney/me3/releases/download/v0.13.0/me3-windows-amd64.zip',
  hash: 'a8b693c574106f20532ab1e8b58b2452f37370679b938a884fe75f87f9b68c2b'
};
const id = () => randomUUID();
const cleanName = (value, fallback = '') => String(value || fallback).trim().slice(0, 120) || fallback;
const saveName = profile => 'Ringward-' + profile.id + '.sl2';
const newProfile = name => ({ id: id(), name, mods: [], isolated: true, autoBackup: true, diagnostics: false });
const VANILLA = 'vanilla';
const vanillaProfile = () => ({ id: VANILLA, name: 'Vanilla', mods: [], isolated: false, autoBackup: false, diagnostics: false, immutable: true });
const assetPath = (root, file) => path.join(root, ...file.split('/'));
const stamp = () => new Date().toISOString();

function modEntry(mod) {
  const root = mod.suggested ?? (mod.candidates.length === 1 ? mod.candidates[0] : null);
  const csv = mod.csvs?.length === 1 && mod.candidates.length <= 1 &&
    (root === null || path.posix.dirname(mod.csvs[0]) === (root || '.')) &&
    !packageFiles(mod, root).some(({ rel }) => rel.toLowerCase() === 'regulation.bin')
    ? [{ file: mod.csvs[0], table: '' }] : [];
  return { id: mod.id, enabled: root !== null || csv.length > 0, root, overlays: [], natives: [], csv };
}

async function csvHeader(file) {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buffer);
    return /^\s*(?:"ID"|ID)\s*[,;\t]/i.test(buffer.toString('utf8', 0, bytesRead));
  } finally {
    await handle.close();
  }
}

async function scanCsv(folder, files) {
  const csvs = [];
  const rejected = [];
  for (const file of files.filter(file => CSV_PATCH.test(file))) {
    const recognized = await csvHeader(assetPath(folder, file)).catch(error => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    (recognized ? csvs : rejected).push(file);
  }
  return { csvs, rejected };
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const block of createReadStream(file)) hash.update(block);
  return hash.digest('hex');
}

function importKind({ archive, looseCsv, appearancePreset }) {
  // A loose CSV's filename can select its Smithbox table.
  if (looseCsv) return 'csv:' + path.parse(archive).name.toLowerCase();
  return appearancePreset ? 'preset' : 'archive';
}

async function hashModContents(folder, files, looseCsv) {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(looseCsv ? 'patch.csv' : file);
    hash.update('\0');
    hash.update(await hashFile(assetPath(folder, file)));
  }
  return hash.digest('hex');
}

function duplicateImport(mod) {
  return { name: mod.name, warnings: [], duplicate: true };
}

function me3Profile(profile, overlay, natives, visualDll) {
  // TOML basic strings escape Windows paths, including paths with apostrophes.
  const quoted = value => JSON.stringify(value);
  const text = ['profileVersion = "v1"', 'start_online = false'];
  if (profile.isolated) text.push('savefile = ' + quoted(saveName(profile)));
  text.push('', '[[supports]]', 'game = "eldenring"');
  if (overlay) text.push('', '[[packages]]', 'id = "ringward-assets"', 'path = ' + quoted(overlay));
  if (visualDll) text.push('', '[[natives]]', 'path = ' + quoted(visualDll), 'load_early = true');
  for (const dll of natives) text.push('', '[[natives]]', 'path = ' + quoted(dll));
  return text.join('\n') + '\n';
}

class Manager {
  constructor(root, worker, onProgress) {
    this.root = root;
    this.worker = worker;
    this.onProgress = onProgress;
  }

  async init(detected) {
    await fs.mkdir(this.root, { recursive: true });
    for (const folder of ['library', 'backups', 'runs', 'scratch', 'tools']) {
      await fs.mkdir(this.at(folder), { recursive: true });
    }
    this.db = this.at('manager.json');
    if (await exists(this.db)) {
      this.state = JSON.parse(await fs.readFile(this.db, 'utf8'));
      const olderMods = this.state.mods.filter(mod => !mod.csvs && mod.files.some(file => CSV_PATCH.test(file)));
      if (olderMods.length) {
        for (const mod of olderMods) mod.csvs = (await scanCsv(this.modRoot(mod.id), mod.files)).csvs;
        await this.commit(this.state);
      }
    } else {
      const profile = newProfile('Default');
      this.state = {
        settings: { ...detected, smithbox: '' }, mods: [], profiles: [profile],
        active: profile.id, backups: [], lastLog: ''
      };
      await this.commit(this.state);
    }
  }

  at(...parts) { return path.join(this.root, ...parts); }
  modRoot(modId) { return this.at('library', modId); }
  progress(message, fraction = null) { this.onProgress?.({ message, fraction }); }

  async commit(next) {
    await atomicWrite(this.db, JSON.stringify(next, null, 2));
    this.state = next;
  }

  async update(change) {
    const next = structuredClone(this.state);
    change(next);
    await this.commit(next);
  }

  snapshot() {
    return {
      ...this.state,
      profiles: [vanillaProfile(), ...this.state.profiles],
      visual: this.state.visual ?? null,
      reshadeVersion: reshade.VERSION,
      mods: this.state.mods.map(({ files, sourceKey, contentHash, ...mod }) => ({ ...mod, fileCount: files.length })),
      backups: this.state.backups.map(({ files, ...backup }) => ({ ...backup, count: files.length })),
      plan: this.plan(this.state.active).report,
      running: Boolean(this.child)
    };
  }

  async toolStatus() {
    const { game, smithbox } = this.state.settings;
    const [gameReady, me3, smithboxReady, reshadeReady] = await Promise.all([
      exists(game), this.me3Status(), this.smithboxReady(smithbox), this.reshadeReady()
    ]);
    const reshadeInstalled = reshadeReady || (await Promise.all(this.reshadeFolders().map(folder =>
      exists(this.at('tools', folder))))).some(Boolean);
    return {
      game: gameReady, me3: me3.ready, me3Version: me3.version, me3ReShade: me3.compatible,
      smithbox: smithboxReady, reshade: reshadeReady, reshadeInstalled
    };
  }

  async autodetect(paths) {
    const ready = await this.toolStatus();
    const candidate = this.at('tools', SMITHBOX.folder);
    const smithbox = await this.smithboxReady(candidate) ? candidate : '';
    const localMe3 = this.at('tools', ME3.folder, 'bin', 'me3.exe');
    const me3 = paths.me3 || (await exists(localMe3) ? localMe3 : '');
    await this.update(state => {
      if (!ready.game && paths.game) state.settings.game = paths.game;
      if (!ready.me3 && me3) state.settings.me3 = me3;
      if (!ready.smithbox && smithbox) state.settings.smithbox = smithbox;
      if (!state.settings.saves && paths.saves) state.settings.saves = paths.saves;
    });
  }

  profile(state, profileId) {
    if (profileId === VANILLA) return vanillaProfile();
    const found = state.profiles.find(profile => profile.id === profileId);
    if (!found) throw new Error('This profile was removed.');
    return found;
  }

  mod(modId) {
    const found = this.state.mods.find(mod => mod.id === modId);
    if (!found) throw new Error('This mod was removed.');
    return found;
  }

  nexusMod(nexus) {
    if (!nexus) return undefined;
    return this.state.mods.find(mod => mod.nexus &&
      mod.nexus.modId === nexus.modId && mod.nexus.fileId === nexus.fileId);
  }

  async matchingContents(mod, staged) {
    const kind = importKind(mod);
    mod.contentHash = await hashModContents(staged, mod.files, mod.looseCsv);
    for (const existing of this.state.mods) {
      if (importKind(existing) !== kind) continue;
      if (existing.contentHash === mod.contentHash) return existing;
      if (existing.contentHash || existing.files.length !== mod.files.length ||
          (!mod.looseCsv && !existing.files.every((file, index) => file === mod.files[index]))) continue;
      // Older imports stored the file list without a fingerprint. Compare those
      // only when the layout matches so upgrades need no library-wide scan.
      const previous = await hashModContents(this.modRoot(existing.id), existing.files, mod.looseCsv).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (previous === mod.contentHash) return existing;
    }
    return null;
  }

  async rememberDuplicate(existing, { sourceKey, contentHash, nexus }) {
    if ((!existing.sourceKey && sourceKey) || (!existing.contentHash && contentHash) || (!existing.nexus && nexus)) {
      await this.update(state => {
        const saved = state.mods.find(item => item.id === existing.id);
        saved.sourceKey ??= sourceKey;
        saved.contentHash ??= contentHash;
        saved.nexus ??= nexus ?? null;
      });
    }
    return duplicateImport(existing);
  }

  async editProfile(data) {
    if (data.id === VANILLA && !['select', 'create'].includes(data.action)) throw new Error('Vanilla is a built-in gameplay profile.');
    await this.update(state => {
      if (data.action === 'create' || data.action === 'duplicate') {
        const profile = newProfile(cleanName(data.name, 'New profile'));
        if (data.action === 'duplicate') {
          const source = this.profile(state, data.id);
          Object.assign(profile, {
            mods: structuredClone(source.mods), isolated: source.isolated,
            autoBackup: source.autoBackup, diagnostics: source.diagnostics
          });
        }
        state.profiles.push(profile);
        state.active = profile.id;
        return;
      }
      const profile = this.profile(state, data.id);
      if (data.action === 'select') state.active = profile.id;
      if (data.action === 'remove') {
        state.profiles = state.profiles.filter(item => item.id !== profile.id);
        if (state.active === profile.id) state.active = VANILLA;
      }
      if (data.action === 'settings') {
        profile.name = cleanName(data.name, profile.name);
        for (const field of ['isolated', 'autoBackup', 'diagnostics']) profile[field] = Boolean(data[field]);
      }
    });
  }

  async profileMod(data) {
    if (data.profile === VANILLA) throw new Error('Vanilla cannot contain gameplay mods. Select or create another profile.');
    const mod = this.mod(data.modId);
    if (mod.sliderSheets?.length || mod.appearancePreset) throw new Error('Character presets are managed from the Mod library.');
    if (mod.reshadeOnly) throw new Error('Choose this pack in the ReShade tab.');
    await this.update(state => {
      const profile = this.profile(state, data.profile);
      const index = profile.mods.findIndex(item => item.id === mod.id);
      const entry = profile.mods[index];
      if (data.action === 'add' && !entry) {
        profile.mods.push(modEntry(mod));
        return;
      }
      if (!entry) return;
      if (data.action === 'toggle') entry.enabled = Boolean(data.enabled);
      if (data.action === 'detach') profile.mods.splice(index, 1);
      if (data.action === 'move') {
        const target = index + Math.sign(data.direction);
        if (target >= 0 && target < profile.mods.length) {
          [profile.mods[index], profile.mods[target]] = [profile.mods[target], profile.mods[index]];
        }
      }
      if (data.action === 'position') {
        const position = data.position;
        if (!Number.isInteger(position) || position < 1 || position > profile.mods.length) {
          throw new Error('Choose a position from 1 to ' + profile.mods.length + '.');
        }
        profile.mods.splice(index, 1);
        profile.mods.splice(position - 1, 0, entry);
      }
      if (data.action === 'reorder' && data.targetId !== entry.id) {
        const target = profile.mods.findIndex(item => item.id === data.targetId);
        if (target < 0) throw new Error('The destination mod is no longer in this profile.');
        profile.mods.splice(index, 1);
        const position = index < target ? target - 1 : target;
        profile.mods.splice(position + (data.after ? 1 : 0), 0, entry);
      }
      if (data.action === 'configure') {
        if (data.root !== null && !mod.candidates.includes(data.root)) throw new Error('Invalid asset folder.');
        if (!Array.isArray(data.natives) || data.natives.some(file => !mod.natives.includes(file))) throw new Error('Invalid DLL selection.');
        if (!Array.isArray(data.overlays) || data.overlays.some(root => !mod.candidates.includes(root) || root === data.root))
          throw new Error('Invalid optional asset folder.');
        const csv = data.csv ?? [];
        if (!Array.isArray(csv) || csv.some(patch => !mod.csvs?.includes(patch.file) || typeof patch.table !== 'string' ||
            !/^[A-Za-z0-9_]{0,100}$/.test(patch.table)) || new Set(csv.map(patch => patch.file)).size !== csv.length) {
          throw new Error('Choose a CSV from this mod and enter a valid Smithbox table name.');
        }
        const wasUnconfigured = entry.root === null && entry.natives.length === 0 && !entry.csv?.length;
        const configured = data.root !== null || data.natives.length > 0 || csv.length > 0;
        entry.enabled = configured && (entry.enabled || wasUnconfigured);
        entry.root = data.root;
        entry.overlays = data.root === null ? [] : [...new Set(data.overlays)];
        entry.natives = [...new Set(data.natives)];
        entry.csv = csv;
      }
    });
  }

  async importMod(source, profileId, metadata = {}, folder = false) {
    const archive = metadata.archive || path.basename(source);
    const looseCsv = !folder && CSV_PATCH.test(archive);
    const appearancePreset = !folder && PRESET_FILE.test(archive);
    const looseVisual = !folder && reshade.INI.test(archive);
    if (!folder && !looseCsv && !appearancePreset && !looseVisual && !MOD_ARCHIVE.test(archive)) {
      throw new Error('Choose a mod archive, Smithbox CSV, ReShade INI, Elden Sliders JSON, or extracted folder.');
    }
    if (profileId) this.profile(this.state, profileId);
    const nexusMatch = this.nexusMod(metadata.nexus);
    if (nexusMatch) return duplicateImport(nexusMatch);

    let sourceInfo;
    let sourceKey;
    if (!folder) {
      sourceInfo = await fs.stat(source);
      if (!sourceInfo.isFile()) throw new Error('Choose a regular mod file.');
      if (appearancePreset && sourceInfo.size > PRESET_LIMIT) throw new Error('Choose a preset JSON file under 1 MB.');
      if (looseVisual && sourceInfo.size > reshade.INI_LIMIT) throw new Error('Choose a ReShade INI under 1 MB.');
      if (looseCsv && sourceInfo.size > 64 * 1024 ** 2) throw new Error('CSV patches must be 64 MB or smaller.');
      this.progress('Checking ' + archive + '…');
      sourceKey = importKind({ archive, looseCsv, appearancePreset }) + ':' + await hashFile(source);
      const existing = this.state.mods.find(mod => mod.sourceKey === sourceKey);
      if (existing) return this.rememberDuplicate(existing, { nexus: metadata.nexus });
    }
    this.progress('Importing ' + archive + '…');
    const modId = id();
    const scratch = await fs.mkdtemp(this.at('scratch', 'import-'));
    let moved = false;
    try {
      let files;
      let presetName = '';
      if (appearancePreset) {
        const file = path.join(scratch, 'appearance.json');
        await fs.copyFile(source, file);
        presetName = (await readAppearancePreset(file)).name;
        files = ['appearance.json'];
      } else if (looseCsv) {
        // Use a fixed local filename for Nexus downloads while preserving the table name in the archive label.
        const local = metadata.nexus ? 'patch.csv' : path.basename(source);
        await fs.copyFile(source, path.join(scratch, local));
        files = [local];
      } else if (looseVisual) {
        await fs.copyFile(source, path.join(scratch, 'Preset.ini'));
        files = ['Preset.ini'];
      } else {
        files = (await (folder ? importFolder(source, scratch) : extractModArchive(source, scratch, archive))).sort();
      }
      if (sourceInfo) {
        const current = await fs.stat(source);
        if (sourceInfo.size !== current.size || sourceInfo.mtimeMs !== current.mtimeMs || sourceInfo.ctimeMs !== current.ctimeMs) {
          throw new Error('The mod file changed during import. Try again once it has finished downloading.');
        }
      }
      const { csvs, rejected } = await scanCsv(scratch, files);
      const mod = {
        id: modId, name: cleanName(presetName || metadata.name, folder ? archive : archive.replace(/\.[^.]+$/, '')), archive,
        files, ...inspectFiles(files), csvs, looseCsv, nexus: metadata.nexus || null
      };
      const visualPresets = await reshade.inspectPresets(scratch, files);
      if ((looseVisual || metadata.visualOnly) && !visualPresets.length) {
        throw new Error('No ReShade preset with a Techniques setting was found.');
      }
      if (visualPresets.length) {
        mod.reshadePresets = visualPresets;
        mod.reshadeOnly = !mod.candidates.length && !csvs.length;
        if (mod.reshadeOnly && !looseVisual && !metadata.name && visualPresets.length === 1) {
          mod.name = cleanName(path.posix.basename(visualPresets[0].file, path.posix.extname(visualPresets[0].file)).replaceAll('_', ' '), mod.name);
        }
        // ReShade always comes from the verified installer, never a preset archive.
        mod.natives = [];
        mod.configs = mod.configs.filter(file => !visualPresets.some(preset => preset.file === file));
      }
      if (appearancePreset) {
        mod.appearancePreset = true;
        mod.configs = [];
      }
      const warnings = [];
      if (mod.unknownCount) warnings.push(mod.unknownCount + ' files have no recognized game path: ' + mod.unknown.slice(0, 3).join(', '));
      if (rejected.length) warnings.push('CSV files without a Smithbox ID header: ' + rejected.slice(0, 3).join(', '));
      if (!appearancePreset && !visualPresets.length && !mod.candidates.length && !mod.natives.length && !csvs.length) {
        const sheets = await findSliderSheets(scratch, files);
        if (!sheets.length) {
          const sample = warnings.join(' · ') || 'Found: ' + files.slice(0, 3).join(', ');
          throw new Error('No recognized Elden Ring assets, DLLs, Smithbox CSVs, ReShade presets, or character slider sheets. ' + sample);
        }
        mod.sliderSheets = sheets;
      }
      mod.warnings = warnings;
      mod.sourceKey = sourceKey;
      this.progress('Checking library for duplicates…');
      const existing = await this.matchingContents(mod, scratch);
      if (existing) return await this.rememberDuplicate(existing, mod);
      await fs.rename(scratch, this.modRoot(modId));
      moved = true;
      await this.update(state => {
        state.mods.push(mod);
        if (profileId && profileId !== VANILLA && !mod.sliderSheets && !appearancePreset && !mod.reshadeOnly) {
          const profile = this.profile(state, profileId);
          profile.mods.push(modEntry(mod));
        }
      });
      return { name: mod.name, warnings, sliderGuide: Boolean(mod.sliderSheets), appearancePreset, reshadePreset: Boolean(visualPresets.length) };
    } catch (error) {
      if (moved) await fs.rm(this.modRoot(modId), { recursive: true, force: true });
      throw error;
    } finally {
      if (!moved) await fs.rm(scratch, { recursive: true, force: true });
    }
  }

  async sliderSheet(modId, index) {
    const mod = this.mod(modId);
    const relative = Number.isInteger(index) && mod.sliderSheets?.[index];
    if (!relative) throw new Error('Choose a slider sheet from this character preset.');
    const file = assetPath(this.modRoot(modId), relative);
    if (!await isSliderImage(file).catch(error => {
      if (error.code === 'ENOENT') return false;
      throw error;
    })) throw new Error('The slider image is missing or unreadable.');
    return file;
  }

  async appearanceSaves() {
    const saves = await saveFiles(this.state.settings.saves);
    return saves.filter(file => /\.sl2$/i.test(file)).map(relative => {
      const [account, name] = relative.split('/');
      const profile = this.state.profiles.find(profile => saveName(profile).toLowerCase() === name.toLowerCase());
      const label = profile ? profile.name + ' profile save' : /^ER0000\.sl2$/i.test(name) ? 'Default Elden Ring save' : name;
      return { relative, profileId: profile?.id ?? null, label: label + ' · Steam account ending ' + account.slice(-4) };
    });
  }

  async importPresetJson(text) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > PRESET_LIMIT) throw new Error('Choose a preset JSON under 1 MB.');
    const folder = await fs.mkdtemp(this.at('scratch', 'preset-'));
    try {
      const file = path.join(folder, 'Elden Sliders preset.json');
      await fs.writeFile(file, text, { flag: 'wx' });
      return await this.importMod(file, null);
    } finally {
      await fs.rm(folder, { recursive: true, force: true });
    }
  }

  async favoritesState(relative) {
    const saves = await this.appearanceSaves();
    const selected = saves.find(save => save.relative === relative) ||
      saves.find(save => save.profileId === this.state.active) || (saves.length === 1 ? saves[0] : null);
    if (!selected) return { saves, selected: '', slots: [] };
    try {
      const file = await assertSaveTarget(this.state.settings.saves, selected.relative);
      const slots = listFavorites(await readPcSave(file));
      const identities = new Map();
      for (const mod of this.state.mods.filter(mod => mod.appearancePreset)) {
        const preset = await readAppearancePreset(path.join(this.modRoot(mod.id), 'appearance.json')).catch(() => null);
        if (preset) {
          const key = appearanceKey(preset.record);
          if (!identities.has(key)) identities.set(key, mod.id);
        }
      }
      return {
        saves, selected: selected.relative,
        slots: slots.map(({ key, ...slot }) => ({ ...slot, presetId: identities.get(key) }))
      };
    } catch (error) {
      return { saves, selected: selected.relative, slots: [], error: error.message };
    }
  }

  async applyAppearance(modId, relative, targetSlot) {
    const mod = this.mod(modId);
    if (!mod.appearancePreset) throw new Error('Choose an imported Elden Sliders JSON preset.');
    const preset = await readAppearancePreset(path.join(this.modRoot(mod.id), 'appearance.json'));
    return this.editFavorites(relative, original => addFavorite(original, preset.record, targetSlot));
  }

  async removeAppearance(relative, targetSlot) {
    return this.editFavorites(relative, original => removeFavorite(original, targetSlot));
  }

  async editFavorites(relative, change) {
    const selected = (await this.appearanceSaves()).find(save => save.relative === relative);
    if (!selected) throw new Error('Choose an existing PC save.');
    await this.assertClosed();
    const target = await assertSaveTarget(this.state.settings.saves, relative);
    const original = await readPcSave(target);
    const result = change(original);
    if (result.already) return { slot: result.slot, already: true };
    const backup = await this.makeBackup('Before Favorites edit', selected.profileId, [relative]);
    const saved = await readPcSave(assetPath(this.at('backups', backup.id), relative));
    if (!saved.equals(original)) throw new Error('The save changed during backup. Try again with Elden Ring closed.');
    await atomicWrite(target, result.save, async () => {
      await this.assertClosed();
      if (!(await readPcSave(target)).equals(original)) throw new Error('The save changed during the operation. Try again.');
    });
    return { slot: result.slot, already: false };
  }

  async download(request, key, profileId) {
    const existing = this.nexusMod(request);
    if (existing) return duplicateImport(existing);
    const temp = await fs.mkdtemp(this.at('scratch', 'nexus-'));
    try {
      const file = path.join(temp, 'mod.archive');
      const metadata = await nexus.downloadMod(key, request, file, ARCHIVE_LIMIT, fraction => {
        this.progress('Downloading from Nexus Mods…', fraction);
      });
      return await this.importMod(file, profileId, metadata);
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }

  async renameMod(modId, value) {
    this.mod(modId);
    await this.update(state => {
      const mod = state.mods.find(item => item.id === modId);
      mod.name = cleanName(value, mod.name);
    });
  }

  async removeMod(modId) {
    this.mod(modId);
    await this.assertClosed();
    const source = this.modRoot(modId);
    const trash = this.at('scratch', 'removed-' + modId);
    await fs.rename(source, trash);
    try {
      await this.update(state => {
        state.mods = state.mods.filter(mod => mod.id !== modId);
        if (state.visual?.id === modId) state.visual = null;
        for (const profile of state.profiles) profile.mods = profile.mods.filter(mod => mod.id !== modId);
      });
    } catch (error) {
      await fs.rename(trash, source);
      throw error;
    }
    await fs.rm(trash, { recursive: true, force: true });
  }

  async config(modId, relative, value) {
    const mod = this.mod(modId);
    if (!mod.configs.includes(relative)) throw new Error('Select a recognized mod config.');
    const file = assetPath(this.modRoot(modId), relative);
    const original = await fs.readFile(file);
    if (original.length > 1024 ** 2 || original.includes(0)) throw new Error('The editor supports UTF-8 text configs up to 1 MB.');
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const text = decoder.decode(original);
    if (value === undefined) return text.replace(/^\uFEFF/, '');
    await this.assertClosed();
    if (typeof value !== 'string' || Buffer.byteLength(value) > 1024 ** 2) throw new Error('The config exceeds 1 MB.');
    const lineEndings = text.includes('\r\n') ? value.replace(/\r?\n/g, '\r\n') : value;
    await atomicWrite(file, (text.startsWith('\uFEFF') ? '\uFEFF' : '') + lineEndings);
  }

  plan(profileId) {
    const profile = this.profile(this.state, profileId);
    const winners = new Map();
    const files = new Map();
    const regulations = [];
    const natives = [];
    const incomplete = [];
    for (const [index, entry] of profile.mods.entries()) {
      if (!entry.enabled) continue;
      const mod = this.mod(entry.id);
      const folder = this.modRoot(mod.id);
      if (entry.root === null && !entry.natives.length && !entry.csv?.length) incomplete.push(mod.name);
      const variant = new Map();
      for (const root of [entry.root, ...(entry.overlays || [])]) {
        for (const item of packageFiles(mod, root)) variant.set(item.rel.toLowerCase(), item);
      }
      for (const [key, { file, rel }] of variant) {
        const item = { source: assetPath(folder, file), rel, name: mod.name, id: mod.id };
        if (key === 'regulation.bin') {
          regulations.push({ path: item.source, name: mod.name, id: mod.id });
          continue;
        }
        const authors = files.get(key) || [];
        authors.push({ name: mod.name, position: index + 1 });
        files.set(key, authors);
        winners.set(key, item);
      }
      for (const patch of entry.csv || []) {
        const filename = path.basename(mod.looseCsv ? mod.archive : patch.file);
        regulations.push({
          id: mod.id, path: assetPath(folder, patch.file), name: mod.name + ' · ' + filename,
          table: patch.table, filename
        });
      }
      for (const dll of entry.natives) natives.push(assetPath(folder, dll));
    }
    const conflicts = [...files].filter(([, authors]) => authors.length > 1);
    return { profile, winners, regulations, natives, report: {
      assets: winners.size, nativeCount: natives.length, regulations: regulations.map(({ id, name }) => ({ id, name })),
      assetConflictCount: conflicts.length,
      conflicts: conflicts.slice(0, 300).map(([key, authors]) => [winners.get(key).rel, authors]),
      incomplete
    } };
  }

  async setSetting(field, value) {
    if (!['game', 'me3', 'saves', 'smithbox'].includes(field) || typeof value !== 'string') throw new Error('Unknown setting.');
    if (value && (!path.isAbsolute(value) || !await exists(value))) throw new Error('Choose an existing path.');
    if (value && field === 'game' && path.basename(value).toLowerCase() !== 'eldenring.exe') throw new Error('Choose eldenring.exe.');
    if (value && field === 'me3' && path.basename(value).toLowerCase() !== 'me3.exe') throw new Error('Choose me3.exe.');
    if (value && field === 'smithbox') await this.assertSmithbox(value);
    await this.update(state => { state.settings[field] = value; });
  }

  async setSkipLogos(value) {
    if (value !== null && typeof value !== 'boolean') throw new Error('Choose a valid startup logo setting.');
    await this.update(state => { state.settings.skipLogos = value; });
  }

  async smithboxReady(folder) {
    if (!folder) return false;
    const paths = ['Andre.Formats.dll', 'Andre.SoulsFormats.dll', 'Andre.Core.dll', 'Andre.IO.dll',
      'Assets/PARAM/ER/Defs', 'Assets/PARAM/ER/Param Type Info.json'];
    return (await Promise.all(paths.map(item => exists(path.join(folder, item))))).every(Boolean);
  }

  async assertSmithbox(folder) {
    if (!await this.smithboxReady(folder)) {
      throw new Error('Choose the extracted Smithbox 2.2.6 folder or install it in Settings.');
    }
  }

  async installTool(release, validate, unpack = extractZip) {
    const target = this.at('tools', release.folder);
    if (!await exists(target)) {
      const scratch = await fs.mkdtemp(this.at('scratch', 'tool-'));
      try {
        const archive = path.join(scratch, 'release.zip');
        const downloading = 'Downloading ' + release.name + '…';
        this.progress(downloading);
        await nexus.downloadTo(release.url, archive, release.limit, fraction => this.progress(downloading, fraction));
        if (await hashFile(archive) !== release.hash) throw new Error(release.name + ' failed its checksum.');
        this.progress('Extracting ' + release.name + '…');
        const output = path.join(scratch, 'files');
        await unpack(archive, output, release.limit * 4);
        await validate(output);
        await fs.rename(output, target);
      } finally {
        await fs.rm(scratch, { force: true, recursive: true });
      }
    }
    return target;
  }

  async installSmithbox() {
    const target = await this.installTool(SMITHBOX, folder => this.assertSmithbox(folder));
    await this.setSetting('smithbox', target);
  }

  async installMe3(updateExisting = false) {
    const existing = this.state.settings.me3;
    if (!updateExisting && await exists(existing)) return;
    const validate = async folder => {
      const bin = path.join(folder, 'bin');
      const ready = await Promise.all(['me3.exe', 'me3-launcher.exe', 'me3_mod_host.dll'].map(file => exists(path.join(bin, file))));
      if (!ready.every(Boolean)) throw new Error('The ME3 archive is missing its Windows launcher files.');
    };
    const target = await this.installTool(ME3, validate);
    await validate(target);
    await this.setSetting('me3', path.join(target, 'bin', 'me3.exe'));
  }

  async me3Status(force = false) {
    const file = this.state.settings.me3;
    const info = file ? await fs.stat(file).catch(() => null) : null;
    if (!info?.isFile()) return { ready: false, version: '', compatible: false };

    const key = JSON.stringify([file, info.size, info.mtimeMs, info.ctimeMs]);
    if (force || this.me3Probe?.key !== key) {
      const result = run(file, ['--version'], { windowsHide: true, timeout: 5000 }).then(({ stdout }) => {
        const [version = '', major, minor] = stdout.match(/\b(\d+)\.(\d+)\.\d+(?:[-+][\w.-]+)?\b/) ?? [];
        return { ready: true, version, compatible: Boolean(version) && (Number(major) > 0 || Number(minor) >= 13) };
      }, () => ({ ready: true, version: '', compatible: false }));
      this.me3Probe = { key, result };
    }
    return this.me3Probe.result;
  }

  reshadeDll() { return this.at('tools', reshade.RUNTIME.folder, reshade.DLL); }

  reshadeFolders() { return [reshade.RUNTIME.folder, ...reshade.PACKS.map(pack => pack.folder)]; }

  async reshadeReady() {
    const items = [this.reshadeDll(), ...reshade.PACKS.map(pack => this.at('tools', pack.folder, pack.subfolder, 'Shaders'))];
    return (await Promise.all(items.map(exists))).every(Boolean);
  }

  async installReShade() {
    const validateRuntime = async folder => {
      if (await hashFile(path.join(folder, reshade.DLL)) !== reshade.DLL_HASH) {
        throw new Error('The ReShade runtime failed its checksum.');
      }
    };
    const target = await this.installTool(reshade.RUNTIME, validateRuntime, reshade.unpackRuntime);
    await validateRuntime(target);
    for (const pack of reshade.PACKS) {
      await this.installTool(pack, async folder => {
        if (!await exists(path.join(folder, pack.subfolder, 'Shaders'))) throw new Error(pack.name + ' is missing its Shaders folder.');
      });
    }
    if (!await this.reshadeReady()) throw new Error('A managed shader collection is incomplete.');
  }

  async uninstallReShade() {
    await this.assertClosed();
    const toolsRoot = await fs.realpath(this.at('tools'));
    const relative = path.relative(await fs.realpath(this.root), toolsRoot);
    if (relative.toLowerCase() !== 'tools') throw new Error('Ringward’s tools folder is redirected. ReShade files could not be removed.');
    if (this.state.visual) await this.selectVisual(null);
    this.progress('Removing ReShade and its shader collections…');
    try {
      for (const folder of this.reshadeFolders()) {
        const target = path.resolve(toolsRoot, folder);
        if (path.dirname(target) !== toolsRoot) throw new Error('Invalid ReShade installation folder.');
        await fs.rm(target, { recursive: true, force: true });
      }
    } catch (error) {
      throw new Error('ReShade is off, but some files could not be removed. Close any programs using those files and retry Uninstall ReShade.', { cause: error });
    }
  }

  async selectVisual(modId, file) {
    const selected = modId ? this.mod(modId).reshadePresets?.find(preset => preset.file === file) : null;
    if (modId && !selected) throw new Error('Choose an imported ReShade preset.');
    await this.update(state => { state.visual = selected ? { id: modId, file: selected.file } : null; });
  }

  async assertClosed() {
    if (this.child || await gameRunning()) throw new Error('Close Elden Ring before continuing.');
  }

  async makeBackup(reason, profileId, subset = null) {
    const root = this.state.settings.saves;
    const files = subset || await saveFiles(root);
    if (!files.length) return null;
    const backup = { id: id(), time: stamp(), reason, profile: profileId, files };
    const dest = this.at('backups', backup.id);
    try {
      for (const relative of files) {
        const output = assetPath(dest, relative);
        await fs.mkdir(path.dirname(output), { recursive: true });
        await fs.copyFile(await assertSaveTarget(root, relative), output);
      }
      await this.update(state => { state.backups.unshift(backup); });
      return backup;
    } catch (error) {
      await fs.rm(dest, { recursive: true, force: true });
      throw error;
    }
  }

  async backup() {
    await this.assertClosed();
    if (!await this.makeBackup('Manual', this.state.active)) throw new Error('No Elden Ring saves were found in the configured folder.');
  }

  backupRecord(backupId) {
    const backup = this.state.backups.find(item => item.id === backupId);
    if (!backup || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(backup.id)) {
      throw new Error('This backup is unavailable.');
    }
    return backup;
  }

  async backupFolder(backupId) {
    const { id } = this.backupRecord(backupId);
    const root = await fs.realpath(this.at('backups'));
    if (path.relative(await fs.realpath(this.root), root).toLowerCase() !== 'backups') {
      throw new Error('Ringward’s backups folder is redirected.');
    }
    const folder = path.join(root, id);
    // A backup parked by an interrupted delete is still usable while it is listed.
    for (const candidate of [folder, folder + '.deleting']) {
      const info = await fs.lstat(candidate).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (!info) continue;
      if (!info.isDirectory()) throw new Error('This backup path is not a regular folder.');
      return candidate;
    }
    return folder;
  }

  async mainSaveFolder() {
    const root = this.state.settings.saves;
    if (!root) throw new Error('Choose the Elden Ring save folder in Settings.');
    const saves = await saveFiles(root);
    const main = saves.filter(file => /^ER0000\.sl2$/i.test(path.posix.basename(file)));
    const accounts = new Set((main.length ? main : saves).map(file => path.posix.dirname(file)));
    return accounts.size === 1 ? path.join(root, accounts.values().next().value) : root;
  }

  async renameBackup(backupId, value) {
    this.backupRecord(backupId);
    if (typeof value !== 'string' || !value.trim()) throw new Error('Enter a backup name.');
    await this.update(state => { state.backups.find(item => item.id === backupId).name = cleanName(value); });
  }

  async deleteBackup(backupId) {
    const folder = await this.backupFolder(backupId);
    const original = path.join(path.dirname(folder), backupId);
    const parked = original + '.deleting';
    if (folder === original) {
      await fs.rename(original, parked).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    try {
      await this.update(state => { state.backups = state.backups.filter(item => item.id !== backupId); });
    } catch (error) {
      if (folder === original) {
        await fs.rename(parked, original).catch(recovery => {
          if (recovery.code !== 'ENOENT') throw recovery;
        });
      }
      throw error;
    }
    try {
      await fs.rm(parked, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      return { remaining: parked };
    }
  }

  async restore(backupId) {
    await this.assertClosed();
    const backup = this.backupRecord(backupId);
    const folder = await this.backupFolder(backupId);
    const root = this.state.settings.saves;
    if (!root) throw new Error('Choose the Elden Ring save folder in Settings.');
    const live = new Map((await saveFiles(root)).map(file => [file.toLowerCase(), file]));
    const targets = await Promise.all(backup.files.map(async relative => {
      const source = await assertSaveTarget(folder, relative);
      if (!await exists(source)) throw new Error('A file is missing from this backup.');
      const current = live.get(relative.toLowerCase()) ?? relative;
      return { relative, source, target: await assertSaveTarget(root, current) };
    }));
    const rollback = await this.makeBackup('Before restore', this.state.active, [...live.values()]);
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
          const data = await fs.readFile(assetPath(this.at('backups', rollback.id), original));
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

  async merge(plan, output = null, approval = '') {
    const { game, smithbox } = this.state.settings;
    if (!game) throw new Error('Choose eldenring.exe in Settings.');
    const vanilla = path.join(path.dirname(game), 'regulation.bin');
    if (!await exists(vanilla)) throw new Error('The Steam installation is missing its vanilla regulation.bin.');
    await this.assertSmithbox(smithbox);
    if (!await exists(this.worker)) throw new Error('The merge worker is missing. Run npm run build:merge or reinstall Ringward.');
    const inputs = [vanilla, ...plan.regulations.map(mod => mod.path)];
    const hashes = await Promise.all(inputs.map(hashFile));
    const fingerprint = createHash('sha256').update(JSON.stringify({
      profile: plan.profile.id, smithbox, hashes, mods: plan.regulations.map(mod => [mod.id, mod.table, mod.filename])
    })).digest('hex');
    const temp = await fs.mkdtemp(this.at('scratch', 'merge-'));
    const request = path.join(temp, 'request.json');
    try {
      this.progress(output ? 'Building regulation.bin…' : 'Comparing regulation files…');
      await fs.writeFile(request, JSON.stringify({
        vanilla, smithbox, mods: plan.regulations, output, allowConflicts: approval === fingerprint
      }));
      const { stdout } = await run(this.worker, [request], {
        cwd: smithbox, windowsHide: true, timeout: 180_000, maxBuffer: 8 * 1024 ** 2
      }).catch(error => {
        throw new Error(error.stderr?.trim() || 'The regulation worker could not finish.');
      });
      const current = await Promise.all(inputs.map(hashFile));
      if (current.some((hash, index) => hash !== hashes[index])) {
        throw new Error('A regulation input changed during the merge. Review the loadout again.');
      }
      return { ...JSON.parse(stdout), fingerprint };
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }

  async review(profileId) {
    const plan = this.plan(profileId);
    if (!plan.regulations.length) return null;
    return this.merge(plan);
  }

  async buildRegulation(profileId, approval) {
    const plan = this.plan(profileId);
    if (plan.report.incomplete.length) throw new Error('Configure or disable ' + plan.report.incomplete.join(', ') + ' before building.');
    if (!plan.regulations.length) throw new Error('Enable a regulation file or Smithbox CSV to build.');
    const temp = await fs.mkdtemp(this.at('scratch', 'build-'));
    try {
      const name = 'regulation.bin';
      const staged = path.join(temp, name);
      const report = await this.merge(plan, staged, approval);
      if (!report.built) return { review: report };
      const folder = this.at('builds', plan.profile.id);
      await fs.mkdir(folder, { recursive: true });
      const file = path.join(folder, name);
      await fs.rename(staged, file);
      return { file };
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }

  async launch(profileId, approval) {
    await this.assertClosed();
    const { game, me3, skipLogos } = this.state.settings;
    const visual = this.state.visual;
    if (!await exists(game)) throw new Error('Set up Elden Ring in Settings before launching.');
    if (profileId === VANILLA && !visual) {
      await reshade.assertNoExternalHooks(game);
      return { vanilla: true };
    }
    if (!await exists(me3)) throw new Error('Set up ME3 in Settings before launching.');
    if (visual) {
      if (!await this.reshadeReady()) throw new Error('Install ReShade and its shader collections in the ReShade tab.');
      if (await hashFile(this.reshadeDll()) !== reshade.DLL_HASH) throw new Error('The managed ReShade runtime failed its checksum.');
      if (!(await this.me3Status()).compatible) {
        throw new Error('ReShade needs ME3 0.13.0 or newer. Use Install compatible ME3 in the ReShade tab.');
      }
      await reshade.assertNoExternalHooks(game, true);
    }
    const plan = this.plan(profileId);
    if (plan.report.incomplete.length) throw new Error('Configure or disable ' + plan.report.incomplete.join(', ') + ' before launching.');
    const target = await fs.mkdtemp(this.at('runs', 'launch-'));
    try {
      const overlay = path.join(target, 'assets');
      await fs.mkdir(overlay);
      if (plan.regulations.length) {
        const report = await this.merge(plan, path.join(overlay, 'regulation.bin'), approval);
        if (!report.built) {
          await fs.rm(target, { recursive: true, force: true });
          return { review: report };
        }
      }
      this.progress('Preparing profile files…');
      for (const item of plan.winners.values()) {
        const dest = assetPath(overlay, item.rel);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(item.source, dest);
      }
      const profileFile = path.join(target, 'profile.me3');
      const log = path.join(target, 'me3.log');
      const visualBase = this.at('reshade');
      await this.assertClosed();
      await reshade.recoverLegacyConfig(visualBase, this.at('runs'), this.state.lastVisualLog);
      if (visual) {
        this.progress('Preparing ReShade preset…');
        const mod = this.mod(visual.id);
        await reshade.stagePreset({
          target: path.join(target, 'reshade'), base: visualBase, modRoot: this.modRoot(mod.id),
          files: mod.files, presetFile: visual.file, toolsRoot: this.at('tools')
        });
      }
      await fs.writeFile(profileFile, me3Profile(plan.profile, plan.winners.size || plan.regulations.length ? overlay : null,
        plan.natives, visual ? this.reshadeDll() : null));
      await this.assertClosed();
      if (plan.profile.autoBackup) await this.makeBackup('Before launch', profileId);
      await this.update(state => {
        state.lastLog = log;
        if (visual) state.lastVisualLog = path.join(visualBase, 'ReShade.log');
      });
      const args = ['launch', '--game', 'eldenring', '--exe', game, '--profile', profileFile, '--online=false'];
      if (typeof skipLogos === 'boolean') args.push('--show-logos=' + !skipLogos);
      if (plan.profile.diagnostics) args.push('--diagnostics');
      const env = visual ? { ...process.env, RESHADE_BASE_PATH_OVERRIDE: visualBase } : process.env;
      const child = spawn(me3, args, { cwd: path.dirname(game), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
      this.child = child;
      const logStream = createWriteStream(log, { flags: 'a' });
      logStream.on('error', () => {});
      child.stdout.pipe(logStream, { end: false });
      child.stderr.pipe(logStream, { end: false });
      child.on('close', code => {
        logStream.end('\nME3 exited with code ' + code + '\n');
        this.child = null;
        this.onLaunchEnd?.(code);
      });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      for (const entry of await fs.readdir(this.at('runs'), { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory() && entry.name.startsWith('launch-') && entry.name !== path.basename(target)) {
          await fs.rm(this.at('runs', entry.name), { recursive: true, force: true }).catch(() => {});
        }
      }
      return { launched: true };
    } catch (error) {
      await fs.rm(target, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
}

module.exports = { Manager, me3Profile };
