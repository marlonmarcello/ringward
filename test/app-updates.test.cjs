const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { AppUpdates, previewDefault, selectRelease, verifiedInstallerDigest } = require('../src/app-updates.cjs');

const installerName = 'Ringward-v1.0.2-setup.exe';
const digest = 'a'.repeat(64);

function release(version, flags = {}) {
  const tag = 'v' + version;
  return {
    tag_name: tag,
    body: 'Changes in ' + version,
    assets: ['Ringward-' + tag + '-setup.exe', 'Ringward-' + tag + '-win-x64.zip', 'windows-update.sigstore.json']
      .map(name => ({ name, state: 'uploaded', size: 1024 })),
    ...flags
  };
}

test('update selection respects versions, preview preferences, and the distribution in use', () => {
  const releases = [
    release('1.0.10', { prerelease: true }),
    release('1.0.1'),
    release('1.0.20', { draft: true }),
    release('1.0.2'),
    release('1.0.30', { assets: [] })
  ];
  assert.equal(previewDefault('0.2.0'), true);
  assert.equal(previewDefault('1.0.0'), false);
  assert.equal(selectRelease(releases, '1.0.0', false, true).name, installerName);
  assert.deepEqual(selectRelease(releases, '1.0.0', true, false), {
    version: '1.0.10', tag: 'v1.0.10', name: 'Ringward-v1.0.10-win-x64.zip',
    notes: 'Changes in 1.0.10', size: 1024, attested: false
  });
  assert.equal(selectRelease(releases, '1.0.10', true, true), null);
  const older = release('0.3.0', { prerelease: true });
  older.assets.pop();
  assert.equal(selectRelease([older], '0.2.0', true, true).attested, false);
});

test('provenance verification pins the main workflow and binds the digest to the versioned installer', async () => {
  const bundle = {
    dsseEnvelope: {
      payloadType: 'application/vnd.in-toto+json',
      payload: Buffer.from(JSON.stringify({
        _type: 'https://in-toto.io/Statement/v1', predicateType: 'https://slsa.dev/provenance/v1',
        subject: [{ name: installerName, digest: { sha256: digest } }]
      })).toString('base64')
    }
  };
  const verify = async (candidate, policy) => {
    assert.equal(candidate, bundle);
    assert.equal(policy.certificateIssuer, 'https://token.actions.githubusercontent.com');
    assert.equal(policy.certificateIdentityURI,
      'https://github.com/marlonmarcello/ringward/.github/workflows/windows.yml@refs/heads/main');
  };
  assert.equal(await verifiedInstallerDigest(bundle, installerName, undefined, verify), digest);
  await assert.rejects(verifiedInstallerDigest(bundle, 'Ringward-v1.0.3-setup.exe', undefined, verify), /does not cover/);
  await assert.rejects(verifiedInstallerDigest(bundle, installerName, undefined, async () => {
    throw new Error('Invalid signature');
  }), /Invalid signature/);
});

test('portable checks find a ZIP and cannot start an in-app installation', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json([release('1.0.2')]));
  const updates = new AppUpdates({ version: '0.1.14', directory: '.', enabled: true, notify: () => {} });
  await updates.check(true);
  assert.equal(updates.snapshot().status, 'available');
  assert.match(updates.downloadUrl(), /\/v1\.0\.2\/Ringward-v1\.0\.2-win-x64\.zip$/);
  await assert.rejects(updates.download(), /manual download/);
  await assert.rejects(updates.install(), /Download and verify/);
});

test('stable checks find the highest eligible version across release pages', async t => {
  const requested = [];
  t.mock.method(globalThis, 'fetch', async url => {
    const page = new URL(url).searchParams.get('page');
    requested.push(page);
    return page === '1'
      ? Response.json([release('1.0.1'), release('1.3.0', { prerelease: true })], {
        headers: { link: '<https://api.github.com/repos/marlonmarcello/ringward/releases?page=2>; rel="next"' }
      })
      : Response.json([release('1.2.0'), release('1.4.0', { assets: [] })]);
  });
  const updates = new AppUpdates({ version: '1.0.1', directory: '.', enabled: true, notify: () => {} });
  await updates.check(false);
  assert.deepEqual(requested, ['1', '2']);
  assert.equal(updates.snapshot().release.version, '1.2.0');
});

test('canceling elevation keeps the verified download ready and waits for a successful retry', async t => {
  const platform = require('../src/platform.cjs');
  const childProcess = require('node:child_process');
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ringward-update-retry-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'Uninstall Ringward.exe'), '');
  t.mock.method(platform, 'run', async (_command, args) => ({
    stdout: args[1].startsWith('HKCU') ? '    InstallLocation    REG_SZ    ' + root : ''
  }));
  let launcher;
  t.mock.method(childProcess, 'spawn', () => {
    launcher = new EventEmitter();
    launcher.stdout = new PassThrough();
    launcher.unref = () => {};
    return launcher;
  });
  const modulePath = require.resolve('../src/app-updates.cjs');
  delete require.cache[modulePath];
  t.after(() => { delete require.cache[modulePath]; });
  const { AppUpdates: TestUpdates } = require(modulePath);
  const updates = new TestUpdates({ version: '1.0.0', executable: path.join(root, 'Ringward.exe'),
    directory: root, enabled: true, notify: () => {} });
  await updates.init();
  updates.digest = digest;
  updates.setStatus('ready');
  const waitForLauncher = async () => {
    for (let attempts = 0; !launcher && attempts < 100; attempts++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(launcher, 'Windows launcher should start');
  };
  let closedChecks = 0;
  const assertClosed = async () => { closedChecks++; };
  const canceled = updates.install(assertClosed);
  await waitForLauncher();
  assert.equal(updates.status, 'installing');
  launcher.stdout.end('cancelled\n');
  assert.equal(await canceled, false);
  assert.equal(updates.status, 'ready');
  assert.equal(updates.digest, digest);
  assert.match(updates.error, /canceled/);

  launcher = null;
  const retry = updates.install(assertClosed);
  await waitForLauncher();
  launcher.stdout.end('started\n');
  assert.equal(await retry, true);
  assert.equal(closedChecks, 2);
});

test('the Windows installer launcher rejects changed bytes and holds locks through execution', {
  skip: process.platform !== 'win32', timeout: 30_000
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ringward-update-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const dir = path.join(root, 'cache');
  const file = path.join(dir, 'installer.exe');
  await fs.mkdir(dir);

  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const start = (script, digest) => spawn(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, env: { ...process.env, RINGWARD_UPDATE_FIXTURE: root,
      RINGWARD_UPDATE_FILE: file, RINGWARD_UPDATE_DIGEST: digest, RINGWARD_UPDATE_SCOPE: '/currentuser' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const compile = start(`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -OutputAssembly $env:RINGWARD_UPDATE_FILE -OutputType ConsoleApplication -TypeDefinition @'
using System;
using System.IO;
using System.Threading;
public class UpdateFixture {
    public static void Main(string[] args) {
        var root = Environment.GetEnvironmentVariable("RINGWARD_UPDATE_FIXTURE");
        File.WriteAllText(Path.Combine(root, "arguments"), string.Join(" ", args));
        for (int i = 0; i < 100 && !File.Exists(Path.Combine(root, "done")); i++) Thread.Sleep(100);
    }
}
'@`, '');
  const collect = async child => {
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const [code] = await once(child, 'close');
    assert.equal(code, 0, stderr);
    return stdout.trim();
  };
  await collect(compile);
  const script = await fs.readFile(path.join(__dirname, '../src/update-installer.ps1'), 'utf8');
  assert.equal(await collect(start(script, '0'.repeat(64))), 'changed');
  await assert.rejects(fs.access(path.join(root, 'arguments')), { code: 'ENOENT' });

  const digest = createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const child = start(script, digest);
  const finished = once(child, 'close');
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const result = await Promise.race([
      once(child.stdout, 'data').then(([chunk]) => chunk.toString().trim()),
      finished.then(() => { throw new Error(stderr || 'Installer launch was not acknowledged.'); })
    ]);
    assert.equal(result, 'started');
    await assert.rejects(fs.writeFile(file, 'modified installer'));
    await assert.rejects(fs.rename(file, path.join(dir, 'moved.exe')));
    await assert.rejects(fs.rename(dir, path.join(root, 'moved-cache')));
    const replacement = path.join(dir, 'replacement.exe');
    await fs.writeFile(replacement, 'replacement');
    await assert.rejects(fs.rename(replacement, file));
  } finally {
    await fs.writeFile(path.join(root, 'done'), '');
    child.stdout.destroy();
    assert.deepEqual(await finished, [0, null], stderr);
  }
  assert.equal(await fs.readFile(path.join(root, 'arguments'), 'utf8'), '--updated /S --force-run /currentuser');
});
