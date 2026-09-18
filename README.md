# Agent Plugins conformance suite

Plugins for collecting evidence about client support for [Agent Plugins](https://agent-plugins.org/). Results describe the observed run and covered cases; they are not whole-client certification.

## Run the checks

Install all three plugins through the client's Agent Plugins support:

| Plugin directory | Purpose |
| --- | --- |
| [`plugins/agent-plugins-conformance`](plugins/agent-plugins-conformance/) | The `run-conformance` skill and JSON reporting tools |
| [`plugins/agent-plugins-conformance-core`](plugins/agent-plugins-conformance-core/) | Fixtures for skill discovery and stdio MCP behavior |
| [`plugins/agent-plugins-conformance-recovery`](plugins/agent-plugins-conformance-recovery/) | Fixtures for valid skill and MCP availability alongside invalid configuration |

Node.js 22 or newer must be available as `node` on the client's executable search path, and the agent must be able to execute commands. The packaged plugins require no build or dependency installation. Each directory above is an installable plugin; the repository root is the development project.

Then ask the agent:

> Run the run-conformance skill from Agent Plugins Conformance and save the JSON report to /tmp/agent-plugins-conformance/report.json.

The [Agent Plugins Conformance instructions](plugins/agent-plugins-conformance/README.md) explain collection, JSON results, acceptance queries, and the optional summary command for saved reports. The [Core fixture documentation](plugins/agent-plugins-conformance-core/README.md) and [Recovery fixture documentation](plugins/agent-plugins-conformance-recovery/README.md) describe the covered cases and their limits.

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
