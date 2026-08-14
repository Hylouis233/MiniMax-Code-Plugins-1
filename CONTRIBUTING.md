# Contributing

Thank you for helping the MCode plugin ecosystem grow. Contributions may improve the registry
tooling and documentation or submit a plugin that you maintain in another public repository.

## Submit a plugin

Your plugin must:

- be hosted in a public GitHub repository;
- include a recognized open-source license;
- pin a full 40-character Git commit SHA in the registry entry;
- use the MCode-compatible Agent Plugins surface documented in
  [`docs/plugin-compatibility.md`](docs/plugin-compatibility.md);
- contain no embedded credentials, private endpoints, telemetry without disclosure, installers, or
  native binaries;
- document required executables, accounts, paid services, network access, and operating-system
  limits; and
- expose at least one Skill or MCP server that a reviewer can understand and exercise.

Generate the first draft instead of writing catalog metadata by hand:

```bash
npm install
npm run add -- https://github.com/<owner>/<repository> --path <plugin-subdirectory>
```

Then edit the generated entry, run:

```bash
npm run check
npm run verify -- registry/<plugin-name>.json
```

and open a pull request. Include the user problem, an example prompt, expected result, dependencies,
network destinations, data handled by the plugin, and test evidence. One pull request should add or
update one plugin unless the entries are inseparable.

## Registry review

Reviewers verify the pinned source rather than a mutable branch. Automated checks cover package
shape and declared capabilities. Human review covers usefulness, clear ownership, dependency and
data-flow disclosure, obvious credential or supply-chain risks, and whether the example can be
reproduced.

Acceptance means “listed as community software.” It is not an audit or product endorsement. A
plugin can be removed or marked unavailable if its pinned source disappears, changes ownership
without explanation, becomes malicious, or is no longer maintained.

## Update a plugin

Open a pull request that changes the pinned commit and any metadata affected by that release. Include
a short changelog and rerun both local and remote verification. Never replace source at an existing
tag to bypass registry review.

## Improve this repository

For validator, schema, example, documentation, or workflow changes:

1. Open an issue for contract-breaking changes.
2. Keep the change focused and add or update automated tests.
3. Run `npm run check`.
4. Explain user impact and migration requirements in the pull request.

Contributions to this repository are licensed under Apache-2.0. External plugin repositories retain
their own licenses.
