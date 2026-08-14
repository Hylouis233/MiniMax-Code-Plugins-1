# Security model

Hosted Plugins use three layers of evidence:

1. **Package validation** checks the owner/name layout, Manifest, Skill and MCP contracts, required
   documentation, unfinished placeholders, and symlinks without executing Plugin code.
2. **Pull request evidence** makes every source change reviewable before it reaches `main`.
3. **Human review** evaluates usefulness, dependencies, data flow, suspicious code, maintenance
   ownership, and reproducible test evidence.

These checks reduce ambiguity but are not a sandbox or full audit. `stdio` MCP servers execute local
programs with the user's permissions. Remote MCP servers send data to configured destinations.
Skills can instruct an agent to use tools and change files.

Never commit credentials, private endpoints, or personal data. Use runtime-supported secret and
environment mechanisms. Maintainers may quarantine or remove a Plugin while a security report is
investigated.
