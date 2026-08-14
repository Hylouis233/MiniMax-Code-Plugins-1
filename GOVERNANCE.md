# Governance

MiniMax Code Plugins is maintained in the open. Maintainers own contribution policy, compatibility
contracts, validation tooling, review queues, and time-sensitive security actions. Plugin authors
own the code and user support under their `plugins/<owner>/` path.

## Decision principles

1. Match documented MiniMax Code runtime behavior before expanding the catalog format.
2. Prefer portable Agent Plugins and Agent Skills contracts over host-specific invention.
3. Keep the contribution path to one hosted folder and one pull request.
4. Make dependencies, data access, network access, and maintenance ownership visible.
5. Use evidence from real users and contributors; plugin count and stars are not success metrics.

Contract changes are discussed in an issue and shipped through a pull request with tests and a
migration note. Security removals and obvious malicious submissions may be handled immediately and
documented after users are protected.

The project may introduce additional reviewer and maintainer roles as contribution volume grows.
No contributor gains authority over another owner's Plugin because their own contribution is hosted
here.
