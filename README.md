# MCode Plugins

[简体中文](README.zh-CN.md)

MCode Plugins is the community registry and contribution toolkit for plugins that run in MiniMax
Code. Plugin authors keep their source and release history in their own GitHub repositories. This
repository provides a searchable catalog, a pinned and reviewable submission format, offline
validation, compatibility guidance, and a shared contribution process.

> Status: community preview. A catalog entry means the package passed automated compatibility
> checks at the pinned commit. It is not an endorsement, security audit, or guarantee by MiniMax.

## Why this repository exists

A useful plugin ecosystem needs more than a list of links. It needs a complete path from creation to
real use:

```text
create -> validate -> submit -> review -> discover -> install -> feedback -> maintain
```

MCode Plugins keeps that path open and auditable:

- Authors own their plugin repository, issues, license, and release cadence.
- Catalog entries pin a full commit SHA, so review and installation refer to immutable source.
- CI validates the exact MCode-compatible surface instead of inferring support from a README.
- Capability and security metadata make dependencies and network access visible before install.
- Users report problems to the plugin author; registry policy issues stay in this repository.

## Supported plugin surface

The first public contract intentionally stays small:

- `plugin.json` using [Agent Plugins 1.0](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json)
- zero or more Agent Skills at `skills/<skill-name>/SKILL.md`
- an optional `mcp.json` with `stdio`, `streamable-http`, or `sse` servers

MiniMax Code does not currently promise Plugin Hooks, custom Agents, Commands, LSP servers, Apps,
generic OAuth configuration, or arbitrary `extensions`. A cross-client plugin may contain those
components, but its catalog entry must describe only the capabilities that MCode can load. See
[Plugin compatibility](docs/plugin-compatibility.md).

## Create a plugin

Start from the Skill-only [`examples/hello-mcode`](examples/hello-mcode) or the dependency-free
stdio [`examples/hello-mcode-mcp`](examples/hello-mcode-mcp):

```text
my-plugin/
├── plugin.json
├── mcp.json                  # optional
└── skills/
    └── my-skill/
        └── SKILL.md
```

Keep the plugin in its own public GitHub repository. Then fork this registry and generate a pinned
entry:

```bash
npm install
npm run add -- https://github.com/you/my-plugin --path optional/subdirectory
npm run check
npm run verify -- registry/my-plugin.json
```

The generator resolves the repository's current default-branch commit, reads the package, and writes
a draft registry entry. Review the generated categories and security metadata before opening a pull
request.

## Submit an existing plugin

1. Make the plugin source public and add a recognized open-source license.
2. Ensure the root (or declared subdirectory) contains a valid `plugin.json`.
3. Generate a registry entry pinned to a 40-character Git commit SHA.
4. Run `npm run check` and `npm run verify -- registry/<plugin>.json`.
5. Open a pull request using the checklist in [CONTRIBUTING.md](CONTRIBUTING.md).

Review focuses on reproducibility, MCode compatibility, transparent dependencies, least privilege,
and a runnable example. It does not transfer maintenance ownership to the registry maintainers.

## Trust model

Catalog packages are community code. Read the plugin source and requested capabilities before use.
Never put credentials directly in `plugin.json`, `mcp.json`, a Skill, or a registry entry. A plugin
may invoke local executables or remote services; those dependencies remain the plugin author's
responsibility. See [Security](SECURITY.md) and the [security model](docs/security-model.md).

## Project layout

```text
registry/      pinned plugin catalog entries
schemas/       machine-readable registry entry contract
scripts/       dependency-free validation and submission tools
examples/      known-good plugin packages
docs/          compatibility, architecture, governance, and security notes
```

## License

Registry code and documentation are licensed under Apache-2.0. Every external plugin keeps its own
license; inclusion in the catalog does not relicense it.
