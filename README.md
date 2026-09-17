# Agent Plugins conformance suite

Plugins for collecting evidence about client support for [Agent Plugins](https://agent-plugins.org/). Each plugin contains its own fixtures and reporting instructions. Results describe the observed run and covered cases; they are not whole-client certification.

## Plugins

| Plugin | Coverage |
| --- | --- |
| [Agent Plugins Conformance — Core](plugins/agent-plugins-conformance-core/) | Skill discovery, MCP tool availability, working directories, and selected subprocess environment and placeholder rules |

Install **`plugins/agent-plugins-conformance-core`** through the client's Agent Plugins support. Each directory under `plugins/` is an installable plugin; the repository root is the development project.

The core plugin requires Node.js 22 or newer as `node` on the client's executable search path. Its committed MCP bundle and skill-local reporting scripts run without a build or dependency installation. Ask the agent to run its `conformance-guide` skill and save the report to an absolute path:

> Run the conformance-guide skill from Agent Plugins Conformance — Core and save the JSON report to /tmp/agent-plugins-conformance/report.json.

The [core plugin instructions](plugins/agent-plugins-conformance-core/README.md) explain collection, the JSON results, acceptance queries, and an optional summary command for saved reports.

## Development

Run these commands from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm check
```

The root development package builds and tests the plugins.

Automated tests exercise the packaged MCP probes through the official MCP SDK and invoke the skill-local reporting scripts. The test harness expands configuration and launches servers itself; these tests do not exercise a client's native plugin loader.
