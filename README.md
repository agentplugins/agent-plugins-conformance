# Agent Plugins conformance suite

Plugins for collecting evidence about client support for [Agent Plugins](https://agent-plugins.org/). Results describe the observed run and covered cases; they are not whole-client certification.

## Run the checks

Node.js 22 or newer must be available as `node` on the client's executable search path, and the agent must be able to execute commands. The packaged plugins require no build or dependency installation. Each directory below is an installable plugin; the repository root is the development project.

The suite includes these plugins:

| Plugin directory | Purpose |
| --- | --- |
| [`plugins/agent-plugins-conformance`](plugins/agent-plugins-conformance/) | The `run-conformance` skill and JSON reporting tools |
| [`plugins/agent-plugins-conformance-core`](plugins/agent-plugins-conformance-core/) | Fixtures for skill discovery, stdio MCP behavior, and optional Streamable HTTP checks |
| [`plugins/agent-plugins-conformance-recovery`](plugins/agent-plugins-conformance-recovery/) | Fixtures for handling invalid configuration |
| [`plugins/agent-plugins-conformance-invalid-mcp`](plugins/agent-plugins-conformance-invalid-mcp/) | A valid skill alongside a malformed MCP document |

To include the optional Streamable HTTP checks, follow the [Core fixture's HTTP setup](plugins/agent-plugins-conformance-core/#optional-http-setup) **before the client loads the plugins**. This starts a bundled local server in a separate terminal; CI can launch the same command. Without the server, HTTP checks remain `not_verified` and the agent continues collecting the other checks.

Install and load the plugins through the client's Agent Plugins support, then ask the agent:

> Run the run-conformance skill from Agent Plugins Conformance and save the JSON report to /tmp/agent-plugins-conformance/report.json.

The [Agent Plugins Conformance instructions](plugins/agent-plugins-conformance/README.md) explain collection, JSON results, acceptance queries, and the optional summary command for saved reports. Each fixture’s README, linked in the table above, describes its covered cases and limits.

## Development

Run these commands from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm check
```

The root development package builds and tests the plugins.

Unit and integration tests exercise the packaged MCP probes through the official MCP SDK and invoke the skill-local reporting scripts. Their harness expands configuration and launches servers itself.

CI also runs a pinned Codex client on Ubuntu and Windows. It installs the unchanged Core, Recovery, and reporting plugins, starts the HTTP fixture, collects MCP observations through Codex's native runtime, and checks the saved report's MCP results. The JSON report and client diagnostics are retained as CI artifacts. This smoke test requires no API key or model turn; it does not exercise an agent following the guiding skill.
