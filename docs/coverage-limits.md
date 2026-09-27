# Coverage limits

The suite checks selected requirements of [Agent Plugins 1.0.0](https://github.com/agentplugins/agent-plugins-spec/blob/main/spec/1.0.0.md). A passing result establishes the behavior described by that check; it does not establish that the client conforms to the entire specification. The [test plugin READMEs](../README.md#run-the-checks) describe the existing checks. This document explains which checks have been deferred or deliberately omitted, and why.

For an implemented check, missing or inconclusive evidence produces a “not verified” result (`not_verified`). The deferred checks below do not produce report results.

A proposed check needs a specific requirement, a practical reason to test it, and evidence that can determine whether the client satisfied it. Its value must also justify any additional test plugins or setup steps. The suite does not attempt to test every possible invalid configuration.

## Deferred checks

### Plugin data persistence across updates

Clients that launch stdio MCP servers must preserve the contents of `PLUGIN_DATA` when a plugin is updated. The suite checks that this directory is writable and consistently assigned, but it does not check whether an update preserves the stored data.

A test would need to write data, update the same installed plugin, and verify that the new version can still read that data. It must also prove that an update actually occurred and that the observations came from the new version. We have not resolved how to perform each client's update procedure and preserve the test's progress and recorded observations through a client reload or restart. Completing this within one invocation of the suite's [`run-conformance` collection skill](../plugins/agent-plugins-conformance/), without client-specific preparation or transferring observations between separate test runs, remains deferred.

### Filesystem containment beyond MCP commands and working directories

When a client discovers, reads, or executes files supplied by a plugin, it must reject paths that resolve outside the plugin's root directory. The suite tests this through MCP working directories and executable commands, including a command that follows two symlinks before reaching an external executable. It does not cover every way a client can access plugin files:

- **Loading manifests, MCP configuration, or skills through escaping links.** A test needs valid files outside the installed plugin directory. If the target is missing or malformed, the client might reject it for that reason, so rejection alone would not demonstrate containment. We have not established how to supply those external files reliably without assuming where clients install neighboring plugins or requiring extra preparation. Testing `plugin.json`, `mcp.json`, or the entire `skills/` directory this way would also require separate test packages. A manifest rejected during installation presents the evidence-collection problem described below.
- **Accessing other files supplied by a plugin.** We have not identified a standard client operation that the suite can use to test access through an arbitrary escaping symlink. Having an MCP server read the file would test the subprocess's access, which this requirement does not restrict. The presence of the link alone shows neither successful containment nor a violation.
- **Following Windows junctions or other reparse mechanisms.** The Windows command test uses file symlinks. It does not test other mechanisms that can redirect filesystem access, such as directory junctions. We have not found a way to include these mechanisms in a test plugin without requiring additional setup.

Reconsider these gaps when we can reliably supply the required files and observe the client's access, or when a concrete client defect justifies the additional preparation.

### Rejecting plugins with invalid manifests

Some manifest errors, such as invalid JSON in `plugin.json`, require the client to reject the entire plugin. Correct rejection can occur during installation, before an agent running the suite can inspect the plugin or collect the installation error. The plugin's absence afterward does not explain why it is missing.

A useful check needs a way to record the installation attempt and its outcome, then make that evidence available to the suite even when the plugin was rejected. That collection process remains deferred.

### Keeping other servers available after a server fails to start

If the client exposes no tools for a server, the suite cannot tell whether the client attempted to start that server and failed, rejected its configuration, or never tried to start it. A second server remaining available does not answer that question.

Before checking that a startup failure leaves other servers working, the suite needs evidence that the client attempted to start the server and that attempt failed. This check is deferred until that attempt can be reliably observed.

### Unsupported or unrecognized MCP schema identifiers

Clients that load MCP configuration must use a recognized `$schema` value from `mcp.json` to choose the rules for validating and interpreting its configuration. The [Invalid MCP plugin](../plugins/agent-plugins-conformance-invalid-mcp/) tests recovery from invalid JSON. It does not test whether a client processes an otherwise-valid document while ignoring an unrecognized `$schema` value.

That check needs a separate test plugin or another installation with different configuration. No concrete compatibility problem has justified that addition. Reconsider it when client behavior demonstrates a need.

### Different specification versions in the manifest and MCP configuration

The versions identified by `$schema` in `plugin.json` and `mcp.json` must match. Testing a mismatch requires a dedicated test plugin. Only specification version 1.0.0 has been published, so there is not yet a pair of published versions to use. Reconsider this check when another version is published and the additional test plugin is justified.

### Repeated expansion of placeholders introduced by a replacement

When launching a stdio MCP server, clients must expand `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` once, without expanding placeholder text introduced by that replacement. Ordinary installation and data-directory paths do not expose incorrect repeated expansion: those paths contain no further placeholders.

To distinguish the behaviors, the plugin's root or data-directory path must itself contain literal `${PLUGIN_ROOT}` or `${PLUGIN_DATA}` text. Arranging such a path requires artificial or client-specific placement. We have not identified a practical need that justifies this preparation.

### Missing component locations or locations of the wrong filesystem kind

A plugin may omit `skills/` or `mcp.json`; the client must not treat that absence as an error. The [Agent Plugins Conformance plugin](../plugins/agent-plugins-conformance/), which provides the `run-conformance` skill, already has no `mcp.json`. However, a client could load the skill successfully while also reporting the missing file as an error. The suite does not collect that diagnostic, so successful loading alone does not verify the requirement.

The suite also does not test cases such as `skills` being a file rather than a directory, or `mcp.json` being a directory rather than a file. These would require additional test packages or installations with modified contents. Recovery from malformed JSON does not cover these inputs. No concrete client problem currently justifies the additional checks.

### MCP endpoint URLs with schemes other than HTTP or HTTPS

The suite tests several invalid URL and header configurations, but not endpoint URLs with other schemes. For such a URL, a failed connection would not by itself show whether the client correctly rejected the configuration or incorrectly attempted to use it.

No concrete compatibility problem or test that distinguishes those outcomes has been established. Additional invalid forms need their own practical rationale rather than being added solely to enumerate configuration errors.

## Deliberately omitted checks

### Exclusion of malformed skills

The [Recovery plugin](../plugins/agent-plugins-conformance-recovery/) includes valid and malformed skills. The suite checks that the valid skill remains available. It deliberately does not check whether the client excludes the malformed skill or reports an error about it. A passing result for the valid skill provides no evidence about either of those behaviors.

### Inline MCP configuration in the plugin manifest

The specification requires MCP configuration to be loaded from the root `mcp.json` file and prohibits defining it inside `plugin.json`. That prohibition followed the removal of support for configurable discovery locations and embedded MCP configuration, simplifying how clients find the configuration.

That history has not established a distinct compatibility problem sufficient to justify a test plugin with inline MCP configuration. The prohibition remains a requirement even though the suite does not test it.
