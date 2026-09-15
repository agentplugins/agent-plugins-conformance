export const CASES = Object.freeze([
  ['skills.guide', 'Guide skill marker', ['6.1', '7.1']],
  ['skills.alpha', 'Alpha skill marker', ['6.1', '7.1']],
  ['skills.beta', 'Beta skill marker', ['6.1', '7.1']],
  ...['default', 'relative', 'root', 'data'].flatMap((server) => [
    [`mcp.${server}.tool`, `${server} MCP tool evidence`, ['6.1', '7.2.1']],
    [`mcp.${server}.cwd`, `${server} working directory`, ['7.2.1']],
  ]),
  ['stdio.root', 'Plugin root environment', ['9.1']],
  ['stdio.data', 'Plugin data environment', ['9.1']],
  ['stdio.env', 'Configured environment', ['9.1']],
  ['stdio.args', 'Argument preservation and expansion', ['7.2.1', '9.2']],
  ['stdio.expansion', 'Environment expansion', ['9.2']],
].map(([id, label, specSections]) => Object.freeze({ id, label, specSections: Object.freeze(specSections) })));

export const CASE_IDS = Object.freeze(CASES.map(({ id }) => id));
