# Core conformance plugin

A portable [Agent Plugins](https://agent-plugins.org/) plugin for collecting evidence about a small set of client behaviors. It provides three [Agent Skills](https://agentskills.io/specification) and four stdio MCP servers. A deterministic reporter evaluates the observations against fixed fixtures.

This initial release covers skill discovery, MCP tool availability, working directories, and selected subprocess environment and placeholder rules. Results describe this run and these cases; they are not whole-client certification.

## Run through a client

1. Make Node.js 22 or newer available as `node` on the client's executable search path. The committed MCP bundle includes the official MCP SDK; using the plugin requires no dependency installation or build.
2. Install this directory through the client's Agent Plugins support so its loader discovers the root-level `plugin.json`, `mcp.json`, and plugin components.
3. Ask the agent to run the plugin's `conformance-guide` skill and supply `outputPath`, an absolute path for the JSON report. The agent must be able to execute commands.

The [conformance guide](skills/conformance-guide/SKILL.md) is the canonical collection procedure. Its reporting script initializes the destination, then records each skill marker and MCP probe observation as it arrives. It evaluates the accumulated evidence and updates the JSON file directly, with only brief acknowledgments returned to the agent. Missing parent directories are created. Starting a new run replaces any previous report at the requested path; concurrently active runs need different output paths. No run ID or intermediate observations file is required.

When collection ends, the agent identifies the report location and any collection limitations. Human-readable presentation is optional, as described below.

## Use the results

Read the JSON file at the requested `outputPath` after the guide finishes. There is no need to extract JSON from the agent's response. The report preserves the latest observation recorded for each skill or server and includes a flat `results` array. A saved report may also be an incomplete snapshot if collection was interrupted; file existence alone is not a completion signal.

Cases are `pass`, `fail`, or `not_verified`. Missing observations do not by themselves establish failure or exemption from the specification. Skill discovery passes when all three markers are correct, fails if any supplied marker is wrong, and otherwise remains `not_verified`. The reporter trusts the collecting agent's account of discovery; matching markers are not independent proof of the loading route. Consumers decide which results to require.

### Query results

Each result has an `id`, human-readable `label`, `status`, `detail`, and `specSections`. IDs form a hierarchy: `skills.*` covers skills and `mcp.stdio.*` covers stdio MCP behavior. Prefix queries include new checks added within the selected scope.

For example, require all stdio MCP checks to pass (replace `/absolute/path/to/report.json` with your output path):

```sh
jq -e '
  [.results[] | select(.id | startswith("mcp.stdio."))]
  | length > 0 and all(.[]; .status == "pass")
' '/absolute/path/to/report.json'
```

The trailing dot selects a complete namespace segment. The nonempty check prevents a misspelled or absent scope from succeeding without evaluating any cases. To exclude a particular check, change the selection to `select((.id | startswith("mcp.stdio.")) and .id != "mcp.stdio.env.plugin-data-absolute")`. To require only particular checks, select their IDs and verify that each requested ID is present.

List unresolved checks with their descriptions:

```sh
jq '.results[] | select(.status != "pass") | {id, label, status, detail}' '/absolute/path/to/report.json'
```

### Summarize a saved report

The read-only summarizer renders the outcomes already saved in a JSON report. It neither changes the file nor re-evaluates observations. Users and CI can invoke it when a human-readable view is useful; the collecting agent does not invoke it automatically.

From a checkout of the conformance repository, run:

```sh
node plugins/core/skills/conformance-guide/scripts/summarize.mjs '/absolute/path/to/report.json'
```

For an installed plugin, the script is at `skills/conformance-guide/scripts/summarize.mjs` relative to its known installation path. If you do not know that path, ask the agent for the exact command resolved from its client-loaded guide, or ask it to summarize the saved report.

These shell examples quote a POSIX-style absolute path; use an absolute path and quoting appropriate to your operating system and shell. Reporting and summarizing errors are command failures. A valid report containing `fail` or `not_verified` results is still successfully produced; apply your own acceptance policy to its results.

## Coverage

| Case IDs | Observation checked |
| --- | --- |
| `skills.discovery.immediate-children` | All three immediate child skill markers, with client discovery attested by the collecting agent |
| `mcp.stdio.tool-availability.cwd-omitted`, `mcp.stdio.tool-availability.cwd-plugin-relative`, `mcp.stdio.tool-availability.cwd-plugin-root`, `mcp.stdio.tool-availability.cwd-plugin-data` | A returned observation from each server |
| `mcp.stdio.cwd.omitted` | Omitted `cwd` uses the package root |
| `mcp.stdio.cwd.plugin-relative`, `mcp.stdio.cwd.plugin-root` | Relative and root-placeholder `cwd` resolve to `probe-workdir` |
| `mcp.stdio.cwd.plugin-data` | Data-placeholder `cwd` matches the supplied data directory |
| `mcp.stdio.env.plugin-root` | Supplied `PLUGIN_ROOT` matches the independently determined package root |
| `mcp.stdio.env.plugin-data-absolute` | Supplied `PLUGIN_DATA` is an absolute path |
| `mcp.stdio.env.configured-value` | Configured environment values reach the subprocess |
| `mcp.stdio.args.preservation-and-expansion` | Configured argument values reach the subprocess |
| `mcp.stdio.env.expansion` | Repeated recognized placeholders expand and unknown placeholder-like text stays literal |

These 14 cases are deliberately narrow. An absolute data path does not prove dedicated storage, writability, or persistence across updates. A configured environment value does not prove replacement of a conflicting inherited value. The fixtures do not establish non-recursive replacement when a replacement value itself contains placeholder text. Invalid configurations, failure isolation, and remote MCP transports are deferred.

The `mcp.stdio.env.*` and `mcp.stdio.args.*` checks evaluate the default-server observation. Other server observations establish only tool availability and their configured working directories.
