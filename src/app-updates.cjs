const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const semver = require('semver');
const { run, exists } = require('./platform.cjs');

const REPO = 'marlonmarcello/ringward';
const RELEASES = 'https://github.com/' + REPO + '/releases';
const API = 'https://api.github.com/repos/' + REPO + '/releases';
const WORKFLOW = 'https://github.com/' + REPO + '/.github/workflows/windows.yml@refs/heads/main';
const BUNDLE = 'windows-update.sigstore.json';
const MAX_INSTALLER = 1024 ** 3;
// electron-builder derives this UUID from appId using its NSIS namespace.
const INSTALL_KEY = 'Software\\97e9400b-6b5b-5d0d-815b-bfbd15cdd5b4';

function previewDefault(version) {
  return semver.major(version) === 0 || Boolean(semver.prerelease(version));
}

function selectRelease(releases, current, previews, installed) {
  let newest = null;
  for (const release of releases) {
    const tag = release?.tag_name;
    if (typeof tag !== 'string' || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) continue;
    const version = semver.valid(tag);
    if (!version || release.draft || (!previews && (release.prerelease || semver.prerelease(version)))) continue;
    if (!semver.gt(version, newest?.version ?? current)) continue;
    const name = installed ? 'Ringward-' + tag + '-setup.exe' : 'Ringward-' + tag + '-win-x64.zip';
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const asset = assets.find(item => item.name === name && item.state === 'uploaded');
    if (!asset) continue;
    newest = {
      tag, version, name, size: asset.size,
      notes: typeof release.body === 'string' ? release.body.slice(0, 40_000) : '',
      attested: installed && assets.some(item => item.name === BUNDLE && item.state === 'uploaded')
    };
  }
  return newest;
}

async function installScope(executable) {
  const directory = await fs.realpath(path.dirname(executable));
  if (!await exists(path.join(directory, 'Uninstall Ringward.exe'))) return null;
  const matches = await Promise.all(['HKCU', 'HKLM'].map(async hive => {
    const { stdout } = await run('reg.exe', ['query', hive + '\\' + INSTALL_KEY, '/v', 'InstallLocation', '/reg:64'],
      { windowsHide: true, timeout: 5000 }).catch(() => ({ stdout: '' }));
    const location = stdout.match(/^\s*InstallLocation\s+REG_SZ[ \t]+(.+)$/im)?.[1].trim();
    if (!location || !path.isAbsolute(location)) return false;
    const resolved = await fs.realpath(location).catch(() => '');
    return Boolean(resolved && resolved.toLowerCase() === directory.toLowerCase());
  }));
  if (matches[0] === matches[1]) return null;
  return matches[0] ? '/currentuser' : '/allusers';
}

async function readJson(response, limit) {
  if (!response.ok || !response.body) throw new Error('GitHub returned HTTP ' + response.status + '.');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('GitHub returned an oversized update response.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function fetchAsset(url, signal) {
  const response = await fetch(url, { redirect: 'manual', signal });
  if (response.status !== 302 && response.status !== 307) return response;
  const target = new URL(response.headers.get('location'));
  if (target.origin !== 'https://release-assets.githubusercontent.com') throw new Error('Unexpected GitHub download host.');
  return fetch(target, { redirect: 'error', signal });
}

async function verifyProvenance(bundle, { certificateIdentityURI, certificateIssuer, tufCachePath }) {
  const { bundleFromJSON } = require('@sigstore/bundle');
  const { getTrustedRoot } = require('@sigstore/tuf');
  const { Verifier, toSignedEntity, toTrustMaterial } = require('@sigstore/verify');
  const root = await getTrustedRoot({ cachePath: tufCachePath, timeout: 5000, retry: { retries: 1 } });
  const verifier = new Verifier(toTrustMaterial(root));
  verifier.verify(toSignedEntity(bundleFromJSON(bundle)), {
    subjectAlternativeName: certificateIdentityURI,
    extensions: { issuer: certificateIssuer }
  });
}

async function verifiedInstallerDigest(bundle, name, cache, verify = verifyProvenance) {
  const envelope = bundle?.dsseEnvelope;
  if (envelope?.payloadType !== 'application/vnd.in-toto+json' || typeof envelope.payload !== 'string') {
    throw new Error('The release does not contain a build attestation.');
  }
  // Verify the envelope before reading its claims. The exact certificate identity pins the workflow and main ref.
  await verify(bundle, {
    certificateIdentityURI: WORKFLOW,
    certificateIssuer: 'https://token.actions.githubusercontent.com',
    tufCachePath: cache
  });
  const statement = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
  const digest = statement.subject?.find(item => item.name === name)?.digest?.sha256;
  if (statement._type !== 'https://in-toto.io/Statement/v1' ||
      statement.predicateType !== 'https://slsa.dev/provenance/v1' || !/^[a-f0-9]{64}$/.test(digest ?? '')) {
    throw new Error('The build attestation does not cover this installer.');
  }
  return digest;
}

async function launchInstaller(file, digest, scope) {
  const script = await fs.readFile(path.join(__dirname, 'update-installer.ps1'), 'utf8');
  const command = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  const child = spawn(command, args, {
    detached: true, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    env: { ...process.env, RINGWARD_UPDATE_FILE: file, RINGWARD_UPDATE_DIGEST: digest, RINGWARD_UPDATE_SCOPE: scope }
  });
  const output = createInterface({ input: child.stdout });
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      output.once('line', resolve);
      output.once('close', () => reject(new Error('Windows could not start the verified installer.')));
    });
  } finally {
    output.close();
    child.stdout.destroy();
    child.unref();
  }
}

class AppUpdates {
  constructor({ version, executable, directory, enabled, notify }) {
    this.version = version;
    this.executable = executable;
    this.directory = directory;
    this.enabled = enabled;
    this.notify = notify;
    this.scope = null;
    this.installer = path.join(directory, 'installer.exe');
    this.partial = path.join(directory, 'installer.part');
    this.reset();
  }

  async init() {
    if (!this.enabled) return;
    this.scope = await installScope(this.executable).catch(() => null);
    await Promise.all([this.installer, this.partial].map(file => fs.rm(file, { force: true }).catch(() => {})));
  }

  reset() {
    this.release = null;
    this.digest = null;
    this.setStatus('idle');
  }

  get active() { return ['checking', 'downloading', 'installing'].includes(this.status); }

  snapshot() {
    const { version, enabled, status, progress, error, release } = this;
    return { version, enabled, status, progress, error, installed: Boolean(this.scope), previewDefault: previewDefault(version),
      release: release && { version: release.version, notes: release.notes, attested: release.attested } };
  }

  setStatus(status, error = '', progress = null) {
    Object.assign(this, { status, error, progress });
    this.notify(this.snapshot());
  }

  async check(previews) {
    if (!this.enabled || this.active || this.status === 'ready') return;
    this.setStatus('checking');
    try {
      const options = {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Ringward/' + this.version },
        redirect: 'error', signal: AbortSignal.timeout(12_000)
      };
      let newest = null;
      for (let page = 1; ; page++) {
        const response = await fetch(API + '?per_page=100&page=' + page, options);
        const releases = await readJson(response, 8 * 1024 ** 2);
        newest = selectRelease(releases, newest?.version ?? this.version, previews, Boolean(this.scope)) ?? newest;
        if (!/<[^>]+>;\s*rel="next"/.test(response.headers.get('link') ?? '')) break;
      }
      this.release = newest;
      this.setStatus(this.release ? 'available' : 'current');
    } catch {
      this.setStatus(this.release ? 'available' : 'error', 'Could not check GitHub for updates. Try again later.');
    }
  }

  assetUrl(name) {
    return RELEASES + '/download/' + this.release.tag + '/' + name;
  }

  downloadUrl() {
    if (!this.release) throw new Error('Check for an available update first.');
    return this.assetUrl(this.release.name);
  }

  async download() {
    if (this.status !== 'available' || !this.scope || !this.release.attested) {
      throw new Error('This release is available as a manual download.');
    }
    const { name, size } = this.release;
    this.setStatus('downloading');
    try {
      if (!Number.isSafeInteger(size) || size < 1 || size > MAX_INSTALLER) throw new Error('Invalid installer size.');
      const response = await fetchAsset(this.assetUrl(BUNDLE), AbortSignal.timeout(15_000));
      const bundle = await readJson(response, 1024 ** 2);
      const digest = await verifiedInstallerDigest(bundle, name, path.join(this.directory, 'sigstore'));
      const signal = AbortSignal.timeout(10 * 60_000);
      const installer = await fetchAsset(this.assetUrl(name), signal);
      if (!installer.ok || !installer.body) throw new Error('Could not download the installer.');
      await fs.mkdir(this.directory, { recursive: true });
      await fs.rm(this.partial, { force: true });
      const hash = createHash('sha256');
      let received = 0;
      let lastPercent = 0;
      const meter = new Transform({ transform: (chunk, _encoding, done) => {
        received += chunk.length;
        if (received > size) return done(new Error('The installer is larger than expected.'));
        hash.update(chunk);
        const percent = Math.floor(received * 100 / size);
        if (percent !== lastPercent) {
          lastPercent = percent;
          this.setStatus('downloading', '', percent);
        }
        done(null, chunk);
      } });
      await pipeline(installer.body, meter, createWriteStream(this.partial, { flags: 'wx' }), { signal });
      if (received !== size || hash.digest('hex') !== digest) {
        throw new Error('The installer does not match its build attestation.');
      }
      await fs.rm(this.installer, { force: true });
      await fs.rename(this.partial, this.installer);
      this.digest = digest;
      this.setStatus('ready');
    } catch (error) {
      console.warn('Ringward update download failed.', error.message);
      await fs.rm(this.partial, { force: true }).catch(() => {});
      this.setStatus('available', 'Could not download and verify the update. Retry or download it from GitHub.');
    }
  }

  async install(assertClosed) {
    if (this.status !== 'ready' || !this.digest) throw new Error('Download and verify the update first.');
    const scope = await installScope(this.executable);
    if (!scope || scope !== this.scope) throw new Error('Ringward’s installation changed. Download the installer from GitHub.');
    await assertClosed();
    this.setStatus('installing');
    let result;
    try {
      result = await launchInstaller(this.installer, this.digest, scope);
    } catch (error) {
      console.warn('Ringward update launch failed.', error.message);
    }
    if (result === 'started') return true;
    if (result === 'changed') {
      this.digest = null;
      this.setStatus('available', 'The installer changed after verification. Download the update again.');
    } else {
      this.setStatus('ready', result === 'cancelled'
        ? 'Installation was canceled. Choose Restart and install to try again.'
        : 'Windows could not start the verified installer. Retry or download it from GitHub.');
    }
    return false;
  }
}

module.exports = { AppUpdates, previewDefault, selectRelease, verifiedInstallerDigest };
