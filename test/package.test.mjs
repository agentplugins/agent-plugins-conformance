import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';

for (const [plugin, file] of [
  ['agent-plugins-conformance', 'plugin'],
  ['agent-plugins-conformance-core', 'plugin'],
  ['agent-plugins-conformance-core', 'mcp'],
]) {
  test(`${plugin}/${file}.json conforms to the pinned Agent Plugins 1.0.0 schema`, async () => {
    const schema = JSON.parse(await readFile(new URL(`schemas/${file}.schema.json`, import.meta.url), 'utf8'));
    const value = JSON.parse(await readFile(new URL(`../plugins/${plugin}/${file}.json`, import.meta.url), 'utf8'));
    const validate = new Ajv2020({ strict: false }).compile(schema);
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
    if (file === 'plugin') assert.equal(value.name, plugin);
  });
}

test('plugin and MCP target the same published specification version', async () => {
  const load = async (name) => JSON.parse(await readFile(new URL(`../plugins/agent-plugins-conformance-core/${name}.json`, import.meta.url), 'utf8'));
  assert.equal((await load('plugin')).$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal((await load('mcp')).$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
});

test('primary run skill is separate from the two core discovery witnesses', async () => {
  const primary = new URL('../plugins/agent-plugins-conformance/', import.meta.url);
  const core = new URL('../plugins/agent-plugins-conformance-core/', import.meta.url);
  assert.deepEqual((await readdir(new URL('skills/', primary))).sort(), ['run-conformance']);
  assert.deepEqual((await readdir(new URL('skills/', core))).sort(), ['conformance-alpha', 'conformance-beta']);
  const runSkill = await readFile(new URL('skills/run-conformance/SKILL.md', primary), 'utf8');
  assert.match(runSkill, /^name: run-conformance$/m);
  for (const name of ['alpha', 'beta']) {
    const witness = await readFile(new URL(`skills/conformance-${name}/SKILL.md`, core), 'utf8');
    assert.match(witness, new RegExp(`^name: conformance-${name}$`, 'm'));
    assert.ok(witness.includes(`APC_${name.toUpperCase()}_V1`));
  }
});
