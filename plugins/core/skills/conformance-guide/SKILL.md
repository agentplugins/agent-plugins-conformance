---
name: conformance-guide
description: Collect and report Agent Plugins conformance probe observations through the current client's skill and MCP mechanisms. Use when asked to run this plugin's conformance checks.
---

# Run the conformance probes

This skill's marker is `APC_GUIDE_V1`.

Collect evidence for this run, then submit it to the plugin's reporter. The reporter covers selected behaviors, not whole-client conformance.

1. Choose a unique `runId`. Record the client name, version (use `unknown` if unavailable), and how the plugin was loaded. Use `collection.kind: "client"` for collection through the client's plugin support and `"reference"` for manually assembled fixture runs.
2. If the client exposed this skill and you loaded its body through the client's normal skill mechanism, collect `{"kind":"skill","skill":"conformance-guide","marker":"APC_GUIDE_V1"}`. A client-provided skill catalog followed by reading its advertised resource is a valid mechanism. Locating a known skill by filesystem search or receiving its body in a prompt does not establish client discovery.
3. Find and load `conformance-alpha` and `conformance-beta` through that same client mechanism. Collect the observation each loaded body supplies. Do not infer their markers or claim discovery from files you located independently of the client.
4. Find each server's `observe` tool: `default`, `relative`, `root`, and `data`. Tool names may be client-namespaced. Call each available tool with `{"runId":"<your run ID>"}`. Take the observation object from `structuredContent` (some clients show `structured_content`), or parse the JSON in the tool's text content. The observation begins with `{"kind":"runtime","server":...}`; do not include the MCP result wrapper containing `content` or `structuredContent`. Copy that observation object in full and unchanged into `observations`; do not reconstruct paths, repair values, or summarize the evidence as pass/fail.
5. Omit observations for unavailable skills, missing tools, or calls that did not return evidence. Note those limitations separately. They remain `not_verified`.
6. Assemble this report input using the actual run details and collected observations:

   ```json
   {
     "schemaVersion": 1,
     "runId": "<your run ID>",
     "client": {"name": "<client name>", "version": "<client version or unknown>"},
     "collection": {"kind": "client", "route": "<how the client loaded the plugin>"},
     "expectedPasses": [],
     "observations": []
   }
   ```

   Set `expectedPasses` only from explicit developer expectations, using case IDs documented in the plugin README. Expectations are separate from evidence; leave the array empty when none were supplied.
7. Call the `default` server's `report` tool with `{"input": <report input object>}`. If that tool is unavailable and a local shell is available, save the input and run `node src/report-cli.mjs observations.json` from the plugin directory for the human-readable result; run it again with `--json` for the structured report. Preserve both forms. If neither route is available, return the collected report input for later evaluation without assigning outcomes yourself.
8. Present the evaluated case outcomes and collection limitations. Do not turn `not_verified` into `fail`, invent an `unsupported` result, or describe this run as client certification. The reporter trusts your account of how skills and tools were exposed; disclose any manual collection route.
