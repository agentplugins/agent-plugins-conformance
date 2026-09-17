import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

for (const directory of ['plugins/agent-plugins-conformance-core/src', 'plugins/agent-plugins-conformance-core/skills/conformance-guide/scripts', 'scripts', 'test']) {
  for (const name of (await readdir(directory)).filter((name) => name.endsWith('.mjs'))) {
    const file = `${directory}/${name}`;
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
const paths = [
  'plugins/agent-plugins-conformance-core/dist/probe.mjs', 'plugins/agent-plugins-conformance-core/THIRD_PARTY_NOTICES.md',
  'plugins/agent-plugins-conformance-core/LICENSE.md', 'plugins/agent-plugins-conformance-core/LICENSES/Apache-2.0.txt', 'plugins/agent-plugins-conformance-core/LICENSES/CC-BY-4.0.txt',
];
const before = await Promise.all(paths.map((path) => readFile(path)));
await import('./build.mjs');
const after = await Promise.all(paths.map((path) => readFile(path)));
for (const [index, path] of paths.entries()) {
  if (!before[index].equals(after[index])) throw new Error(`${path} was stale; commit the output of pnpm build`);
}
console.log('Syntax and committed distributable verified.');
