const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const tools = path.join(root, '.tools');
const refs = ['Andre.Core.dll', 'Andre.Formats.dll', 'Andre.IO.dll', 'Andre.SoulsFormats.dll'];
const smithbox = 'https://raw.githubusercontent.com/vawser/Smithbox/d144cc7f85b755665f3291edf1bae847094c1963/Smithbox.Release/Output/';

async function build() {
  let references = process.env.SMITHBOX_DIR;
  if (!references) {
    references = path.join(tools, 'smithbox-refs');
    await fs.mkdir(references, { recursive: true });
    await Promise.all(refs.map(async name => {
      const response = await fetch(smithbox + name, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error('Could not fetch Smithbox build reference ' + name);
      await fs.writeFile(path.join(references, name), Buffer.from(await response.arrayBuffer()));
    }));
  }
  const dotnet = process.env.RINGWARD_DOTNET ||
    spawnSync('where.exe', ['dotnet.exe'], { encoding: 'utf8', windowsHide: true }).stdout?.trim().split(/\r?\n/)[0];
  if (!dotnet) throw new Error('Install the .NET 10 SDK or set RINGWARD_DOTNET to dotnet.exe.');
  const output = path.join(tools, 'merge');
  const result = spawnSync(dotnet, ['publish', path.join(root, 'merge', 'Ringward.Merge.csproj'),
    '-c', 'Release', '-r', 'win-x64', '--self-contained', '-o', output,
    '-p:SmithboxDir=' + path.resolve(references)], { stdio: 'inherit', cwd: root });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('The .NET merge worker could not be published.');
  for (const file of ['LICENSE.txt', 'ThirdPartyNotices.txt']) {
    await fs.copyFile(path.join(path.dirname(dotnet), file), path.join(output, file));
  }
}

build().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
