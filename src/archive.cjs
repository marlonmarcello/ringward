const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { crc32 } = require('node:zlib');
const { promisify } = require('node:util');
const { spawn } = require('node:child_process');
const { run } = require('./platform.cjs');
const yauzl = require('yauzl');

const ARCHIVE_LIMIT = 32 * 1024 ** 3;
const ENTRY_LIMIT = 100_000;
const MOD_ARCHIVE = /\.(zip|7z|rar)$/i;
const CSV_PATCH = /\.csv$/i;
const SLIDER_NAME = /(?:^|[ _-])sliders?(?=$|[ _.-])/i;
const ASSETS = new Set('action asset chr cutscene event face filter font gparam grass map material menu movie msg obj other parts param remo script sfx shader sound talk'.split(' '));
const CONFIG = /\.(ini|toml|cfg|json|yaml|yml|xml|conf)$/i;

function loosePath(name) {
  if (/\.partsbnd\.dcx$/i.test(name)) return 'parts/' + name;
  if (/^c\d{4}(?:_[^.]+)?\.(anibnd|chrbnd|behbnd)\.dcx$/i.test(name)) return 'chr/' + name;
  return null;
}

function safeEntry(name) {
  const segments = name.replace(/\/$/, '').split('/');
  if (segments.some(segment => !segment || segment.length > 255 || segment === '.' || segment === '..' ||
      /[<>:"\\|?*\x00-\x1f]|[ .]$|^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\.|$)/i.test(segment))) {
    throw new Error('The ZIP contains an unsafe Windows path.');
  }
  return segments;
}

async function extractZip(file, target, maxBytes = ARCHIVE_LIMIT) {
  const zip = await promisify(yauzl.open)(file, {
    lazyEntries: true, strictFileNames: true, validateEntrySizes: true, autoClose: false
  });
  const seen = new Set();
  const files = [];
  let bytes = 0;
  try {
    if (zip.entryCount > ENTRY_LIMIT) throw new Error('This ZIP contains too many entries.');
    for await (const entry of zip.eachEntry()) {
      const segments = safeEntry(entry.fileName);
      const kind = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (kind && kind !== 0x8000 && kind !== 0x4000) throw new Error('The ZIP contains a link or special file.');
      const rel = segments.join('/');
      const key = rel.toLowerCase();
      if (seen.has(key)) throw new Error('The ZIP contains paths that collide on Windows.');
      seen.add(key);
      const dest = path.join(target, ...segments);
      if (entry.fileName.endsWith('/')) {
        await fs.mkdir(dest, { recursive: true });
        continue;
      }
      bytes += entry.uncompressedSize;
      if (bytes > maxBytes) throw new Error('The extracted ZIP exceeds the size limit.');
      await fs.mkdir(path.dirname(dest), { recursive: true });
      const stream = await zip.openReadStreamPromise(entry);
      let crc = 0;
      const verify = new Transform({
        transform(chunk, _encoding, callback) {
          crc = crc32(chunk, crc);
          callback(null, chunk);
        },
        flush(callback) {
          callback(crc === entry.crc32 ? null : new Error('A file in the ZIP failed its checksum.'));
        }
      });
      await pipeline(stream, verify, createWriteStream(dest, { flags: 'wx' }));
      files.push(rel);
    }
    if (!files.length) throw new Error('The ZIP is empty.');
    return files;
  } finally {
    zip.close();
  }
}

async function extractModArchive(file, target, name) {
  if (/\.zip$/i.test(name)) return extractZip(file, target);
  const tar = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe');
  const { stdout } = await run(tar, ['--version'], { windowsHide: true, timeout: 5000 }).catch(() => ({ stdout: '' }));
  const version = stdout.match(/libarchive (\d+)\.(\d+)\.(\d+)/i);
  if (!version || Number(version[1]) * 1_000_000 + Number(version[2]) * 1_000 + Number(version[3]) < 3_008_007) {
    throw new Error('This Windows archiver needs an update for 7z and RAR import. You can also extract the archive and import the folder.');
  }
  const temp = await fs.mkdtemp(path.join(path.dirname(target), 'convert-'));
  try {
    // Copy archive entries into a ZIP stream without extracting them onto the filesystem.
    const child = spawn(tar, ['-c', '-b', '1', '--format', 'zip', '--options', 'zip:compression=store', '-f', '-', '@' + path.resolve(file)], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], signal: AbortSignal.timeout(10 * 60 * 1000)
    });
    let failed = false;
    child.on('error', () => { failed = true; });
    const done = new Promise(resolve => child.once('close', resolve));
    let size = 0;
    const limit = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (size > ARCHIVE_LIMIT) return callback(new Error('The converted archive exceeds the size limit.'));
        callback(null, chunk);
      }
    });
    const zip = path.join(temp, 'converted.zip');
    try {
      await pipeline(child.stdout, limit, createWriteStream(zip, { flags: 'wx' }));
    } catch (error) {
      child.kill();
      await done;
      throw error;
    }
    if (await done !== 0 || failed) throw new Error('Windows could not read this archive. Try importing its extracted folder.');
    // bsdtar pads pipe output to its 512-byte block size. Remove padding after the ZIP end record.
    const handle = await fs.open(zip, 'r+');
    try {
      const tail = Buffer.alloc(Math.min(size, 512 + 22));
      const offset = size - tail.length;
      await handle.read(tail, 0, tail.length, offset);
      const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
      if (end < 0 || end + 22 > tail.length || tail.readUInt16LE(end + 20) !== 0 || tail.subarray(end + 22).some(byte => byte !== 0)) {
        throw new Error('Windows produced an unreadable archive.');
      }
      await handle.truncate(offset + end + 22);
    } finally {
      await handle.close();
    }
    return await extractZip(zip, target);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

function inspectFiles(files) {
  const roots = new Map();
  const natives = [];
  const configs = [];
  const unknown = [];
  let unknownCount = 0;
  const addRoot = (segments, score) => {
    const root = segments.join('/');
    roots.set(root, (roots.get(root) || 0) + score);
  };
  for (const rel of files) {
    const parts = rel.split('/');
    const base = parts.at(-1).toLowerCase();
    if (parts.some(part => part.startsWith('.') || part === '__MACOSX')) continue;
    if (base.endsWith('.dll')) natives.push(rel);
    if (CONFIG.test(base)) configs.push(rel);
    if (base === 'regulation.bin') addRoot(parts.slice(0, -1), 20);
    const assetIndex = parts.findIndex((part, index) => index < parts.length - 1 && ASSETS.has(part.toLowerCase()));
    if (assetIndex >= 0) addRoot(parts.slice(0, assetIndex), 1);
    else if (loosePath(base)) addRoot(parts.slice(0, -1), 1);
    else if (base !== 'regulation.bin' && /\.(dcx|bnd|param|bin|msb|emevd|hks|lua)$/i.test(base)) {
      unknownCount++;
      if (unknown.length < 8) unknown.push(rel);
    }
  }
  const candidates = [...roots.keys()].sort((a, b) => roots.get(b) - roots.get(a) || a.length - b.length);
  const defaults = candidates.filter(candidate => /^default(?:[\s_.(-]|$)/i.test(candidate.split('/').at(-1)));
  const suggested = candidates.length === 1 ? candidates[0] : defaults.length === 1 ? defaults[0] : null;
  return { candidates, suggested, natives, configs, unknown, unknownCount };
}

function packageFiles(mod, root) {
  if (root === null) return [];
  const prefix = root ? root + '/' : '';
  const results = new Map();
  for (const file of mod.files.filter(file => file.startsWith(prefix))) {
    const rel = file.slice(prefix.length);
    const parts = rel.split('/');
    const top = parts[0].toLowerCase();
    if ((parts.length === 1 && top === 'regulation.bin') || (parts.length > 1 && ASSETS.has(top))) {
      results.set(rel.toLowerCase(), { file, rel });
    } else if (parts.length === 1) {
      const inferred = loosePath(rel);
      if (inferred && !results.has(inferred.toLowerCase())) results.set(inferred.toLowerCase(), { file, rel: inferred });
    }
  }
  return [...results.values()];
}

async function importFolder(source, target) {
  if (!(await fs.lstat(source)).isDirectory()) throw new Error('Choose a regular folder.');
  const relative = path.relative(source, target);
  if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Choose a folder outside Ringward’s import directory.');
  }
  const files = [];
  let bytes = 0;
  async function visit(segments) {
    for (const item of await fs.readdir(path.join(source, ...segments), { withFileTypes: true })) {
      if (safeEntry(item.name).length !== 1) throw new Error('This folder contains an unsafe filename.');
      const parts = [...segments, item.name];
      if (item.isDirectory()) {
        await visit(parts);
        continue;
      }
      if (!item.isFile()) throw new Error('This folder contains a link or a special file.');
      if (files.length >= ENTRY_LIMIT) throw new Error('This folder contains too many files.');
      const input = path.join(source, ...parts);
      bytes += (await fs.stat(input)).size;
      if (bytes > ARCHIVE_LIMIT) throw new Error('This folder exceeds the size limit.');
      const output = path.join(target, ...parts);
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.copyFile(input, output);
      files.push(parts.join('/'));
    }
  }
  await visit([]);
  if (!files.length) throw new Error('The folder is empty.');
  return files;
}

async function isSliderImage(file) {
  if (!/\.(png|jpe?g)$/i.test(file) || !(await fs.lstat(file)).isFile()) return false;
  const handle = await fs.open(file, 'r');
  try {
    const header = Buffer.alloc(8);
    await handle.read(header);
    return /\.png$/i.test(file) ? header.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : header[0] === 255 && header[1] === 216 && header[2] === 255;
  } finally {
    await handle.close();
  }
}

async function findSliderSheets(folder, files) {
  if (!files.every(file => /\.(png|jpe?g|txt|md)$/i.test(file))) return [];
  const matches = [];
  for (const file of files.filter(file => SLIDER_NAME.test(path.posix.parse(file).name))) {
    if (await isSliderImage(path.join(folder, file))) matches.push(file);
  }
  return matches;
}

module.exports = {
  extractZip, extractModArchive, importFolder, inspectFiles, packageFiles,
  findSliderSheets, isSliderImage, ARCHIVE_LIMIT, MOD_ARCHIVE, CSV_PATCH
};
