import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';

for (const [plugin, file] of [
  ['agent-plugins-conformance', 'plugin'],
  ['agent-plugins-conformance-core', 'plugin'],
  ['agent-plugins-conformance-invalid-mcp', 'plugin'],
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

test('primary run skill is separate from the core discovery fixture layout', async () => {
  const primary = new URL('../plugins/agent-plugins-conformance/', import.meta.url);
  const core = new URL('../plugins/agent-plugins-conformance-core/', import.meta.url);
  assert.deepEqual((await readdir(new URL('skills/', primary))).sort(), ['run-conformance']);
  const skills = new URL('skills/', core);
  assert.deepEqual((await readdir(skills)).sort(), ['conformance-alpha', 'conformance-beta', 'without-skill']);
  const runSkill = await readFile(new URL('skills/run-conformance/SKILL.md', primary), 'utf8');
  assert.match(runSkill, /^name: run-conformance$/m);
  for (const name of ['alpha', 'beta']) {
    const witness = await readFile(new URL(`skills/conformance-${name}/SKILL.md`, core), 'utf8');
    assert.match(witness, new RegExp(`^name: conformance-${name}$`, 'm'));
    assert.ok(witness.includes(`APC_${name.toUpperCase()}_V1`));
  }
  assert.deepEqual((await readdir(new URL('without-skill/', skills))).sort(), ['README.md']);
  const nested = await readFile(new URL('conformance-alpha/references/conformance-nested/SKILL.md', skills), 'utf8');
  assert.match(nested, /^name: conformance-nested$/m);
  assert.match(nested, /^description: .+$/m);
});

test('recovery fixture contains exactly the intended invalid manifest and MCP fields', async () => {
  const pluginSchema = JSON.parse(await readFile(new URL('schemas/plugin.schema.json', import.meta.url), 'utf8'));
  const mcpSchema = JSON.parse(await readFile(new URL('schemas/mcp.schema.json', import.meta.url), 'utf8'));
  const plugin = JSON.parse(await readFile(new URL('../plugins/agent-plugins-conformance-recovery/plugin.json', import.meta.url), 'utf8'));
  const mcp = JSON.parse(await readFile(new URL('../plugins/agent-plugins-conformance-recovery/mcp.json', import.meta.url), 'utf8'));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validatePlugin = ajv.compile(pluginSchema);
  const validateMcp = ajv.compile(mcpSchema);

  assert.equal(plugin.conformanceUnknown, true);
  assert.equal(plugin.extensions, false);
  assert.equal(validatePlugin(plugin), false);
  assert.deepEqual(validatePlugin.errors.map(({ instancePath, keyword, params }) => ({ instancePath, keyword, params })), [
    { instancePath: '', keyword: 'additionalProperties', params: { additionalProperty: 'conformanceUnknown' } },
    { instancePath: '/extensions', keyword: 'type', params: { type: 'object' } },
  ]);
  const validPlugin = { ...plugin, extensions: {} };
  delete validPlugin.conformanceUnknown;
  assert.equal(validatePlugin(validPlugin), true, JSON.stringify(validatePlugin.errors));

  assert.deepEqual(mcp.mcpServers['recovery-invalid'], { type: 'stdio' });
  assert.deepEqual(mcp.mcpServers['recovery-valid'], {
    type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/dist/probe.mjs'],
  });
  assert.equal(validateMcp(mcp), false);
  assert.ok(validateMcp.errors.every(({ instancePath }) => instancePath.startsWith('/mcpServers/recovery-invalid')),
    JSON.stringify(validateMcp.errors));
  assert.ok(validateMcp.errors.some(({ keyword, params }) => keyword === 'required' && params.missingProperty === 'command'));
  const validMcp = structuredClone(mcp);
  delete validMcp.mcpServers['recovery-invalid'];
  assert.equal(validateMcp(validMcp), true, JSON.stringify(validateMcp.errors));
});

test('recovery fixture has one valid skill witness and one skill missing only description', async () => {
  const root = new URL('../plugins/agent-plugins-conformance-recovery/skills/', import.meta.url);
  assert.deepEqual((await readdir(root)).sort(), ['conformance-recovery-invalid', 'conformance-recovery-valid']);
  const valid = await readFile(new URL('conformance-recovery-valid/SKILL.md', root), 'utf8');
  assert.match(valid, /^name: conformance-recovery-valid$/m);
  assert.match(valid, /^description: .+$/m);
  assert.match(valid, /APC_RECOVERY_VALID_V1/);

  const invalid = await readFile(new URL('conformance-recovery-invalid/SKILL.md', root), 'utf8');
  assert.match(invalid, /^---\nname: conformance-recovery-invalid\n---\n/);
  // The Agent Skills specification requires `description` in frontmatter:
  // https://agentskills.io/specification
  assert.doesNotMatch(invalid.split('---', 3)[1], /^description:/m);
});

test('malformed MCP fixture has a syntactically invalid document and one valid skill witness', async () => {
  const root = new URL('../plugins/agent-plugins-conformance-invalid-mcp/', import.meta.url);
  const mcp = await readFile(new URL('mcp.json', root), 'utf8');
  assert.throws(() => JSON.parse(mcp), SyntaxError);
  assert.deepEqual(await readdir(new URL('skills/', root)), ['conformance-invalid-mcp-valid']);
  const skill = await readFile(new URL('skills/conformance-invalid-mcp-valid/SKILL.md', root), 'utf8');
  assert.match(skill, /^---\nname: conformance-invalid-mcp-valid\ndescription: .+\n---\n/);
  assert.match(skill, /APC_INVALID_MCP_VALID_V1/);
  for (const file of ['LICENSE.md', 'LICENSES/Apache-2.0.txt', 'LICENSES/CC-BY-4.0.txt']) {
    assert.equal(await readFile(new URL(file, root), 'utf8'), await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
  }
});
