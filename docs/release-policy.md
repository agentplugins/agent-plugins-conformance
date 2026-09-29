# Release policy

The suite’s plugins are released together as one suite. Their `plugin.json` versions and the root development package version match the suite release. Install the plugins from the same release tag.

Suite versions advance independently of Agent Plugins specification versions. Each suite release targets one exact published specification release; several suite releases can improve coverage of the same specification.

## Versioning

The suite uses [Semantic Versioning](https://semver.org/). Before `1.0.0`, consumer-facing interfaces are considered unstable. For stable releases:

| Change | Increment |
| --- | --- |
| Correct a check, improve collection guidance, or fix reporting without breaking a documented consumer interface | Patch |
| Add checks or other functionality while preserving existing consumer interfaces and prerequisites | Minor |
| Break the documented saved-report format, remove or redefine check IDs, change required installation or runtime prerequisites incompatibly, or replace the targeted specification version | Major |

The collection interface between the guide and reporter, and the protocols between suite components, are internal. They can change together without requiring a major release. The documented saved-report fields and check IDs are interfaces that consumers use for acceptance queries.

A corrective patch can change a verdict. New checks can change the result of an acceptance query that selects an entire ID prefix. Therefore, pin an exact suite release for reproducible acceptance testing.

## Specification releases

A new specification tag does not automatically retarget or release the suite. Adopting it requires validating the suite against that published release and keeping the declared schema targets, evaluated requirements, and report's `specVersion` consistent.

Replacing the target specification is a breaking change because clients supporting the previous target are not required to recognize the new schema identifiers. For stable suite versions, this requires a major increment. Earlier suite tags remain available for testing earlier specification versions. Fixes can be backported when needed; publishing a new target does not promise ongoing maintenance of every older release line.

## Release tags

Each suite release has an annotated `vX.Y.Z` tag matching the root package and all plugin versions. Its GitHub release identifies the exact specification tag being targeted.

Release tags and released plugin contents are immutable; corrections require a new suite version. `main` is development state; use release tags for repeatable runs.
