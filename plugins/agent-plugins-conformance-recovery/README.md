# Agent Plugins Conformance — Recovery

This fixture checks how clients handle invalid configuration while keeping valid plugin features available.

Install it alongside the other suite plugins and follow the [run instructions](../agent-plugins-conformance/#run-through-a-client).

| Case ID | Covered behavior | Specification |
| --- | --- | --- |
| `skills.recovery.valid-skill-available` | The valid `conformance-recovery-valid` skill remains available under the combined configuration. | [§5.2][], [§7.1][], [§7.2.2][], [§8.1][] |
| `mcp.stdio.recovery.valid-server-available` | The valid `recovery-valid` stdio MCP server remains available under the combined configuration. | [§5.2][], [§7.1][], [§7.2.2][], [§8.1][] |
| `mcp.stdio.cwd.invalid-form` | A server whose working directory uses an invalid path form is excluded. | [§7.2.1][], [§7.2.2][] |
| `mcp.stdio.cwd.plugin-relative-escape` | A server whose plugin-relative working directory escapes the plugin root is excluded. | [§4.1][], [§7.2.1][], [§7.2.2][] |
| `mcp.stdio.cwd.plugin-data-escape` | A server whose data-rooted working directory escapes the plugin data directory is excluded. | [§7.2.1][], [§7.2.2][] |
| `filesystem.containment.cwd-symlink-escape` | A server whose working directory escapes the plugin root through a symlink is excluded. | [§4.1][], [§7.2.1][], [§7.2.2][] |
| `filesystem.containment.mcp-command-symlink-escape` | An MCP server whose command resolves outside the plugin root through a symlink is excluded. | [§4.1][], [§7.2.1][], [§7.2.2][] |
| `mcp.stdio.config.unknown-field` | A server with an unknown configuration field is excluded. | [§7.2.1][], [§7.2.2][] |
| `mcp.config.missing-type` | A server without an explicit transport type is excluded. | [§7.2.1][], [§7.2.2][] |
| `mcp.config.legacy-http-type` | A server using the legacy `http` transport type is excluded. | [§7.2.1][], [§7.2.2][] |
| `mcp.stdio.env.reserved-plugin-root` | A server that configures `PLUGIN_ROOT` in its `env` is excluded. | [§7.2.2][], [§9.2][] |
| `mcp.stdio.env.reserved-plugin-data` | A server that configures `PLUGIN_DATA` in its `env` is excluded. | [§7.2.2][], [§9.2][] |
| `mcp.streamable-http.url.non-loopback-http` | An HTTP server using plaintext HTTP with a non-loopback URL host is excluded. | [§7.2.1][], [§7.2.2][] |
| `mcp.streamable-http.url.relative` | An HTTP server with a scheme-relative URL (`//host/path`) is excluded. | [§7.2.1][], [§7.2.2][] |
| `mcp.streamable-http.url.fragment` | An HTTP server whose URL contains a fragment is excluded. | [§7.2.1][], [§7.2.2][] |
| `mcp.streamable-http.url.userinfo` | An HTTP server whose URL contains user information is excluded. | [§7.2.1][], [§7.2.2][] |
| `mcp.streamable-http.headers.duplicate-names` | An HTTP server with header names that duplicate one another under different casing is excluded. | [§7.2.1][], [§7.2.2][] |
| `mcp.streamable-http.headers.invalid-name` | An HTTP server with an invalid configured header name is excluded. | [§7.2.1][], [§7.2.2][] |
| `mcp.streamable-http.headers.invalid-value` | An HTTP server with an invalid configured header value is excluded. | [§7.2.1][], [§7.2.2][] |
| `mcp.sse.url.non-loopback-http` | A legacy HTTP+SSE server using plaintext HTTP with a non-loopback URL host is excluded. | [§7.2.1][], [§7.2.2][] |
| `mcp.sse.url.relative` | A legacy HTTP+SSE server with a scheme-relative URL (`//host/path`) is excluded. | [§7.2.1][], [§7.2.2][] |
| `mcp.sse.url.fragment` | A legacy HTTP+SSE server whose URL contains a fragment is excluded. | [§7.2.1][], [§7.2.2][] |
| `mcp.sse.url.userinfo` | A legacy HTTP+SSE server whose URL contains user information is excluded. | [§7.2.1][], [§7.2.2][] |
| `mcp.sse.headers.duplicate-names` | A legacy HTTP+SSE server with header names that duplicate one another under different casing is excluded. | [§7.2.1][], [§7.2.2][] |
| `mcp.sse.headers.invalid-name` | A legacy HTTP+SSE server with an invalid configured header name is excluded. | [§7.2.1][], [§7.2.2][] |
| `mcp.sse.headers.invalid-value` | A legacy HTTP+SSE server with an invalid configured header value is excluded. | [§7.2.1][], [§7.2.2][] |

The availability checks exercise the combined configuration. They do not evaluate diagnostics, determine how the client treated individual invalid entries, or isolate the effect of each invalid field or entry.

[§4.1]: https://github.com/agentplugins/agent-plugins-spec/blob/v1.0.0/spec/1.0.0.md#41-general-requirements
[§5.2]: https://github.com/agentplugins/agent-plugins-spec/blob/v1.0.0/spec/1.0.0.md#52-manifest-object
[§7.1]: https://github.com/agentplugins/agent-plugins-spec/blob/v1.0.0/spec/1.0.0.md#71-skills
[§7.2.1]: https://github.com/agentplugins/agent-plugins-spec/blob/v1.0.0/spec/1.0.0.md#721-discovery-and-configuration
[§7.2.2]: https://github.com/agentplugins/agent-plugins-spec/blob/v1.0.0/spec/1.0.0.md#722-loading-rules
[§8.1]: https://github.com/agentplugins/agent-plugins-spec/blob/v1.0.0/spec/1.0.0.md#81-manifest-extension-data
[§9.2]: https://github.com/agentplugins/agent-plugins-spec/blob/v1.0.0/spec/1.0.0.md#92-placeholder-expansion
