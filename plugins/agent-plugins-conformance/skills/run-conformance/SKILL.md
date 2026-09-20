---
name: run-conformance
description: Collect Agent Plugins conformance observations through the current client's skill and MCP mechanisms and save deterministic results to the user's requested JSON report path. Use when asked to run Agent Plugins conformance checks.
---

# Run the conformance probes

Collect observations from the installed Agent Plugins Conformance fixtures. Use the reporting script beside this skill to maintain the JSON report as you collect evidence. The reporter assigns outcomes for the covered cases; your role is to collect and record observations faithfully.

## Start the report

1. Identify the absolute JSON report path supplied by the user. If none was supplied, ask for it before starting.
2. Locate `scripts/report.mjs` relative to this client-loaded skill and use its absolute path in commands. Node.js 22 or newer must be available as `node`, and you must have a command-execution tool. If either is unavailable, explain the limitation.
3. Invoke the script with the user's absolute report path as its only argument. Supply this JSON message through stdin:

   ```json
   {"action":"start"}
   ```

   Start every new run this way and confirm that initialization succeeds before collecting observations. The script creates missing parent directories and replaces any existing report at that exact path with a fresh report. All checks initially have status `not_verified`. Concurrently active runs must use distinct report paths.

Each invocation has this form:

```text
node <absolute-path-to-this-skill>/scripts/report.mjs <absolute-report-path>
```

Send one JSON message through the command tool's stdin facility. If the tool accepts only shell commands, use the shell's literal-input mechanism. For example:

```sh
node '/absolute/path/to/run-conformance/scripts/report.mjs' '/absolute/path/to/report.json' <<'CONFORMANCE_INPUT'
{"action":"start"}
CONFORMANCE_INPUT
```

Replace the example paths. Write the report only to the destination the user requested.

## Record each observation

Run recording commands sequentially. Never submit recording commands together in a parallel tool-call batch; wait for each command to finish before issuing the next. Record each observation before attempting another component. After obtaining an observation, immediately send this message through stdin to the same reporting script and report path:

```json
{
  "action":"record",
  "observation":{"kind":"skill","skill":"conformance-alpha","marker":"APC_ALPHA_V1"}
}
```

Replace `observation` with the complete observation just obtained. The script retains the other components' evidence, replaces any previous observation for the same skill or server, evaluates the accumulated evidence, and updates the JSON report. A brief acknowledgment confirms each successful recording.

Collect all fixture skills and MCP tools through the client's normal mechanisms. The user or CI may start the optional HTTP server before client loading; do not start it or ask the user to start it during collection.

1. Find and load `conformance-alpha` and `conformance-beta` from Agent Plugins Conformance — Core, `conformance-recovery-valid` from Agent Plugins Conformance — Recovery, and `conformance-invalid-mcp-valid` from Agent Plugins Conformance — Invalid MCP, through the client's normal skill mechanism. A client-provided skill catalog followed by reading its advertised resource is a valid mechanism. Record the observation each loaded body supplies, one at a time. The example above shows the alpha observation. Do not infer their markers or claim discovery from files located independently of the client or skill bodies received in a prompt.
2. Find the `observe` tools on the Core fixture servers (`default`, `relative`, `root`, `data`, and `http`) and the Recovery fixture server `recovery-valid` through the client's normal MCP mechanism. Tool names may be client-namespaced. Call each available tool with `{}`. Take each observation from `structuredContent` (some clients show `structured_content`), or parse the JSON in the tool's text content. Immediately record that complete object; exclude the MCP result wrapper containing `content` or `structuredContent`. Preserve the returned paths and values exactly.
3. If a completed discovery or call attempt produces no HTTP observation, record the following object. For unavailable skill or stdio observations, or any skipped or interrupted attempt, leave the evidence missing and continue collecting the remaining components.

```json
{
  "action":"record",
  "observation":{"kind":"mcp-streamable-http","server":"http","evidence":null}
}
```

For every HTTP recording, the reporter checks the local fixture and adds `serverHealthCheck` to the saved observation. Do not supply this field yourself. Keep track of collection limitations for your final response and leave outcome decisions to the reporter.

A recording command failure means its observation was not successfully saved. Address an input or command error using the actual evidence, or identify the unsaved item in your final response. Retry an individual recording with `record`; invoking `start` again discards previously collected evidence.

## Finish collection

When collection ends, give the absolute JSON report path and note any collection or recording limitations. Claim successful recording only for commands that succeeded. If initialization failed, do not claim a report was created for this run. The saved report represents the latest observation submitted for each component; its existence alone does not establish that collection finished.

During normal completion, return only the path and limitations. Do not read the accumulated report into context or generate its summary unless the user asks. Users and CI can consume the JSON directly and choose which results to require. Preserve the evaluator's `pass`, `fail`, and `not_verified` statuses when discussing results. These results describe submitted evidence for covered cases, not client certification, and the evaluator trusts your account of how skills and tools were exposed.

If the user asks you to summarize or explain the saved results, invoke the summarizer once:

```text
node <absolute-path-to-this-skill>/scripts/summarize.mjs <absolute-report-path>
```

Use its table and explanations to answer the user's request.
