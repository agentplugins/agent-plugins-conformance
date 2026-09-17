# Agent Plugins conformance suite

Plugins for collecting evidence about client support for [Agent Plugins](https://agent-plugins.org/). Each plugin contains its own fixtures and reporting instructions. Results describe the observed run and covered cases; they are not whole-client certification.

## Plugins

| Plugin | Coverage |
| --- | --- |
| [Core](plugins/core/) | Skill discovery, MCP tool availability, working directories, and selected subprocess environment and placeholder rules |

Install **`plugins/core`** through the client's Agent Plugins support. The repository root is the development project; each directory under `plugins/` is an installable plugin. See the [core plugin instructions](plugins/core/README.md) to run the conformance guide and use its results.

The core plugin requires Node.js 22 or newer as `node` on the client's executable search path. Its committed MCP bundle and skill-local reporting scripts run without a build or dependency installation. The guide records results directly at a requested absolute JSON output path; users and CI can optionally render a saved report with the [read-only summarizer](plugins/core/README.md#summarize-a-saved-report).

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
