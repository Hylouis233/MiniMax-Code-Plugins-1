# Security model

The registry uses three layers of evidence:

1. **Static entry validation** checks metadata, immutable commit pins, paths, and declared
   capabilities without executing plugin code.
2. **Remote source verification** reads the package at the pinned GitHub commit and compares the
   registry claims with `plugin.json`, `mcp.json`, and Skill frontmatter.
3. **Human review** evaluates usefulness, dependency and data-flow disclosures, suspicious code,
   maintenance ownership, and reproducible test evidence.

These checks reduce ambiguity but are not a sandbox or full audit. `stdio` MCP servers execute local
programs with the user's permissions. Remote MCP servers send data to their configured destination.
Skills can instruct an agent to use tools and change files. Users must review capabilities and trust
the author before installing community code.

Registry entries pin source because mutable branches and tags are not sufficient review anchors.
Updates require a new commit pin and another pull request. Credentials are never valid registry or
package content; use runtime-supported secret and environment mechanisms instead.
