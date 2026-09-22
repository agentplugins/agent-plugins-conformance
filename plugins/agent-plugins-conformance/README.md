# Agent Plugins Conformance

Run [Agent Plugins](https://agent-plugins.org/) conformance checks through a client's normal skill and MCP mechanisms and save a JSON report. The `run-conformance` skill collects observations from installed fixture plugins; its reporter evaluates the evidence deterministically.

Results describe the observed run and covered cases; they are not whole-client certification.

## Run through a client

1. Make Node.js 22 or newer available as `node` on the client's executable search path. The agent must also be able to execute commands. The packaged plugins require no dependency installation or build.
2. For the optional Streamable HTTP checks, start the [Core fixture's bundled HTTP server](../agent-plugins-conformance-core/#optional-http-setup) in a separate terminal before the client loads the plugins. Leave it running during collection. Without it, HTTP checks remain `not_verified`; the agent continues collecting the other checks.
3. Install and load the plugins listed in the [suite’s installation table](../../README.md#run-the-checks) through the client's Agent Plugins support.
4. Ask the agent to run `run-conformance` and save the JSON report to an absolute path:

   > Run the run-conformance skill from Agent Plugins Conformance and save the JSON report to /tmp/agent-plugins-conformance/report.json.

The [run-conformance skill](skills/run-conformance/SKILL.md) initializes the destination, then records observations as they are collected. The reporter creates missing parent directories and updates the JSON file after each recording. Starting a run replaces any previous report at the same path, so concurrently active runs need distinct destinations.

When collection ends, the agent gives the report's absolute path and any collection or recording limitations. A saved report may be an incomplete snapshot if collection was interrupted; file existence alone does not establish completion.

## Read the results

The report contains `observations`, a flat `results` array, summary counts, and notes about the evidence. Each recording replaces the previous observation of the same kind for that skill or server. Skipped or interrupted attempts leave evidence missing, as do unavailable skill bodies and stdio runtime observations.

This abbreviated example shows three results and their summary counts; observations and notes are omitted.

```json
{
  "schemaVersion": 1,
  "specVersion": "1.0.0",
  "results": [
    {
      "id": "skills.discovery.immediate-children",
      "status": "not_verified",
      "detail": "Missing skill observations: conformance-alpha, conformance-beta. Missing skill discovery observation: conformance-nested.",
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
    "pass": 1,
    "fail": 1,
    "not_verified": 1,
    "total": 3
  }
}
```

Each object in `results` identifies its case through `id` and `label`, explains the outcome in `detail`, and cites the relevant specification sections in `specSections`. A result object may also contain a `warning` describing a probe cleanup failure, including the probe file's path and error. This warning does not change the result's `status`.

The three statuses mean:

| Status | Meaning |
| --- | --- |
| `pass` | The submitted evidence satisfies the check. |
| `fail` | The submitted evidence contradicts an expectation checked by the fixture. |
| `not_verified` | Evidence needed to decide the check is unavailable. |

For example, Core skill discovery passes when both reported markers match and the agent records that the nested `conformance-nested` reference was not advertised as a separate skill. A wrong marker or advertisement of the nested skill fails the check; missing required evidence leaves it `not_verified`. The reporter trusts the collecting agent's account of client discovery; matching markers do not independently prove how a skill was loaded.

An unsuccessful attempt on Core's `http` server fails the availability check only when the reporter confirms that the HTTP server is healthy; otherwise it remains `not_verified`.

### Choose required checks

Consumers choose which results to require. IDs form a hierarchy: `skills.*` covers skills, `mcp.stdio.*` covers stdio MCP behavior, and `mcp.streamable-http.*` covers the optional HTTP fixture. Prefix queries include future checks added within the selected scope.

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

The summarizer displays saved outcomes as a table with explanations for checks that failed or were not verified, followed by any warnings. From the plugin directory, run:

```sh
node skills/run-conformance/scripts/summarize.mjs '/absolute/path/to/report.json'
```

This command works from an installed or extracted copy of the plugin. You can also ask the agent to summarize the saved report. The run-conformance skill invokes the summarizer only when requested.

Reporting and summarizing errors are command failures. Producing a valid report with `fail` or `not_verified` results is a successful operation; acceptance queries apply your chosen requirements to those results.
