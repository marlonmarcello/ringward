const { createWriteStream } = require('node:fs');
const { Transform, Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { MOD_ARCHIVE, CSV_PATCH } = require('./archive.cjs');
const { INI } = require('./reshade.cjs');

const NEXUS = 'https://www.nexusmods.com/eldenring';
const API = 'https://api.nexusmods.com/v1';
const GAME = '/games/eldenring/mods';
const ID = /^[1-9][0-9]{0,14}$/;
const VERSION = require('../package.json').version;

function parseMod(value) {
  const text = String(value).trim();
  if (ID.test(text)) return text;
  const url = URL.parse(text);
  const match = url?.pathname.match(/^\/(?:games\/)?eldenring\/mods\/([1-9][0-9]{0,14})\/?$/);
  if (url?.origin !== 'https://www.nexusmods.com' || !match) throw new Error('Enter an Elden Ring mod URL or Nexus mod ID.');
  return match[1];
}

function parseNxm(value) {
  const url = URL.parse(String(value).trim());
  const match = url?.pathname.match(/^\/mods\/([1-9][0-9]{0,14})\/files\/([1-9][0-9]{0,14})\/?$/);
  if (url?.protocol !== 'nxm:' || url.host.toLowerCase() !== 'eldenring' || url.username || url.password || !match) {
    throw new Error('This download link must be for Elden Ring.');
  }
  const key = url.searchParams.get('key');
  const expires = url.searchParams.get('expires');
  if (key && (!/^\d+$/.test(expires ?? '') || Number(expires) <= Date.now() / 1000)) {
    throw new Error('This Nexus download link expired. Get a fresh Mod Manager Download link on Nexus.');
  }
  return { modId: match[1], fileId: match[2], key, expires };
}

async function api(key, route) {
  if (!key) throw new Error('Connect your Nexus account in Settings first.');
  let response;
  try {
    response = await fetch(API + route, {
      headers: { apikey: key, 'application-name': 'Ringward', 'application-version': VERSION },
      redirect: 'error', signal: AbortSignal.timeout(30_000)
    });
  } catch {
    throw new Error('Could not reach the Nexus Mods API.');
  }
  if (!response.ok) {
    if (response.status === 401) throw new Error('Nexus rejected the API key. Reconnect in Settings.');
    if (response.status === 429) throw new Error('Nexus API rate limit reached. Try again later.');
    if (response.status === 400 || response.status === 403) {
      throw new Error('Nexus refused this request. Use a fresh Mod Manager Download link from the file page or import a manually downloaded archive.');
    }
    throw new Error('Nexus Mods returned HTTP ' + response.status + '.');
  }
  return response.json();
}

async function account(key) {
  const user = await api(key, '/users/validate.json');
  return { name: user.name, premium: Boolean(user.is_premium) };
}

async function modDetails(key, input) {
  const modId = parseMod(input);
  const route = GAME + '/' + modId;
  const [mod, list] = await Promise.all([api(key, route + '.json'), api(key, route + '/files.json')]);
  return {
    id: modId, name: mod.name, summary: mod.summary,
    files: (list.files || []).filter(file => file.category_name !== 'ARCHIVED').map(file => ({
      id: String(file.file_id), name: file.name, archive: file.file_name, version: file.version,
      category: file.category_name || 'File'
    }))
  };
}

async function downloadTo(url, file, maxBytes, progress) {
  const remote = new URL(url);
  if (remote.protocol !== 'https:' || remote.username || remote.password) throw new Error('Invalid download address.');
  let response;
  try {
    response = await fetch(remote, { signal: AbortSignal.timeout(60 * 60 * 1000) });
  } catch {
    throw new Error('The download could not connect.');
  }
  if (!response.ok || !response.body || new URL(response.url).protocol !== 'https:') {
    await response.body?.cancel();
    throw new Error('Download failed (HTTP ' + response.status + ').');
  }
  const size = Number(response.headers.get('content-length')) || 0;
  if (size > maxBytes) {
    await response.body.cancel();
    throw new Error('The download exceeds the size limit.');
  }
  let received = 0;
  let last = 0;
  const counter = new Transform({
    transform(chunk, _, callback) {
      received += chunk.length;
      if (received > maxBytes) return callback(new Error('The download exceeds the size limit.'));
      if (Date.now() - last > 300) {
        last = Date.now();
        progress(size ? Math.min(received / size, 1) : null);
      }
      callback(null, chunk);
    }
  });
  try {
    await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(file, { flags: 'wx' }));
  } catch (error) {
    throw new Error(error.message.includes('size limit') ? error.message : 'The download was interrupted.');
  }
}

async function downloadMod(apiKey, request, target, maxBytes, progress) {
  const { modId, fileId, key, expires } = request;
  if (!ID.test(modId) || !ID.test(fileId)) throw new Error('Invalid Nexus file.');
  const route = GAME + '/' + modId + '/files/' + fileId;
  const file = await api(apiKey, route + '.json');
  const filename = file.file_name || '';
  if (!MOD_ARCHIVE.test(filename) && !CSV_PATCH.test(filename) && !INI.test(filename)) {
    throw new Error('This Nexus file uses a different format. Ringward imports ZIP, 7z, RAR, Smithbox CSV, and ReShade INI files.');
  }
  const query = key ? '?' + new URLSearchParams({ key, expires }) : '';
  const mirrors = await api(apiKey, route + '/download_link.json' + query);
  const url = mirrors.find(mirror => /^https:\/\//i.test(mirror.URI || ''))?.URI;
  if (!url) throw new Error('Nexus returned no download mirror for this file.');
  await downloadTo(url, target, maxBytes, progress);
  return {
    name: file.name || file.file_name.replace(/\.[^.]+$/, ''), archive: file.file_name,
    nexus: { modId, fileId, version: file.version || '' }
  };
}

module.exports = { NEXUS, parseNxm, parseMod, account, modDetails, downloadTo, downloadMod };
