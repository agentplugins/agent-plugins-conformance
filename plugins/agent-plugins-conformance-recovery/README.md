# Agent Plugins Conformance — Recovery

This fixture checks how clients handle invalid configuration while keeping valid plugin features available.

Install it alongside the other suite plugins and follow the [run instructions](../agent-plugins-conformance/#run-through-a-client).

| Case ID | Covered behavior |
| --- | --- |
| `skills.recovery.valid-skill-available` | The valid `conformance-recovery-valid` skill remains available under the combined configuration. |
| `mcp.stdio.recovery.valid-server-available` | The valid `recovery-valid` stdio MCP server remains available under the combined configuration. |
| `mcp.stdio.cwd.plugin-relative-escape` | A server whose plugin-relative working directory escapes the plugin root is excluded. |

The availability checks exercise the combined configuration. They do not evaluate diagnostics, determine how the client treated individual invalid entries, or isolate the effect of each invalid field or entry.
