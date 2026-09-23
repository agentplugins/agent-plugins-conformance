# Agent Plugins Conformance — Recovery

This fixture checks how clients handle invalid configuration while keeping valid plugin features available.

Install it alongside the other suite plugins and follow the [run instructions](../agent-plugins-conformance/#run-through-a-client).

| Case ID | Covered behavior |
| --- | --- |
| `skills.recovery.valid-skill-available` | The valid `conformance-recovery-valid` skill remains available under the combined configuration. |
| `mcp.stdio.recovery.valid-server-available` | The valid `recovery-valid` stdio MCP server remains available under the combined configuration. |
| `mcp.stdio.cwd.invalid-form` | A server whose working directory uses an invalid path form is excluded. |
| `mcp.stdio.cwd.plugin-relative-escape` | A server whose plugin-relative working directory escapes the plugin root is excluded. |
| `mcp.stdio.cwd.plugin-data-escape` | A server whose data-rooted working directory escapes the plugin data directory is excluded. |
| `filesystem.containment.cwd-symlink-escape` | A server whose working directory escapes the plugin root through a symlink is excluded. |
| `mcp.stdio.config.unknown-field` | A server with an unknown configuration field is excluded. |
| `mcp.config.missing-type` | A server without an explicit transport type is excluded. |
| `mcp.config.legacy-http-type` | A server using the legacy `http` transport type is excluded. |
| `mcp.stdio.env.reserved-plugin-root` | A server that configures `PLUGIN_ROOT` in its `env` is excluded. |
| `mcp.stdio.env.reserved-plugin-data` | A server that configures `PLUGIN_DATA` in its `env` is excluded. |
| `mcp.streamable-http.url.relative` | An HTTP server with a scheme-relative URL (`//host/path`) is excluded. |
| `mcp.streamable-http.url.fragment` | An HTTP server whose URL contains a fragment is excluded. |
| `mcp.streamable-http.url.userinfo` | An HTTP server whose URL contains user information is excluded. |
| `mcp.streamable-http.headers.duplicate-names` | An HTTP server with header names that duplicate one another under different casing is excluded. |
| `mcp.streamable-http.headers.invalid-name` | An HTTP server with an invalid configured header name is excluded. |
| `mcp.streamable-http.headers.invalid-value` | An HTTP server with an invalid configured header value is excluded. |
| `mcp.sse.url.relative` | A legacy HTTP+SSE server with a scheme-relative URL (`//host/path`) is excluded. |
| `mcp.sse.url.fragment` | A legacy HTTP+SSE server whose URL contains a fragment is excluded. |
| `mcp.sse.url.userinfo` | A legacy HTTP+SSE server whose URL contains user information is excluded. |
| `mcp.sse.headers.duplicate-names` | A legacy HTTP+SSE server with header names that duplicate one another under different casing is excluded. |
| `mcp.sse.headers.invalid-name` | A legacy HTTP+SSE server with an invalid configured header name is excluded. |
| `mcp.sse.headers.invalid-value` | A legacy HTTP+SSE server with an invalid configured header value is excluded. |

The availability checks exercise the combined configuration. They do not evaluate diagnostics, determine how the client treated individual invalid entries, or isolate the effect of each invalid field or entry.
