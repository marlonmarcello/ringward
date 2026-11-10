const test = require('node:test');
const assert = require('node:assert/strict');
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
