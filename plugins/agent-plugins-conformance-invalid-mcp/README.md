# Agent Plugins Conformance — Invalid MCP

This fixture checks whether a valid skill remains available when the same installed plugin has a syntactically malformed `mcp.json`. Its plugin manifest and `conformance-invalid-mcp-valid` skill are valid.

Install it alongside the other suite plugins and follow the [run instructions](../agent-plugins-conformance/#run-through-a-client).

| Case ID | Covered behavior |
| --- | --- |
| `skills.recovery.invalid-mcp-document` | The valid `conformance-invalid-mcp-valid` skill remains available despite the malformed MCP document. |
