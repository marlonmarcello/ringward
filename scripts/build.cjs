const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setTimeout } = require('node:timers/promises');

const root = path.resolve(__dirname, '..');
const release = path.join(root, 'release');
const latest = path.join(release, 'latest');

// Windows scanners can briefly hold a freshly built executable open.
async function rename(source, destination) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.rename(source, destination);
    } catch (error) {
      if (attempt >= 10 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      await setTimeout(500);
    }
  }
}

async function build() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg.includes('directories.output'))) {
    throw new Error('Builds are always saved in release/latest. Remove the output directory override.');
  }
  await fs.mkdir(release, { recursive: true });
  const staging = await fs.mkdtemp(path.join(release, '.building-'));
  const previous = staging + '.previous';
  try {
    const target = args.includes('--dir') ? ['--win'] : ['--win', 'nsis'];
    const result = spawnSync(process.execPath, [require.resolve('electron-builder/cli.js'),
      ...target, ...args, '-c.directories.output=' + staging], { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Packaging failed; the previous latest build was kept.');
    await fs.access(path.join(staging, 'win-unpacked', 'Ringward.exe'));
    await fs.access(path.join(staging, 'win-unpacked', 'resources', 'app.asar'));

    let hadPrevious = false;
    try {
      await rename(latest, previous);
      hadPrevious = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      await rename(staging, latest);
    } catch (error) {
      if (hadPrevious) {
        try {
          await rename(previous, latest);
        } catch {
          throw new Error(`Could not replace release/latest. The previous build is saved at ${previous}.`, { cause: error });
        }
      }
      throw error;
    }
    if (hadPrevious) await fs.rm(previous, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    console.log('Latest build: ' + latest);
  } finally {
    await fs.rm(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
}

build().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
