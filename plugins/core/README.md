# Core conformance plugin

A portable [Agent Plugins](https://agent-plugins.org/) plugin for collecting evidence about a small set of client behaviors. It provides three [Agent Skills](https://agentskills.io/specification) and four stdio MCP servers. A deterministic reporter evaluates the observations against fixed fixtures.

This initial release covers skill discovery, MCP tool availability, working directories, and selected subprocess environment and placeholder rules. Results describe this run and these cases; they are not whole-client certification.

## Run through a client

1. Make Node.js 22 or newer available as `node` on the client's executable search path. The committed MCP bundle includes the official MCP SDK; using the plugin requires no dependency installation or build.
2. Load this directory using the client's Agent Plugins support. The portable manifest and MCP configuration are the root-level `plugin.json` and `mcp.json`.
3. Ask the agent to run the plugin's `conformance-guide` skill. If the client exposes MCP servers but no skills, give the agent the collection procedure below instead.

Use the actual client installation route. Manually starting the servers or injecting skill contents can exercise the fixtures, but cannot demonstrate client discovery. Label such runs `reference`.

## Collect observations

Choose one unique `runId` for the run. Record the client name, version (or `unknown` if unavailable), and a short description of how the client loaded the plugin in `collection.route`.

### Skills

Find `conformance-guide`, `conformance-alpha`, and `conformance-beta` through the client's skill mechanism. This can be a skill activation tool or a client-provided catalog followed by the normal reading of its advertised skill resource. Follow each loaded skill's body to collect its marker:

```json
{"kind":"skill","skill":"conformance-alpha","marker":"<marker from the loaded skill body>"}
```

Only count a skill that the client exposed and whose body the agent actually loaded. Finding a known skill by searching the filesystem, or receiving its contents directly in a prompt, does not establish client discovery. Obtain each marker from its loaded skill body. The reporter trusts the collecting agent's account of discovery; a matching marker is not independent proof of the loading route.

### MCP servers

Find the `observe` tool on each server: `default`, `relative`, `root`, and `data`. Clients may namespace tool names. Call each available tool with the same input:

```json
{"runId":"chosen-unique-run-id"}
```

Each call returns a JSON observation shaped as:

```text
{kind: "runtime", server, evidence: {version: 1, runId, server, root, cwd, resolvedData, argv, env}}
```

Take the observation object from the tool result's `structuredContent` (shown as `structured_content` by some clients), or parse the JSON in its text content. The observation begins with `{"kind":"runtime","server":...}`. Copy that object unchanged into the report's `observations` array; do not include the MCP result wrapper containing `content` or `structuredContent`.

Preserve every observation field. Do not reconstruct expected paths, repair observed values, or replace the returned evidence with a pass/fail judgment. The probe determines its package root from the bundle's location independently of the client's environment variables. It resolves both the observed working directory (`cwd`) and the supplied data directory for directory-identity comparisons; the original environment value is preserved for expansion checks.

Omit observations that you cannot obtain. Describe unavailable skills, missing tools, or failed calls alongside the report. Missing observations become `not_verified`; they do not establish a failure or an exemption from the specification.

## Evaluate a run

Start with this empty-evidence input and replace the run and client details:

```json
{
  "schemaVersion": 1,
  "runId": "chosen-unique-run-id",
  "client": {"name": "Example client", "version": "unknown"},
  "collection": {"kind": "client", "route": "Loaded the directory through the client's plugin support"},
  "observations": []
}
```

`collection` records the collector's account of how the evidence was obtained. Use `kind: "client"` for the client's native plugin loading and `kind: "reference"` for synthetic, harness, or manually configured runs. `route` describes that process in free text. This metadata does not independently authenticate the loading route.

`observations[].kind` identifies the evidence shape: `"skill"` is a loaded skill marker reported by the agent; `"runtime"` is process-launch evidence returned by a probe.

Submit the object to the `default` server's `report` tool as `{"input": <report input object>}`. This supports clients without a local shell. Alternatively, save it as `observations.json` and run from the plugin directory:

```sh
node src/report-cli.mjs observations.json
node src/report-cli.mjs observations.json --json > report.json
```

Both routes use the same evaluator. Cases are `pass`, `fail`, or `not_verified`. The CLI exits 0 when it produces a report, including reports with failures or no observations, and 2 for invalid input or a reporting error. Consumers decide which results to require.

### Query results

The JSON preserves the input observations and includes a flat `results` array. Each result has an `id`, human-readable `label`, `category`, `status`, `detail`, and `specSections`. The categories are `skills` and `mcp`; `mcp` includes subprocess launch checks. New checks join the appropriate category so category queries include them automatically.

For example, require all MCP checks to pass:

```sh
jq -e '
  .results
  | map(select(.category == "mcp"))
  | length > 0 and all(.[]; .status == "pass")
' report.json
```

The nonempty check prevents a misspelled category from succeeding without evaluating any cases. To exclude a particular check, change the selection to `select(.category == "mcp" and .id != "stdio.data")`. To require only particular checks, select their IDs and verify that each requested ID is present.

List unresolved checks with their categories and descriptions:

```sh
jq '.results[] | select(.status != "pass") | {category, id, label, status, detail}' report.json
```

## Coverage

| Case IDs | Observation checked |
| --- | --- |
| `skills.guide`, `skills.alpha`, `skills.beta` | Loaded skill markers, with client discovery attested by the collecting agent |
| `mcp.default.tool`, `mcp.relative.tool`, `mcp.root.tool`, `mcp.data.tool` | A returned observation from each server |
| `mcp.default.cwd` | Omitted `cwd` uses the package root |
| `mcp.relative.cwd`, `mcp.root.cwd` | Relative and root-placeholder `cwd` resolve to `probe-workdir` |
| `mcp.data.cwd` | Data-placeholder `cwd` matches the supplied data directory |
| `stdio.root` | Supplied `PLUGIN_ROOT` matches the independently determined package root |
| `stdio.data` | Supplied `PLUGIN_DATA` is an absolute path |
| `stdio.env` | Configured environment values reach the subprocess |
| `stdio.args` | Configured argument values reach the subprocess |
| `stdio.expansion` | Repeated recognized placeholders expand and unknown placeholder-like text stays literal |

These 16 cases are deliberately narrow. An absolute data path does not prove dedicated storage, writability, or persistence across updates. A configured environment value does not prove replacement of a conflicting inherited value. The fixtures do not establish non-recursive replacement when a replacement value itself contains placeholder text. Invalid configurations, failure isolation, and remote MCP transports are deferred.

The `stdio.*` checks evaluate the default-server observation. Other server observations establish only tool availability and their configured working directories.

## Verification

Reference runs and automated fixture tests validate the test machinery. Keep their provenance separate from observations collected through a real client's plugin support. See the repository's [verification scope](https://github.com/agentplugins/agent-plugins-conformance/blob/main/docs/verification.md) for the tested integration boundaries.
