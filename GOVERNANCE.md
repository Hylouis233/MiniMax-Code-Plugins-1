# Governance

MCode Plugins is maintained in the open. The initial maintainers are responsible for registry
policy, compatibility contracts, releases of the validation toolkit, and time-sensitive security
actions. Plugin authors retain responsibility for their own repositories and users.

## Decision principles

1. Match documented MiniMax Code runtime behavior before expanding the catalog format.
2. Prefer portable Agent Plugins and Agent Skills contracts over host-specific invention.
3. Keep submissions reproducible by pinning immutable source.
4. Make dependencies, data access, network access, and maintenance ownership visible.
5. Use evidence from real users and contributors; plugin count and stars are not success metrics.

Contract changes are discussed in an issue and shipped through a pull request with tests and a
migration note. Security removals and obvious malicious submissions may be handled immediately and
documented after users are protected.

The project may introduce additional reviewer and maintainer roles as contribution volume grows.
No contributor gains authority over external plugin code merely because it is listed here.
