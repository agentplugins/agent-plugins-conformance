# Symlink working-directory prototype

This experiment starts from merged PR #22 and adds a Recovery entry using
`cwd: "./escape-link"`, where the package contains `escape-link -> ..`.
It is not integrated into the suite reporter or guide. The Recovery observation
has a prototype-only `cwdSymlink` field, so the ordinary report contract and
full suite tests have not been updated for these experimental changes.

`run-native.mjs` installs independent copies through Codex's local marketplace,
records source and installed filesystem facts, collects complete native MCP
inventories, and calls the working tools without authentication or a model turn.
Scenarios use the escaping link, an inward-pointing link, a regular file with the
same link text, and an ordinary directory. Only the fixture path changes between
scenarios; the server configuration stays the same.

`evaluate.mjs` demonstrates the evidence rules with trusted harness input:

- A reported runtime working directory outside the plugin root is failure evidence.
- Known escaping input, target exclusion, and a working Recovery control can pass
  even if installation removed the link. No inference about client intent is needed.
- A regular-file checkout does not establish an escaping input.
- Missing input evidence can be supplied by an intact escaping installed link.

`reference.mjs` deliberately bypasses Agent Plugins validation with the MCP SDK
to demonstrate a runnable failure witness. This is not native-client evidence.

The temporary push-only CI workflow runs the native harness on Linux and Windows.
It records the original checkout shape before provisioning the canonical symlink
input when necessary. Such provisioning is test-harness preparation, not a claim
that ordinary Windows checkouts preserve links or a proposed user setup step.
Its artifacts contain evidence documents only, never recursive copies of the
deliberately escaping links. The workflow and harness are experimental material,
not a proposed production PR.
