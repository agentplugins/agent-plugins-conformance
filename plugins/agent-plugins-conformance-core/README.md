# Agent Plugins Conformance — Core

A portable [Agent Plugins](https://agent-plugins.org/) plugin for collecting evidence about skill discovery, MCP tool availability, working directories, and selected subprocess environment and placeholder rules. It provides three [Agent Skills](https://agentskills.io/specification) and four stdio MCP servers. A deterministic reporter evaluates their observations against fixed fixtures.

Results describe the observed run and these covered cases; they are not whole-client certification.

## Run through a client

1. Make Node.js 22 or newer available as `node` on the client's executable search path. The committed MCP bundle includes the official MCP SDK; using the plugin requires no dependency installation or build.
2. Install this directory through the client's Agent Plugins support so its loader discovers the root-level `plugin.json`, `mcp.json`, and plugin components.
3. Ask the agent to run the plugin's `conformance-guide` skill and save the JSON report to an absolute path. The agent must be able to execute commands.

For example:

> Run the conformance-guide skill from Agent Plugins Conformance — Core and save the JSON report to /tmp/agent-plugins-conformance/report.json.

The [conformance guide](skills/conformance-guide/SKILL.md) initializes the destination, then records each skill marker and MCP probe observation as it arrives. The reporter creates missing parent directories and updates the JSON file after each observation. Starting a run replaces any previous report at the same path, so concurrently active runs need distinct destinations.

When collection ends, the agent gives the report's absolute path and any collection or recording limitations. A saved report may be an incomplete snapshot if collection was interrupted; file existence alone does not establish completion.

## Read the results

The report records the client name and version, the latest observation for each skill or server, a flat `results` array, summary counts, and notes about the evidence. Each result contains its case `id`, human-readable `label`, `status`, `detail`, and relevant `specSections`.

The three statuses mean:

| Status | Meaning |
| --- | --- |
| `pass` | The submitted evidence satisfies the check. |
| `fail` | The submitted evidence contradicts an expectation checked by the fixture. |
| `not_verified` | Evidence needed to decide the check is unavailable. |

For example, skill discovery passes when all three reported markers match, fails when any supplied marker is wrong, and otherwise remains `not_verified`. The reporter trusts the collecting agent's account of client discovery; matching markers do not independently prove how a skill was loaded.

This JSON excerpt shows evaluator output for an illustrative run with a missing pair of skill observations, a successful default-server tool call, and an incorrect configured environment value. The observations, notes, and eleven other results are omitted here; the summary counts cover all fourteen results.

```json
{
  "schemaVersion": 1,
  "specVersion": "1.0.0",
  "client": {
    "name": "Example Client",
    "version": "unknown"
  },
  "results": [
    {
      "id": "skills.discovery.immediate-children",
      "status": "not_verified",
      "detail": "Missing skill observations: conformance-alpha, conformance-beta.",
      "label": "Immediate child skill discovery",
      "specSections": ["6.1", "7.1"]
    },
    {
      "id": "mcp.stdio.tool-availability.cwd-omitted",
      "status": "pass",
      "detail": "Valid runtime evidence supplied for this server.",
      "label": "default MCP tool evidence",
      "specSections": ["6.1", "7.2.1"]
    },
    {
      "id": "mcp.stdio.env.configured-value",
      "status": "fail",
      "detail": "APC_VALUE: expected \"fixture value with spaces\"; observed \"unexpected value\".",
      "label": "Configured environment",
      "specSections": ["9.1"]
    }
  ],
  "summary": {
    "pass": 6,
    "fail": 1,
    "not_verified": 7,
    "total": 14
  }
}
```

### Choose required checks

Consumers choose which results to require. IDs form a hierarchy: `skills.*` covers skills and `mcp.stdio.*` covers stdio MCP behavior. Prefix queries include future checks added within the selected scope.

For example, require all stdio MCP checks to pass:

```sh
jq -e '
  [.results[] | select(.id | startswith("mcp.stdio."))]
  | length > 0 and all(.[]; .status == "pass")
' '/absolute/path/to/report.json'
```

The trailing dot selects a complete namespace segment. The nonempty check prevents an absent or misspelled scope from succeeding without evaluating any cases.

If your acceptance policy excludes the absolute plugin-data path check, for example, express that choice explicitly:

```sh
jq -e '
  [
    .results[]
    | select(
        (.id | startswith("mcp.stdio."))
        and .id != "mcp.stdio.env.plugin-data-absolute"
      )
  ]
  | length > 0 and all(.[]; .status == "pass")
' '/absolute/path/to/report.json'
```

That exclusion illustrates a consumer's policy choice. The plugin still evaluates and reports the excluded case.

To require a fixed list, check both presence and status for every requested ID:

```sh
jq -e '
  .results as $results
  | ["mcp.stdio.cwd.omitted", "mcp.stdio.env.plugin-root"]
  | all(.[];
      . as $id
      | any($results[]; .id == $id and .status == "pass")
    )
' '/absolute/path/to/report.json'
```

List checks that did not pass, together with their explanations:

```sh
jq '
  .results[]
  | select(.status != "pass")
  | {id, label, status, detail}
' '/absolute/path/to/report.json'
```

### Summarize a saved report

The summarizer displays saved outcomes as a table with explanations for checks that failed or were not verified. From the plugin directory, run:

```sh
node skills/conformance-guide/scripts/summarize.mjs '/absolute/path/to/report.json'
```

This command works from an installed or extracted copy of the plugin. You can also ask the agent to summarize the saved report. The guide invokes the summarizer only when requested.

Reporting and summarizing errors are command failures. Producing a valid report with `fail` or `not_verified` results is a successful operation; acceptance queries apply your chosen requirements to those results.

## Coverage

The plugin evaluates fourteen cases. The environment and argument checks use the `default` server's observation; each of the other servers supplies tool-availability and working-directory evidence.

| Case IDs | What the check establishes |
| --- | --- |
| `skills.discovery.immediate-children` | The agent reports the expected markers for all three immediate child skills loaded through the client. Discovery depends on that account. |
| `mcp.stdio.tool-availability.cwd-omitted`, `mcp.stdio.tool-availability.cwd-plugin-relative`, `mcp.stdio.tool-availability.cwd-plugin-root`, `mcp.stdio.tool-availability.cwd-plugin-data` | Each server returned a valid observation. |
| `mcp.stdio.cwd.omitted` | Omitted `cwd` uses the package root. |
| `mcp.stdio.cwd.plugin-relative`, `mcp.stdio.cwd.plugin-root` | Relative and root-placeholder `cwd` resolve to `probe-workdir`. |
| `mcp.stdio.cwd.plugin-data` | Data-placeholder `cwd` matches the data path resolved by the probe. |
| `mcp.stdio.env.plugin-root` | Supplied `PLUGIN_ROOT` matches the independently determined package root. |
| `mcp.stdio.env.plugin-data-absolute` | Supplied `PLUGIN_DATA` is an absolute path. This check does not exercise storage dedication, writability, or persistence across updates. |
| `mcp.stdio.env.configured-value` | The configured value reaches the subprocess. The fixture does not arrange a conflicting inherited value, so it does not establish override behavior. |
| `mcp.stdio.args.preservation-and-expansion` | Argument boundaries, including spaces and an empty argument, are preserved; recognized placeholders expand and unknown placeholder-like text stays literal. |
| `mcp.stdio.env.expansion` | Repeated recognized placeholders expand in environment values and unknown placeholder-like text stays literal. |

The expansion fixtures do not arrange replacement values containing placeholder text, so they do not establish non-recursive replacement. This plugin exercises valid stdio configurations; invalid configuration handling, failure isolation, and remote MCP transports are outside its coverage.
