# Agent Plugins Conformance — Recovery

This fixture checks whether valid plugin features remain available when the same installed plugin also contains invalid configuration.

Install it alongside the other suite plugins and follow the [run instructions](../agent-plugins-conformance/#run-through-a-client).

The plugin manifest includes the invalid fields `conformanceUnknown: true` and `extensions: false`. Its skills include invalid `conformance-recovery-invalid`, which has malformed YAML frontmatter, and valid `conformance-recovery-valid`. Its stdio MCP configuration includes invalid `recovery-invalid`, which omits `command`, and valid `recovery-valid`.

| Case ID | Covered behavior |
| --- | --- |
| `skills.recovery.valid-skill-available` | The valid `conformance-recovery-valid` skill remains available under the combined configuration. |
| `mcp.stdio.recovery.valid-server-available` | The valid `recovery-valid` stdio MCP server remains available under the combined configuration. |

These cases cover only the availability of the valid skill and server in this combined configuration. They do not evaluate diagnostics, determine how the client treated the invalid entries, or isolate the effect of each invalid field or entry.
