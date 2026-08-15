# MiniMax Code Trajectory

> A privacy-aware, interactive flight recorder for local MiniMax Code sessions.

MiniMax Code stores canonical local session events under the active profile's
`v2/sessions/YYYY/MM/DD/<session>/ledger.jsonl`. This Plugin turns those ledgers into bounded,
structured summaries and a self-contained interactive timeline that an agent can use to explain a
task, inspect failures, count tool activity, and compare the display transcript with Pi
history—without modifying the source session files.

The design is inspired by
[`icesixgod/codex-trajectory`](https://github.com/icesixgod/codex-trajectory) at commit
`2f10022557bbc4ffefce1eb656ab2e09dd55ff0e`. This implementation is written from scratch for the
MiniMax Code v2 ledger contract and does not copy the reference project's UI or source code.

## Try it

```text
Use the minimax-code-trajectory skill to visualize a safe summary of my latest local MiniMax Code
task. Open the generated timeline in the MCode built-in Browser. Highlight failed states, tool
activity, compactions, and token usage. Do not expose message text.
```

Expected result: the agent calls `show_minimax_trajectory`, receives a local `file://` URL, and
navigates the MCode built-in Browser to an interactive event timeline. Default summary mode never
puts message text, tool arguments/results, source paths, or raw ledger records into that page.

## Capabilities

- `list_minimax_sessions` — lists recent local session IDs and non-content metadata.
- `get_minimax_trajectory` — reads one session or the most recently updated session and returns a
  structured trajectory.
- `show_minimax_trajectory` — generates a responsive, self-contained HTML timeline under the
  Plugin data directory and returns its `file://` URL.
- `minimax-code-trajectory` Skill — tells the agent how to use the tools without widening the
  privacy boundary, then opens visualizations with the MCode built-in Browser when available.

The public Agent Plugins 1.0 subset does not expose custom UI/App extensions. The Plugin therefore
uses an explicit two-step handoff: its MCP server generates offline HTML, then the Skill asks the
host-provided Browser tool to navigate to that file. MCode Desktop can open it in the built-in
Browser; surfaces without Browser capability return the file URL as a fallback.

## Interactive viewer

The generated page is designed as an Agent flight recorder:

- summary metrics for ledger records, elapsed time, Pi tool calls/tokens, compactions, and warnings;
- an event spine with relative time-gap pulses;
- event-kind filters and a click/keyboard-accessible inspector;
- responsive layout, visible keyboard focus, and reduced-motion support;
- strict Content Security Policy, no remote fonts/scripts/styles, and no network requests.

## Privacy levels

- `summary` (default): no titles, message text, thinking, tool arguments/results, workspace paths,
  file IDs, hashes, or raw records.
- `full`: must be explicitly requested by the user. It returns redacted, length-bounded text
  previews and tool names, but still excludes thinking, tool arguments/results, attachment bytes,
  raw record metadata, absolute paths, and secrets matched by the built-in redactor.

The MCP server never writes to the MiniMax Code session directory. It rejects symlinked session
artifacts, ignores malformed active-tail JSONL, caps individual ledger lines at 2 MiB, and returns
at most 1,000 event summaries per call. Manifest-only sessions whose ledger has already been
removed are counted as unavailable and skipped when choosing the latest inspectable session. The
HTML viewer is written only below the host-provided `PLUGIN_DATA/trajectory-html` directory; a
symlinked output root is rejected.

## Requirements

- MiniMax Code with Agent Plugins 1.0 MCP support.
- MCode Desktop built-in Browser for automatic opening. TUI/headless surfaces can still use the
  returned local file URL.
- Node.js 22+ on `PATH` (the server uses only Node.js standard-library modules).
- Local-runtime v2 session artifacts.

The data directory is resolved in this order:

1. `MINIMAX_DATA_DIR`
2. `MAVIS_DATA_DIR`
3. `~/.minimax`

MiniMax Code production normally uses `~/.minimax`. Development/profile runs should launch the
host with the matching `MINIMAX_DATA_DIR` or `MAVIS_DATA_DIR`; the Plugin deliberately does not scan
other home-directory profiles.

## Data and network

- Reads only `manifest.json` and `ledger.jsonl` below the resolved
  `<dataDir>/v2/sessions` directory.
- Writes generated `.html` files only below `PLUGIN_DATA/trajectory-html`. Re-generating a session
  replaces its prior viewer.
- Does not read credentials, `config.yaml`, auth files, SQLite databases, assets, `.env` files, or
  arbitrary user-provided paths.
- No network access, telemetry, subprocesses, installers, native binaries, or paid services. The
  generated page is fully offline and cannot initiate network requests under its CSP.
- Full-detail previews become part of the active MiniMax Code conversation, so users should request
  them only when that conversation is allowed to contain the underlying task text.

## Development and verification

```bash
node --test plugins/hetaoBackend/minimax-code-trajectory/test/*.test.mjs
npm run check
```

The tests use isolated temporary data and Plugin data directories. They cover data-dir precedence,
session discovery, summary/full privacy boundaries, secret redaction, malformed and oversized
JSONL, input/output symlink rejection, manifest-only sessions, event limits, HTML generation,
Browser handoff instructions, and the real MCP stdio process boundary.

## License

Apache-2.0. See [LICENSE](LICENSE).
