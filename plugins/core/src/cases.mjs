export const CASES = Object.freeze([
  ['skills.guide', 'skills', 'Guide skill marker', ['6.1', '7.1']],
  ['skills.alpha', 'skills', 'Alpha skill marker', ['6.1', '7.1']],
  ['skills.beta', 'skills', 'Beta skill marker', ['6.1', '7.1']],
  ...['default', 'relative', 'root', 'data'].flatMap((server) => [
    [`mcp.${server}.tool`, 'mcp', `${server} MCP tool evidence`, ['6.1', '7.2.1']],
    [`mcp.${server}.cwd`, 'mcp', `${server} working directory`, ['7.2.1']],
  ]),
  ['stdio.root', 'mcp', 'Plugin root environment', ['9.1']],
  ['stdio.data', 'mcp', 'Plugin data environment', ['9.1']],
  ['stdio.env', 'mcp', 'Configured environment', ['9.1']],
  ['stdio.args', 'mcp', 'Argument preservation and expansion', ['7.2.1', '9.2']],
  ['stdio.expansion', 'mcp', 'Environment expansion', ['9.2']],
].map(([id, category, label, specSections]) => Object.freeze({
  id, label, category, specSections: Object.freeze(specSections),
})));

export const CASE_IDS = Object.freeze(CASES.map(({ id }) => id));
