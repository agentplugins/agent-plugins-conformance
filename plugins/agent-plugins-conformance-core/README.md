# Agent Plugins Conformance — Core

A fixture plugin for collecting evidence about a client's native [Agent Plugins](https://agent-plugins.org/) support.

Install this fixture alongside [Agent Plugins Conformance](../agent-plugins-conformance/), whose `run-conformance` skill collects observations and saves the results. See that plugin's [run instructions](../agent-plugins-conformance/#run-through-a-client) and [report documentation](../agent-plugins-conformance/#read-the-results).

Node.js 22 or newer must be available as `node` on the client's executable search path. The committed MCP bundle includes the official MCP SDK and requires no dependency installation or build.

## Optional HTTP setup

To include the Streamable HTTP checks, start the bundled server in a separate terminal **before the client loads the plugin**:

```sh
node '/absolute/path/to/agent-plugins-conformance-core/dist/serve-http.mjs'
```

Replace the path with a downloaded or installed copy of this plugin; the command needs no build or dependency installation. Wait for the `ready` message before loading the plugin. The server listens on `127.0.0.1:43187`. Leave it running during collection, then press Ctrl-C to stop it. CI can launch the same command before starting the client and terminate the process afterward.

## Coverage

| Case IDs | What the check establishes |
| --- | --- |
| `skills.discovery.immediate-children` | The agent reports the expected markers for both valid immediate-child skills loaded through the client; the fixture also includes a README-only directory and a nested reference `SKILL.md`. Discovery depends on that account. |
| `mcp.stdio.tool-availability.cwd-omitted`, `mcp.stdio.tool-availability.cwd-plugin-relative`, `mcp.stdio.tool-availability.cwd-plugin-root`, `mcp.stdio.tool-availability.cwd-plugin-data` | Each server returned a valid observation. |
| `mcp.stdio.cwd.omitted` | Omitted `cwd` uses the package root. |
| `mcp.stdio.cwd.plugin-relative`, `mcp.stdio.cwd.plugin-root` | Relative and root-placeholder `cwd` resolve to `probe-workdir`. |
| `mcp.stdio.cwd.plugin-data` | Data-placeholder `cwd` matches the data path resolved by the probe. |
| `mcp.stdio.env.plugin-root` | Supplied `PLUGIN_ROOT` matches the independently determined package root. |
| `mcp.stdio.env.plugin-data-absolute` | Supplied `PLUGIN_DATA` is an absolute path. This check does not exercise writability, storage dedication, or persistence across updates. |
| `mcp.stdio.data.writable` | The default server can create, write, and close a small temporary file directly in the supplied `PLUGIN_DATA` directory. |
| `mcp.stdio.data.consistent-within-plugin` | All four servers resolve `PLUGIN_DATA` to the same path. |
| `mcp.stdio.env.configured-value` | The configured value reaches the subprocess. The fixture does not arrange a conflicting inherited value, so it does not establish override behavior. |
| `mcp.stdio.args.preservation-and-expansion` | Argument boundaries, including spaces and an empty argument, are preserved; recognized placeholders expand and unknown placeholder-like text stays literal. |
| `mcp.stdio.env.expansion` | Repeated recognized placeholders expand in environment values and unknown placeholder-like text stays literal. |
| `mcp.streamable-http.tool-availability` | The client exposes the HTTP tool and it returns a valid observation despite a conflicting, mixed-case configured `Accept` header. A completed discovery or call attempt with no observation fails this check only when the reporter confirms that the local fixture is healthy. |
| `mcp.streamable-http.url.literal-route-and-query` | The tool request reaches `/conformance/mcp` with the single decoded query pair `value=$APC_HTTP_VALUE`, preserving the placeholder-like text literally. |
| `mcp.streamable-http.headers.literal-value` | Configured header values preserve placeholder-like text and spaces literally. |
