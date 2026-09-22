import assert from 'node:assert/strict';
import { lstat, readFile, readlink, readdir, realpath } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  assert.deepEqual(mcp.mcpServers['recovery-cwd-escape'], {
    type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/dist/probe.mjs', 'recovery-cwd-escape'], cwd: './..',
  });
  assert.deepEqual(mcp.mcpServers['recovery-cwd-data-escape'], {
    type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/dist/probe.mjs', 'recovery-cwd-data-escape'],
    cwd: '${PLUGIN_DATA}/..',
  });
  assert.deepEqual(mcp.mcpServers['recovery-cwd-symlink-escape'], {
    type: 'stdio', command: 'node',
    args: ['${PLUGIN_ROOT}/dist/probe.mjs', 'recovery-cwd-symlink-escape'], cwd: './escape-link',
  });
  assert.deepEqual(mcp.mcpServers['recovery-unknown-field'], {
    type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/dist/probe.mjs', 'recovery-unknown-field'],
    conformanceUnknown: true,
  });
  assert.deepEqual(mcp.mcpServers['recovery-env-plugin-root'], {
    type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/dist/probe.mjs', 'recovery-env-plugin-root'],
    env: { PLUGIN_ROOT: '${PLUGIN_ROOT}' },
  });
  assert.deepEqual(mcp.mcpServers['recovery-env-plugin-data'], {
    type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/dist/probe.mjs', 'recovery-env-plugin-data'],
    env: { PLUGIN_DATA: '${PLUGIN_DATA}' },
  });
  assert.deepEqual(mcp.mcpServers['recovery-http-fragment'], {
    type: 'streamable-http',
    url: 'http://127.0.0.1:43187/conformance/recovery-http-fragment#invalid-fragment',
  });
  assert.deepEqual(mcp.mcpServers['recovery-http-duplicate-headers'], {
    type: 'streamable-http',
    url: 'http://127.0.0.1:43187/conformance/recovery-http-duplicate-headers',
    headers: { 'X-Apc-Duplicate': 'first', 'x-apc-duplicate': 'second' },
  });
  assert.deepEqual(mcp.mcpServers['recovery-http-userinfo'], {
    type: 'streamable-http',
    url: 'http://fixture:fixture@127.0.0.1:43187/conformance/recovery-http-userinfo',
  });
  assert.deepEqual(mcp.mcpServers['recovery-http-header-name'], {
    type: 'streamable-http',
    url: 'http://127.0.0.1:43187/conformance/recovery-http-header-name',
    headers: { 'X Apc Fixture': 'fixture' },
  });
  assert.deepEqual(mcp.mcpServers['recovery-http-header-value'], {
    type: 'streamable-http',
    url: 'http://127.0.0.1:43187/conformance/recovery-http-header-value',
    headers: { 'x-apc-fixture': 'first\r\nsecond' },
  });
  const recoveryRoot = fileURLToPath(new URL('../plugins/agent-plugins-conformance-recovery/', import.meta.url));
  const escapeLink = resolve(recoveryRoot, 'escape-link');
  assert.equal((await lstat(escapeLink)).isSymbolicLink(), true);
  assert.equal(await readlink(escapeLink), '..');
  assert.equal(await realpath(escapeLink), await realpath(resolve(recoveryRoot, '..')));
  const symlinkOnlyMcp = {
    $schema: mcp.$schema,
    mcpServers: { 'recovery-cwd-symlink-escape': mcp.mcpServers['recovery-cwd-symlink-escape'] },
  };
  assert.equal(validateMcp(symlinkOnlyMcp), true, JSON.stringify(validateMcp.errors));
  assert.equal(relative(recoveryRoot, resolve(recoveryRoot, mcp.mcpServers['recovery-cwd-escape'].cwd)), '..');
  const dataRoot = resolve(recoveryRoot, 'data root');
  const dataEscape = mcp.mcpServers['recovery-cwd-data-escape'].cwd.replace('${PLUGIN_DATA}', dataRoot);
  assert.equal(relative(dataRoot, resolve(dataEscape)), '..');
  assert.equal(validateMcp(mcp), false);
  assert.ok(validateMcp.errors.every(({ instancePath }) =>
    ['/mcpServers/recovery-invalid', '/mcpServers/recovery-unknown-field',
      '/mcpServers/recovery-env-plugin-root', '/mcpServers/recovery-env-plugin-data']
      .some((prefix) => instancePath.startsWith(prefix))),
    JSON.stringify(validateMcp.errors));
  assert.ok(validateMcp.errors.some(({ keyword, params }) => keyword === 'required' && params.missingProperty === 'command'));
  assert.deepEqual(validateMcp.errors.filter(({ keyword }) => keyword === 'propertyNames')
    .map(({ instancePath, params }) => [instancePath, params.propertyName]), [
    ['/mcpServers/recovery-env-plugin-root/env', 'PLUGIN_ROOT'],
    ['/mcpServers/recovery-env-plugin-data/env', 'PLUGIN_DATA'],
  ]);
  for (const [server, reserved] of [
    ['recovery-env-plugin-root', 'PLUGIN_ROOT'],
    ['recovery-env-plugin-data', 'PLUGIN_DATA'],
  ]) {
    const isolated = { $schema: mcp.$schema, mcpServers: { [server]: structuredClone(mcp.mcpServers[server]) } };
    assert.equal(validateMcp(isolated), false);
    assert.deepEqual(validateMcp.errors.filter(({ keyword }) => keyword === 'propertyNames')
      .map(({ params }) => params.propertyName), [reserved]);
    delete isolated.mcpServers[server].env[reserved];
    assert.equal(validateMcp(isolated), true, JSON.stringify(validateMcp.errors));
  }
  const schemaValidMcp = structuredClone(mcp);
  delete schemaValidMcp.mcpServers['recovery-invalid'];
  assert.equal(validateMcp(schemaValidMcp), false);
  assert.ok(validateMcp.errors.some(({ instancePath, keyword, params }) =>
    instancePath === '/mcpServers/recovery-unknown-field' && keyword === 'additionalProperties' &&
    params.additionalProperty === 'conformanceUnknown'));
  delete schemaValidMcp.mcpServers['recovery-unknown-field'].conformanceUnknown;
  delete schemaValidMcp.mcpServers['recovery-env-plugin-root'].env.PLUGIN_ROOT;
  delete schemaValidMcp.mcpServers['recovery-env-plugin-data'].env.PLUGIN_DATA;
  assert.equal(validateMcp(schemaValidMcp), true, JSON.stringify(validateMcp.errors));
});

test('recovery fixture has one valid skill witness and one skill with malformed frontmatter', async () => {
  const root = new URL('../plugins/agent-plugins-conformance-recovery/skills/', import.meta.url);
  assert.deepEqual((await readdir(root)).sort(), ['conformance-recovery-invalid', 'conformance-recovery-valid']);
  const valid = await readFile(new URL('conformance-recovery-valid/SKILL.md', root), 'utf8');
  assert.match(valid, /^name: conformance-recovery-valid$/m);
  assert.match(valid, /^description: .+$/m);
  assert.match(valid, /APC_RECOVERY_VALID_V1/);

  const invalid = await readFile(new URL('conformance-recovery-invalid/SKILL.md', root), 'utf8');
  assert.match(invalid, /^---\nname: conformance-recovery-invalid\n- description: Intentionally malformed frontmatter\.\n---\n/);
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
