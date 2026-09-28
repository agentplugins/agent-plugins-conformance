# Agent Plugins Conformance — Core

A fixture plugin for collecting evidence about a client's native [Agent Plugins](https://agent-plugins.org/) support.

Install this fixture alongside [Agent Plugins Conformance](../agent-plugins-conformance/), whose `run-conformance` skill collects observations and saves the results. See that plugin's [run instructions](../agent-plugins-conformance/#run-through-a-client) and [report documentation](../agent-plugins-conformance/#read-the-results).

Node.js 22 or newer must be available as `node` on the client's executable search path. The committed MCP bundle includes the official MCP SDK and requires no dependency installation or build.

The command-token check includes POSIX and Windows servers. Only the server for the current platform is expected to run; the other may produce a startup error.

## Optional HTTP setup

To include checks for MCP servers using Streamable HTTP or legacy HTTP+SSE, start the bundled server in a separate terminal **before the client loads the plugin**:

```sh
node '/absolute/path/to/agent-plugins-conformance-core/dist/serve-http.mjs'
```

Replace the path with a downloaded or installed copy of this plugin; the command needs no build or dependency installation. Wait for the `ready` message before loading the plugin. The server listens on `127.0.0.1:43187` and `127.0.0.1:43189`. Leave it running during collection, then press Ctrl-C to stop it. CI can launch the same command before starting the client and terminate the process afterward.

## Coverage

| Case IDs | What the check establishes | Specification |
| --- | --- | --- |
| `skills.discovery.immediate-children` | The agent reports the expected markers for both valid immediate-child skills loaded through the client and that the nested `conformance-nested` reference was not advertised as a separate skill. Discovery depends on that account. | [§6.1][], [§7.1][] |
| `mcp.stdio.tool-availability.cwd-omitted`, `mcp.stdio.tool-availability.cwd-plugin-relative`, `mcp.stdio.tool-availability.cwd-plugin-root`, `mcp.stdio.tool-availability.cwd-plugin-data` | Each server returned a valid observation. | [§6.1][], [§7.2.1][] |
| `mcp.stdio.cwd.omitted` | Omitted `cwd` uses the package root. | [§7.2.1][] |
| `mcp.stdio.cwd.plugin-relative`, `mcp.stdio.cwd.plugin-root` | Relative and root-placeholder `cwd` resolve to `probe-workdir`. | [§7.2.1][] |
| `mcp.stdio.cwd.plugin-data` | Data-placeholder `cwd` matches the data path resolved by the probe. | [§7.2.1][] |
| `mcp.stdio.env.plugin-root` | Supplied `PLUGIN_ROOT` matches the independently determined package root. | [§9.1][] |
| `mcp.stdio.env.plugin-data-absolute` | Supplied `PLUGIN_DATA` is an absolute path. This check does not exercise writability, storage dedication, or persistence across updates. | [§9.1][] |
| `filesystem.data.writable` | The default server can create, write, and close a small temporary file directly in the supplied `PLUGIN_DATA` directory. | [§9.1][] |
| `filesystem.data.consistent-within-plugin` | Servers using omitted and data-rooted working directories resolve `PLUGIN_DATA` to the same filesystem path. | [§9.1][] |
| `mcp.stdio.env.configured-value` | The configured value reaches the subprocess. | [§9.1][] |
| `mcp.stdio.env.configured-precedence` | Configured environment values replace conflicting base-environment values. | [§9.1][] |
| `mcp.stdio.args.preservation-and-expansion` | Argument boundaries, including spaces and an empty argument, are preserved; recognized placeholders expand and unknown placeholder-like text stays literal. | [§7.2.1][], [§9.2][] |
| `mcp.stdio.command.single-token` | A command path containing a space is preserved as a single executable token. | [§7.2.1][] |
| `mcp.stdio.command.plugin-relative-resolution` | Plugin-relative commands resolve against the plugin root, independently of the configured working directory. | [§7.2.1][] |
| `mcp.stdio.env.expansion` | Repeated recognized placeholders expand in environment values and unknown placeholder-like text stays literal. | [§9.2][] |
| `mcp.streamable-http.tool-availability` | The client exposes the HTTP tool and it returns a valid observation despite a conflicting, mixed-case configured `Accept` header. A completed discovery or call attempt with no observation fails this check only when the reporter confirms that the local fixture is healthy. | [§6.1][], [§7.2.1][] |
| `mcp.streamable-http.url.literal-route-and-query` | The configured URL path and query are preserved literally. | [§7.2.1][] |
| `mcp.streamable-http.headers.literal-value` | Configured header values preserve placeholder-like text and spaces literally. | [§7.2.1][] |
| `mcp.streamable-http.headers.cross-origin-redirect` | Configured headers are not forwarded to another origin without authorization. | [§7.2.1][] |
| `mcp.sse.tool-availability` | The client exposes the legacy HTTP+SSE tool and it returns a valid observation. | [§6.1][], [§7.2.1][] |
| `mcp.sse.url.literal-route-and-query` | The configured URL path and query are preserved literally. | [§7.2.1][] |
| `mcp.sse.headers.literal-value` | The initial connection preserves the configured header value literally. | [§7.2.1][] |
| `mcp.sse.headers.literal-post-value` | Message requests to the configured origin preserve the configured header value literally. | [§7.2.1][] |
| `mcp.sse.headers.generated-precedence` | A client-generated `Accept` header takes precedence over a conflicting configured value. | [§7.2.1][] |
| `mcp.sse.headers.cross-origin-redirect` | Configured headers are not forwarded to another origin through an HTTP redirect without authorization. | [§7.2.1][] |
| `mcp.sse.headers.cross-origin-endpoint` | Configured headers are not forwarded to another origin through an SSE endpoint event without authorization. | [§7.2.1][] |

Legacy HTTP+SSE support is optional. Missing or inconclusive SSE evidence remains `not_verified`, even when the helper is running. An explicit native refusal to follow a cross-origin redirect or endpoint event can establish header protection.

[§6.1]: https://github.com/agentplugins/agent-plugins-spec/blob/v1.0.0/spec/1.0.0.md#61-fixed-locations
[§7.1]: https://github.com/agentplugins/agent-plugins-spec/blob/v1.0.0/spec/1.0.0.md#71-skills
[§7.2.1]: https://github.com/agentplugins/agent-plugins-spec/blob/v1.0.0/spec/1.0.0.md#721-discovery-and-configuration
[§9.1]: https://github.com/agentplugins/agent-plugins-spec/blob/v1.0.0/spec/1.0.0.md#91-subprocess-environment
[§9.2]: https://github.com/agentplugins/agent-plugins-spec/blob/v1.0.0/spec/1.0.0.md#92-placeholder-expansion
