# Registry architecture

MCode Plugins separates plugin ownership from discovery.

```text
author repository
  plugin.json + Skills + optional MCP + license + releases
          |
          | immutable repository URL + commit SHA + path
          v
MCode Plugins registry
  metadata -> static validation -> remote source verification -> human review
          |
          v
catalog consumers / MiniMax Code discovery
```

This keeps the contribution path lightweight without turning one repository into the owner of every
plugin. It also lets reviewers inspect the same immutable source users are told about.

Registry entries are intentionally declarative. They do not execute plugin code during static
validation. Remote verification reads `plugin.json`, declared Skill files, and optional `mcp.json`
from GitHub at the pinned commit. Runtime behavior and external service quality require separate
review and testing.

The initial catalog does not claim a direct production Marketplace publishing API. Consumers may
use the registry as a source of reviewed metadata while MiniMax Code distribution evolves.
