---
name: run-conformance
description: Collect Agent Plugins conformance observations through the current client's skill and MCP mechanisms and save deterministic results to the user's requested JSON report path. Use when asked to run Agent Plugins conformance checks.
---

# Run the conformance probes

Observe the installed Agent Plugins Conformance fixtures through the client's normal skill and MCP surfaces. The reporting script beside this skill is the durable evidence store and deterministic evaluator; it assigns `pass`, `fail`, and `not_verified`. Record what the client exposes or returns without interpreting those outcomes yourself.

Client catalogs, resources delivered through the client's normal loading mechanism, successful MCP results, and native client diagnostics are evidence. A skill body delivered by that mechanism remains client-loaded evidence however the client represents it in the conversation. Skill text copied into a request without that provenance is not. Independently found package files may establish fixture or control facts, but not client advertisement, loading, or execution.

## Initialize the report

Use the user's exact absolute JSON report path. If none was supplied, ask for it. Locate `scripts/report.mjs` relative to this client-loaded skill and use its absolute path. This workflow requires a command-execution tool and Node.js 22 or newer as `node`; if either is unavailable, explain the limitation.

Initialize the report by invoking the reporter with the report path as its only argument and sending this single message through stdin:

```json
{"action":"start"}
```

```text
node <absolute-path-to-this-skill>/scripts/report.mjs <absolute-report-path>
```

If the command tool accepts only shell commands, use its literal-input facility so it does not expand the JSON. For example, in a POSIX shell:

```sh
node '/absolute/path/to/run-conformance/scripts/report.mjs' '/absolute/path/to/report.json' <<'CONFORMANCE_INPUT'
{"action":"start"}
CONFORMANCE_INPUT
```

Wait for successful initialization before recording observations. `start` creates missing parent directories, replaces any report at that path, and initializes every check as `not_verified`. Use different paths for concurrent runs and write only to the requested destination.

## Record observations

Save observations during collection so you do not need to retain all evidence until the end. Send one observation per `record` message to the same reporter and path. Collection and recording may proceed in parallel.

```json
{
  "action":"record",
  "observation":{"kind":"skill","skill":"conformance-alpha","marker":"APC_ALPHA_V1"}
}
```

Replace `observation` with the complete object obtained below. When possible, serialize the captured observation as JSON rather than retyping or reconstructing its fields. The reporter safely merges concurrent recordings and reevaluates the report. For the same kind and skill or server, the last committed recording replaces the previous observation.

Without a successful acknowledgment, the observation is not confirmed saved. Correct an input or command problem using the evidence already obtained and retry that `record`, or disclose the unconfirmed item at completion. Do not invoke `start` again; it would discard prior evidence.

## Collection inventory

The names below are targets, not proof that the client exposes them. Client-visible names may be namespaced. Loaded skill bodies and MCP tool descriptions supply the canonical names and server IDs saved in observations.

**Core — Skill body**

- `conformance-alpha`
- `conformance-beta`

**Recovery — Skill body**

- `conformance-recovery-valid`

**Invalid MCP — Skill body**

- `conformance-invalid-mcp-valid`

**Core nested reference — Skill discovery**

- `conformance-nested`

**Core — MCP stdio**

- `default`
- `relative`
- `root`
- `data`
- `command-token-posix`
- `command-token-windows`

**Core — MCP Streamable HTTP**

- `http`
- `http-redirect`

**Core — MCP legacy HTTP+SSE**

- `sse`
- `sse-header-precedence`
- `sse-redirect`
- `sse-endpoint-origin`

**Recovery valid — MCP stdio**

- `recovery-valid`

**Recovery invalid — MCP stdio**

- `recovery-cwd-invalid-form`
- `recovery-cwd-escape`
- `recovery-cwd-data-escape`
- `recovery-cwd-symlink-escape`
- `recovery-command-symlink-posix`
- `recovery-command-symlink-windows`
- `recovery-unknown-field`
- `recovery-missing-type`
- `recovery-env-plugin-root`
- `recovery-env-plugin-data`

**Recovery invalid — MCP Streamable HTTP**

- `recovery-http-type`
- `recovery-http-non-loopback`
- `recovery-http-relative-url`
- `recovery-http-fragment`
- `recovery-http-userinfo`
- `recovery-http-duplicate-headers`
- `recovery-http-header-name`
- `recovery-http-header-value`

**Recovery invalid — MCP legacy HTTP+SSE**

- `recovery-sse-non-loopback`
- `recovery-sse-relative-url`
- `recovery-sse-fragment`
- `recovery-sse-userinfo`
- `recovery-sse-duplicate-headers`
- `recovery-sse-header-name`
- `recovery-sse-header-value`

The optional HTTP server may already have been started by the user or CI. Do not start it or ask the user to start it during collection. `http-redirect` and `sse-redirect` redirect to another local origin, and `sse-endpoint-origin` advertises a message endpoint there. Do not authorize forwarding configured headers to those destinations.

## Skills

Find and load the four skill bodies in the inventory through the client's normal skill mechanism, and record the complete observation supplied by each body. A client-provided catalog followed by reading its advertised resource is valid. If a body is unavailable, leave its observation missing and continue.

For `conformance-nested`, inspect the client skill catalog without activating it. Its mention here or in another skill body is not separate advertisement. Record `advertised: true` if the catalog advertises it, or `advertised: false` if the catalog excludes it. If the catalog is unavailable or known to be incomplete, leave this observation missing unless it shows the nested skill.

Save the catalog observation as `{"kind":"skill-discovery","skill":"conformance-nested","advertised":<boolean>}`.

## MCP

Call every available registered conformance tool with `{}` and record its runtime outcome, including tools exposed from invalid entries.

The client inventory is cumulative across ordinary pages, searches, and deferred results: once a registered tool appears, it remains advertised. A later result never erases that positive evidence. Treat absence as evidence only after the accumulated inventory is known complete for the relevant loaded scope.

The `mcp-discovery` observation kind is only for Recovery invalid servers. If a registered tool belongs to a Recovery invalid server, record `{"kind":"mcp-discovery","server":"<canonical-id>","advertised":true}` even when the inventory is still partial. Discovery and runtime outcomes are separate observations.

Catalog inspection alone is not a remote transport attempt. A completed remote discovery outcome is also evidence when no tool appears. Record its native error or completed empty result for every remote fixture within that operation's known scope.

### Absent Recovery invalid tools

After accumulating the client inventory, apply these ordered rules to every Recovery invalid server still unseen:

1. If the relevant Recovery load scope or inventory completeness is unknown, including unresolved pagination or deferred tools, leave discovery missing.
2. If a known-complete inventory for the loaded Recovery scope excludes the tool and no startup or discovery operation for that server failed, record `advertised: false`. This applies to all invalid servers, including the three symlink servers.
3. A completed startup failure still permits `advertised: false` only for `recovery-cwd-symlink-escape`, `recovery-command-symlink-posix`, or `recovery-command-symlink-windows`, and only when the complete loaded-scope inventory excludes that tool. Installation may have removed the escaping symlink; the reporter combines this assertion with independent fixture and control evidence.
4. Otherwise leave discovery missing. A startup or discovery failure for an ordinary invalid server does not prove configuration rejection.

A failure affects only fixtures in that operation's scope; unaffected absent fixtures may still satisfy the complete-inventory rule. A failed call, guessed name, rejection diagnostic, or fixture inspection does not establish catalog absence. Negative discovery requires no rejection diagnostic. A negative discovery assertion is a catalog observation, not an empty runtime result; do not synthesize runtime `null` for an excluded remote fixture.

### Runtime outcomes

Apply these outcomes to an actual tool call or native transport discovery attempt, not to a catalog listing or search. Inspect the original client result before parsing. Preserve returned values and path literals exactly. A parsing or recording error is not a native client diagnostic.

| Outcome | Observation |
| --- | --- |
| Successful MCP result | Record the complete object from `structuredContent` or `structured_content`, or parse it from the result's JSON text. Exclude the MCP wrapper. |
| Native stdio discovery, startup, or call error | Leave runtime observation missing; retain any discovery observation. |
| Native remote discovery or call error | Record the exact typed error below. |
| Completed remote attempt with no observation or native error | Record `evidence: null` for each fixture actually attempted. |
| Skipped, interrupted, or unattributable attempt | Leave runtime observation missing. |

Only explicit `evidence: null` asserts a completed remote attempt without a payload or diagnostic. A missing runtime observation can also follow a completed stdio error, valid exclusion, unavailability, or interruption.

Save a completed empty Streamable HTTP attempt as `{"kind":"mcp-streamable-http","server":"<canonical-id>","evidence":null}`; use `kind: "mcp-sse"` for HTTP+SSE.

Use `kind: "mcp-streamable-http"` for Streamable HTTP errors and `kind: "mcp-sse"` for legacy HTTP+SSE errors:

```json
{
  "kind":"mcp-streamable-http",
  "server":"http-redirect",
  "evidence":{
    "type":"error",
    "message":"<complete exact native error text>",
    "classification":null
  }
}
```

Identify the fixture from the completed discovery operation's scope or called tool; the error need not name it. If one operation fails for several remote fixtures, record the same complete original diagnostic separately for each affected fixture, never outside that scope. Do not summarize it or replace it with a later parsing, transformation, or reporter error.

Keep `classification` null unless the native diagnostic unambiguously proves one of these meanings:

- For `http-redirect` or `sse-redirect`, use `"redirect-refused"` only when it establishes refusal to follow the redirect. Rejecting HTTP 307 as an unexpected response qualifies; merely mentioning 307 does not.
- For `sse-endpoint-origin`, use `"endpoint-refused"` only when it rejects the endpoint event because its origin differs from the configured connection origin.

Unsupported SSE, generic transport or connection failures, timeouts, unknown-tool errors, and unrelated URL errors remain unclassified. For every Streamable HTTP recording, the reporter adds `serverHealthCheck`; do not supply it.

Only the platform-appropriate Core command-token fixture is expected to run: `command-token-posix` on POSIX and `command-token-windows` on Windows.

## Complete the run

Return the absolute report path and name every inventory item whose observation you could not collect or confirm saved. This includes unavailable Core transports even when their support is optional. Disclose any discovery assertions unsupported by catalog evidence. Expected invalid-fixture exclusions, the inapplicable command-token fixture, conformance findings, and successfully recorded remote error or null evidence are not gaps.

Normal completion contains only the path and gaps, without listing successes. Do not read the accumulated report or generate a summary unless the user asks. The report contains the latest submitted evidence; its existence alone does not establish that the workflow completed.

If the user requests a summary or explanation, invoke the summarizer once:

```text
node <absolute-path-to-this-skill>/scripts/summarize.mjs <absolute-report-path>
```

Use its table and explanations, preserving `pass`, `fail`, and `not_verified`. These statuses describe submitted evidence for covered cases, not client certification, and depend on the provenance of the observations recorded.
