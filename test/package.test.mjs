import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';

for (const file of ['plugin', 'mcp']) {
  test(`${file}.json conforms to the pinned Agent Plugins 1.0.0 schema`, async () => {
    const schema = JSON.parse(await readFile(new URL(`schemas/${file}.schema.json`, import.meta.url), 'utf8'));
    const value = JSON.parse(await readFile(new URL(`../plugins/core/${file}.json`, import.meta.url), 'utf8'));
    const validate = new Ajv2020({ strict: false }).compile(schema);
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
  });
}

test('plugin and MCP target the same published specification version', async () => {
  const load = async (name) => JSON.parse(await readFile(new URL(`../plugins/core/${name}.json`, import.meta.url), 'utf8'));
  assert.equal((await load('plugin')).$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal((await load('mcp')).$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
});
