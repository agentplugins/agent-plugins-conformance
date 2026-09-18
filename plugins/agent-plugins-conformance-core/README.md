# Agent Plugins Conformance — Core

A fixture plugin for testing skill discovery and stdio MCP behavior through a client's native [Agent Plugins](https://agent-plugins.org/) support.

Install this fixture alongside [Agent Plugins Conformance](../agent-plugins-conformance/), whose `run-conformance` skill collects observations and saves the results. See that plugin's [run instructions](../agent-plugins-conformance/#run-through-a-client) and [report documentation](../agent-plugins-conformance/#read-the-results).

Node.js 22 or newer must be available as `node` on the client's executable search path. The committed MCP bundle includes the official MCP SDK and requires no dependency installation or build.

## Coverage

| Case IDs | What the check establishes |
| --- | --- |
| `skills.discovery.immediate-children` | The agent reports the expected markers for both immediate child skills loaded through the client. Discovery depends on that account. |
| `mcp.stdio.tool-availability.cwd-omitted`, `mcp.stdio.tool-availability.cwd-plugin-relative`, `mcp.stdio.tool-availability.cwd-plugin-root`, `mcp.stdio.tool-availability.cwd-plugin-data` | Each server returned a valid observation. |
| `mcp.stdio.cwd.omitted` | Omitted `cwd` uses the package root. |
| `mcp.stdio.cwd.plugin-relative`, `mcp.stdio.cwd.plugin-root` | Relative and root-placeholder `cwd` resolve to `probe-workdir`. |
| `mcp.stdio.cwd.plugin-data` | Data-placeholder `cwd` matches the data path resolved by the probe. |
| `mcp.stdio.env.plugin-root` | Supplied `PLUGIN_ROOT` matches the independently determined package root. |
| `mcp.stdio.env.plugin-data-absolute` | Supplied `PLUGIN_DATA` is an absolute path. This check does not exercise writability, storage dedication, or persistence across updates. |
| `mcp.stdio.data.writable` | The default server can create, write, and close a small temporary file directly in the supplied `PLUGIN_DATA` directory. |
| `mcp.stdio.env.configured-value` | The configured value reaches the subprocess. The fixture does not arrange a conflicting inherited value, so it does not establish override behavior. |
| `mcp.stdio.args.preservation-and-expansion` | Argument boundaries, including spaces and an empty argument, are preserved; recognized placeholders expand and unknown placeholder-like text stays literal. |
| `mcp.stdio.env.expansion` | Repeated recognized placeholders expand in environment values and unknown placeholder-like text stays literal. |

This plugin exercises valid stdio configurations; invalid configuration handling, failure isolation, and remote MCP transports are outside its coverage.
