# Community Plugins

This directory is the source of truth for community Agent Plugins published through this repository.

```text
plugins/
└── <github-owner>/
    └── <plugin-name>/
        ├── plugin.json
        ├── README.md
        ├── LICENSE
        ├── mcp.json          # optional
        └── skills/           # optional
```

Create a contribution from the repository root:

```bash
npm run create -- <github-owner>/<plugin-name>
```

Replace every `TODO`, run `npm run check`, and open one pull request for one Plugin. See
[`CONTRIBUTING.md`](../CONTRIBUTING.md) for review and security requirements.
