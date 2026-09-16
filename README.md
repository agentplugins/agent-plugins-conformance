# Agent Plugins conformance suite

Plugins for collecting evidence about client support for [Agent Plugins](https://agent-plugins.org/). Each plugin contains its own fixtures and reporting instructions. Results describe the observed run and covered cases; they are not whole-client certification.

## Plugins

| Plugin | Coverage |
| --- | --- |
| [Core](plugins/core/) | Skill discovery, MCP tool availability, working directories, and selected subprocess environment and placeholder rules |

Install **`plugins/core`** through the client's Agent Plugins support. The repository root is the development project; each directory under `plugins/` is an installable plugin. See the [core plugin instructions](plugins/core/README.md) to collect observations and evaluate a run.

The core plugin requires Node.js 22 or newer as `node` on the client's executable search path. Its committed MCP bundle and CLI reporter run without a build or dependency installation.

## Development

Run these commands from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm check
```

The root development package builds and tests the plugins. To evaluate saved core observations from the repository root, run `pnpm report observations.json` (add `--json` for the structured report).

See [verification scope](docs/verification.md) for the automated integration boundaries and native portable-plugin exercise.
