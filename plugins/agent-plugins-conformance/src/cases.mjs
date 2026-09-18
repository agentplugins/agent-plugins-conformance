export const MCP_CWD_VARIANTS = Object.freeze({
  default: 'omitted',
  relative: 'plugin-relative',
  root: 'plugin-root',
  data: 'plugin-data',
});

export const CASES = Object.freeze([
  ['skills.discovery.immediate-children', 'Immediate child skill discovery', ['6.1', '7.1']],
  ...Object.entries(MCP_CWD_VARIANTS).flatMap(([server, variant]) => [
    [`mcp.stdio.tool-availability.cwd-${variant}`, `${server} MCP tool evidence`, ['6.1', '7.2.1']],
    [`mcp.stdio.cwd.${variant}`, `${server} working directory`, ['7.2.1']],
  ]),
  ['mcp.stdio.env.plugin-root', 'Plugin root environment', ['9.1']],
  ['mcp.stdio.env.plugin-data-absolute', 'Plugin data environment', ['9.1']],
  ['mcp.stdio.data.writable', 'Plugin data writability', ['9.1']],
  ['mcp.stdio.data.distinct-across-plugins', 'Distinct data directories across plugins', ['9.1']],
  ['mcp.stdio.data.consistent-within-plugin', 'Consistent data directory within a plugin', ['9.1']],
  ['mcp.stdio.env.configured-value', 'Configured environment', ['9.1']],
  ['mcp.stdio.args.preservation-and-expansion', 'Argument preservation and expansion', ['7.2.1', '9.2']],
  ['mcp.stdio.env.expansion', 'Environment expansion', ['9.2']],
  ['skills.recovery.valid-skill-available', 'Valid skill availability with recoverable invalid configuration', ['5.2', '7.1', '7.2.2', '8.1']],
  ['mcp.stdio.recovery.valid-server-available', 'Valid MCP server availability with recoverable invalid configuration', ['5.2', '7.1', '7.2.2', '8.1']],
].map(([id, label, specSections]) => Object.freeze({
  id, label, specSections: Object.freeze(specSections),
})));

export const CASE_IDS = Object.freeze(CASES.map(({ id }) => id));
