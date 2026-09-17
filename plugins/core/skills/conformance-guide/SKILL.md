---
name: conformance-guide
description: Collect Agent Plugins conformance observations through the current client's skill and MCP mechanisms and record deterministic results at the requested output path. Use when asked to run this plugin's conformance checks.
---

# Run the conformance probes

This skill's marker is `APC_GUIDE_V1`.

Use the reporting script beside this skill to maintain a JSON report as you collect evidence. The report covers selected behaviors, not whole-client conformance. Do not assign outcomes yourself.

## Start the report

1. Obtain the requested `outputPath`, an absolute path to the JSON report. If none was supplied, ask for it before starting; do not choose a default filename or directory. Record the client name and version, using `unknown` when unavailable.
2. Locate `scripts/report.mjs` relative to this client-loaded skill. Use that script's absolute path in commands; locating it requires neither changing the working directory nor creating scratch files in the installed plugin. Write the report only to the requested `outputPath`. Node.js 22 or newer must be available as `node`, and you must have a command-execution tool. If either is unavailable, explain the limitation rather than fabricate results.
3. Invoke the script with `outputPath` as its only argument, supplying the following JSON message through stdin with the actual client details:

   ```json
   {"action":"start","client":{"name":"<client name>","version":"<client version or unknown>"}}
   ```

   Start every new run this way, even if another run just finished. The script creates missing parent directories and replaces any existing report at that exact path with a fresh report. All checks initially have status `not_verified`. Do not share an output file between concurrently active runs.

Each invocation has this form:

```text
node <absolute-path-to-this-skill>/scripts/report.mjs <absolute-outputPath>
```

Send one JSON message through the command tool's stdin facility when available. Otherwise, use the shell's literal-input mechanism, quoting the executable arguments and JSON appropriately for that shell. For example, in a POSIX-compatible shell:

```sh
node '/absolute/path/to/conformance-guide/scripts/report.mjs' '/absolute/path/to/report.json' <<'CONFORMANCE_INPUT'
{"action":"start","client":{"name":"Example Client","version":"unknown"}}
CONFORMANCE_INPUT
```

Replace the example paths and client details. No input file is needed: messages go directly through stdin, and all persistent collection state lives in the report at `outputPath`. Check that initialization succeeds before collecting observations.

## Record each observation

Run recording commands sequentially. Never submit recording commands together in a parallel tool-call batch; wait for each command to finish before issuing the next. Record each observation before requesting another one. After obtaining an observation, immediately send this message to the same reporting script and output path:

```json
{
  "action":"record",
  "observation":{"kind":"skill","skill":"conformance-guide","marker":"APC_GUIDE_V1"}
}
```

Replace `observation` with the complete observation just obtained. The script retains the other observations, replaces any previous observation for the same skill or server, evaluates the accumulated evidence, and updates the JSON report. It returns a brief acknowledgment rather than the human-readable report. Do not gather observations into a separate array or input file.

1. Record the guide observation above only if the client exposed this skill and you loaded its body through the client's normal skill mechanism. A client-provided skill catalog followed by reading its advertised resource is a valid mechanism. Locating a known skill by filesystem search or receiving its body in a prompt does not establish client discovery.
2. Find and load `conformance-alpha` and `conformance-beta` through that same client mechanism. Record the observation each loaded body supplies, one at a time. Do not infer their markers or claim discovery from files located independently of the client.
3. Find each server's `observe` tool: `default`, `relative`, `root`, and `data`. Tool names may be client-namespaced. Call each available tool with `{}`. Take its observation from `structuredContent` (some clients show `structured_content`), or parse the JSON in the tool's text content. Immediately record that complete object. It begins with `{"kind":"mcp-stdio","server":...}`; exclude the MCP result wrapper containing `content` or `structuredContent`. Do not reconstruct paths, repair values, or summarize the evidence as pass/fail.
4. Omit observations for unavailable skills, missing tools, or calls that did not return evidence. Keep track of those collection limitations for your final response. Missing evidence remains `not_verified`; it does not by itself establish failure.

A recording error means that observation was not successfully saved. Address an input or command error using the actual evidence, or explicitly identify the unsaved observation in your final response. Do not silently treat a failed write as missing probe evidence. Never rerun `start` to recover an individual recording error: it discards previously collected evidence.

## Finish collection

When collection ends, give the absolute JSON report path and note any collection or recording limitations. Claim successful recording only for commands that succeeded. If initialization failed, do not claim a report was created for this run. The saved report represents the latest observation submitted for each component; its existence alone does not establish that collection finished.

Do not automatically read the accumulated report into context or generate its human-readable summary. The user or CI can consume the JSON directly. Consumers choose which case results to require; do not turn `not_verified` into `fail`, invent an `unsupported` result, or describe this run as client certification. The evaluator trusts your account of how skills and tools were exposed.

If the user asks you to summarize or explain the saved results, invoke the read-only summarizer once:

```text
node <absolute-path-to-this-skill>/scripts/summarize.mjs <absolute-outputPath>
```

It renders the outcomes already saved in the report without modifying it or re-evaluating observations. Use that output to answer the user's request.
