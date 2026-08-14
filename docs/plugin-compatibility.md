# MiniMax Code plugin compatibility

## Portable package

MiniMax Code reads the portable subset of Agent Plugins 1.0:

```text
plugin-root/
├── README.md                 # required by this community repository
├── LICENSE                   # required by this community repository
├── plugin.json
├── mcp.json                  # optional
└── skills/
    └── <skill-name>/
        └── SKILL.md
```

`plugin.json` must target:

```json
"$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
```

The only required manifest fields are `$schema` and `name`. Adding `version`, `description`,
`author`, `homepage`, `repository`, `license`, and `keywords` improves catalog quality. Client
`extensions` may be present but are ignored by MiniMax Code.

## Skills

MiniMax Code discovers immediate child directories under `skills/` and reads each `SKILL.md`. The
frontmatter `name` must match its directory, use lowercase letters, digits and single hyphens, and be
at most 64 characters. `description` is required and must explain what the Skill does and when it
should activate.

## MCP

`mcp.json` must target:

```json
"$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"
```

Supported transports are:

- `stdio`, using an executable token plus optional arguments, environment, and contained working
  directory;
- `streamable-http`, using an HTTP(S) URL and optional headers; and
- `sse`, retained for compatible legacy HTTP+SSE servers.

MiniMax Code reserves `PLUGIN_ROOT` and `PLUGIN_DATA`. A plugin must not set those variables itself.
Do not embed tokens in environment values or headers. Generic OAuth configuration is not part of
this portable subset.

## Limits and unsupported capabilities

The runtime accepts at most 64 Skill directories and 8 MCP servers per Agent Plugin. Invalid Skills
or MCP entries are omitted with diagnostics; an invalid root manifest rejects the package.

The following are not currently public MCode Plugin capabilities:

- Hooks and lifecycle scripts
- custom Agents and Commands
- LSP configuration
- Apps or UI extensions
- generic OAuth setup
- host-specific fields hidden in `extensions`

Hosted contributions may contain extra assets, but documentation must not imply that MiniMax Code
loads unsupported components. TUI Extensions are a separate product extension system, not an Agent
Plugin capability.
