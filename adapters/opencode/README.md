# OpenCode adapter

`adapters/opencode/` connects OpenCode to LCU's computer-use runtime. It exists because OpenCode is not one of the hosts `lcu setup` knows: the adapter is self-installing and never runs `lcu setup` — the only LCU interaction outside a session is a read-only `lcu --version` during install. It has three parts:

- `relay.mjs` — a stdio MCP server that OpenCode starts as `mcp.lcu`. It stands between OpenCode's model and the installed LCU, drives the runtime through the shared CUA client (`../client.mjs`), and owns turn identity, session exclusion, and the singleton election.
- `plugin/` — a zero-dependency OpenCode V2 plugin that translates session lifecycle events into the relay's token-gated Unix-socket IPC, so turns actually end.
- `install.mjs` — deploys the relay's import closure and the plugin into a flat prefix and registers both in `~/.config/opencode/opencode.json`.

Scope (v0.4 ruling, 2026-11-04): stability, lifecycle, and anti-self-approval — not approval presentation. OpenCode Desktop 2.2.5 silently answers every MCP `elicitation/create` with accept; the user never sees a per-app approval form (measured and ruled out as fixable on our side; see the [verification record](../../docs/verification/opencode-adapter-2026-11-04.md)). The user accepted auto-approval for personal use, so the relay answers approvals itself — accept, after the shared client's host guard has declined the apps that must never be approved. The defenses documented below are the ones that do not depend on asking anyone.

## Requirements

- macOS on Apple Silicon (the installer refuses other platforms).
- LCU installed — `~/.local/share/lcu/current/bin/lcu` by default, `--lcu <path>` overrides.
- ChatGPT.app installed. The runtime drives the installed app; the installer also prefers its bundled `cua_node` (`/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node`) for the relay command and falls back to the system Node that runs the installer.
- OpenCode ≥ 2.2 (read from `/Applications/OpenCode.app/Contents/Info.plist`; a missing plist warns instead of blocking).
- Node ≥ 22 to run the installer itself.

## Install / uninstall / refresh

```sh
node adapters/opencode/install.mjs --yes        # install
node adapters/opencode/install.mjs --refresh    # redeploy over an existing install (idempotent)
node adapters/opencode/install.mjs --uninstall  # remove the adapter's entries and prefix
```

Options: `--prefix <dir>` (default `~/.local/share/lcu-opencode/current`), `--config <path>` (default `~/.config/opencode/opencode.json`), `--lcu <path>`. Without `--yes` the installer prints its plan and asks on a TTY; a non-interactive run without `--yes` is refused. Exit codes: `0` ok, `1` usage error, declined plan, or incomplete uninstall, `2` environment failure (wrong platform, unusable lcu, OpenCode too old, unreadable config).

What install does:

- Derives the relay's local import closure statically from `relay.mjs` and deploys it flat into the prefix. The repo's `../client.mjs`-style imports would escape a flat prefix, so the deployed copies import the same files by name instead; before anything is written, every relative import of every deployed file is verified to resolve inside the prefix, and a closure this layout cannot flatten fails the install loudly instead of shipping a broken relay.
- Copies `adapters/node_modules` beside it (the only runtime dependency is `@modelcontextprotocol/sdk`) and the plugin directory verbatim (zero dependencies, nothing to npm-install).
- Rewrites `opencode.json`: `mcp.lcu` becomes `{type: 'local', command: [<node>, <prefix>/relay.mjs, --lcu, <lcuPath>]}` (an existing `mcp.lcu` entry is overwritten with a warning) and `<prefix>/plugin` is appended to `plugins` (deduplicated). Every other field is preserved, the previous file is backed up to `opencode.json.bak-lcu-opencode`, and the rewrite goes through a temp file and rename.
- Writes `install-manifest.json` into the prefix. `--uninstall` removes `mcp.lcu` only when its command points at this prefix, removes the plugin entry, and deletes the prefix only when the manifest proves the installer wrote it (otherwise `--yes` is required). The state directory and the config backup are left in place.

Quit and reopen OpenCode completely after installing, refreshing, or uninstalling, so `mcp.lcu` and the plugin reload.

## How it works

```
OpenCode  (one MCP client per project directory)
    │ stdio (mcp.lcu)                       in-process plugin
    ▼                                            │ session.execution.* → bind / turn_ended
relay.mjs  (stdio MCP server) ──── token-gated Unix socket ◄────┘
    │  model-visible tools: js, js_reset only
    │  identity (_meta sessionID) · session mutex · singleton lock
    │  elicitation: host-guard decline first → auto-accept, metadata logged
    ▼ stdio MCP
lcu  (~/.local/share/lcu/current/bin/lcu — the original CUA MCP server, started lazily)
    ▼ native pipe
ChatGPT.app CUA runtime  (the Sky helper performs the desktop work)
```

**Tools.** The model sees exactly `js` and `js_reset` with the original descriptors, passed through unmodified. `turn_ended` and `js_add_node_module_dir` stay host-only and are refused by name. The relay declares no server instructions: the `js` tool description carries the full cua_repl guide, which is how guidance reaches the model on this host.

**Identity and turns.** OpenCode tags each `tools/call` with `_meta['ai.opencode/sessionID']`; the relay uses it as the session identity and mints a turn UUID per prompt round. When the meta is missing the relay falls back to a stable per-connection name (`opencode-conn-<hash>`); setting `LCU_OPENCODE_IDENTITY=strict` in the relay's environment refuses such calls instead. A `bind` from the plugin ends the session's previous open turn (`Stop` when idle, `Interrupt` when a call is still in flight), and a failed turn end is retried before that session's next call. On exit (SIGTERM, SIGINT, stdin EOF) the owner ends every open turn upstream with a 2-second drain budget, closes LCU, and removes its lock, token, and socket.

**Singleton.** OpenCode starts one MCP client per project directory, and LCU's runtime is single — the measured failure mode of bare registration is several runtime processes disconnecting each other's Sky connections. The relay is therefore a per-state-directory singleton. State lives in `~/.local/state/lcu-opencode` (`LCU_OPENCODE_STATE_DIR` overrides it, shared by relay and plugin) holding `relay.lock`, `relay.token` (mode 0600), and `relay.sock`. The first relay becomes the owner; every later one serves static standby `js`/`js_reset` descriptors whose descriptions say why calls fail, and retries the lock on each call — a takeover upgrades it in place (fresh token, IPC server, lazily connected upstream). A lock naming a dead process is removed and retaken.

**Lifecycle plugin.** The plugin maps OpenCode events to relay IPC, one short connection per message (send, wait up to 1 s for the ack, close); a missing socket or token, and every other failure, is skipped with a throttled `[lcu-opencode]` warning and never propagates into the session. This is the SPEC §1.8 table:

| OpenCode event | data | → relay IPC |
|---|---|---|
| `session.execution.started` | sessionID | `bind` |
| `session.execution.succeeded` | sessionID | `turn_ended {event:'Stop'}` |
| `session.execution.failed` | sessionID | `turn_ended {event:'Interrupt'}` |
| `session.execution.interrupted` | sessionID | `turn_ended {event:'Interrupt'}` |
| `session.deleted` | sessionID | `turn_ended {event:'Interrupt'}` (the session is gone) |
| `session.idle` / `session.status` | — | not consumed |

A `tool.hook('execute.after')` backstop re-binds a session whose started event never surfaced when an lcu-named tool ran (through Code Mode the js tool surfaces under names like `lcu_js`). Bookkeeping only: tool arguments and results are never read. Every IPC failure becomes a throttled `[lcu-opencode]` console warning (one per kind per 60 s) and never propagates into the session.

**Approvals.** Approval requests never reach OpenCode. Inside the shared client, the host guard declines first (below); everything else is answered `accept` and logged. `_meta.persist` ("always") is deliberately ignored — the relay never grants permanent allowances on the user's behalf.

## Security posture

Read this before trusting the adapter with anything you care about.

- **Per-application approval does not exist on this host.** OpenCode Desktop 2.2.5 auto-accepts every `elicitation/create` (measured; independent of its "auto-accept permissions" toggle), so once an app is allowed, every desktop action the runtime offers toward it is effectively pre-approved. This is the user's informed v0.4 decision for personal use, recorded in the design document — not an oversight, and not a claim that OpenCode presents approvals. If OpenCode ever renders `mcp-elicitation` forms, the relay can be switched back to forwarding them.
- **The host guard refuses the app hosting this agent.** `adapters/host-guard.mjs` declines a native-app approval naming OpenCode (`ai.opencode.desktop`) — statically, and via ancestor-bundle detection that covers whatever app actually hosts the session — before the auto-accept policy runs, so the model cannot use computer use to control OpenCode itself. Lookup failure falls back to the static list; `LCU_ALLOW_AGENT_HOST_APPROVAL=1` disables the guard for approval-flow tests only.
- **The runtime's own hard refusals still apply.** Terminal and iTerm2 (and Codex) are refused by the original runtime regardless of any allowance, independently of this adapter. Editors and IDEs are deliberately not guard-listed because they are ordinary computer-use targets.
- **The diagnostic log carries metadata only.** The relay writes `~/Library/Logs/LCU/opencode-*.jsonl` (rotation and retention pruning per `adapters/diagnostics.mjs`): relay start/stop and role, identity source, per-call timing, approval target app / connector / risk level, turn-end outcomes, session-busy events. Tool arguments and results are never written; strings are truncated.
- **`lcu apps` is the audit surface.** It lists the permanent allowance store; allowances are granted or revoked via `lcu apps allow <App>` / `lcu apps revoke <App>` (Touch ID or password). This adapter's relay ignores `_meta.persist`, so it never adds entries itself — review the list after sessions.

## Known limitations

- **`listApps().windows` is always empty.** The kernel's worker sandbox blocks `CGWindowList` inside the js process, so window enumeration returns nothing even though apps enumerate; AX reads, screenshots, and actions all work because they are relayed through the Sky helper outside the sandbox. Harmless, measured, and documented — but do not build automations that depend on in-worker window lists.
- **A second project directory gets an explicit in-use error.** `LCU is in use by another OpenCode session (owner pid N). Switch to that OpenCode window or close it, then retry here.` That is the singleton working as designed, not a fault: one runtime, one owner. Once the owner relay exits, its lock is removed and the next call takes over.
- **Guidance reaches the model only through the `js` tool description.** The relay sends empty server instructions and never rewrites descriptions, so anything OpenCode does to tool descriptions directly shapes what guidance the model gets.
- **Chrome and computer audio are untouched.** The relay starts LCU without the Chrome opt-in and passes no approved-origin list; both features are LCU opt-ins (`--chrome`, `--audio`) and are untested through this adapter.

## Troubleshooting

- **Start with `lcu doctor`.** It reports the runtime's state, including the macOS privacy grants, before you touch OpenCode.
- **`LCU could not be reached. Check that LCU is installed and try lcu doctor; then restart OpenCode and retry.`** — the relay could not start the launcher: LCU missing at the configured path (reinstall or fix `mcp.lcu`'s `--lcu` argument), or the runtime failing to start (see `lcu doctor`).
- **`LCU is in use by another session (<id>).`** — a different OpenCode session inside the same owner relay is mid-call. Wait for it to finish or switch to that session; the model should be told, not left retrying.
- **`LCU is in use by another OpenCode session (owner pid N).`** — a relay from another project directory owns the runtime. Work in that window, or close it; the next call here takes the lock over.
- **`LCU is still finishing the previous turn. Try again in a few seconds.`** — a turn end the runtime refused is being retried before this call. Usually clears by itself.
- **`identity_refused: OpenCode did not provide a session id`** — you (or the environment) set `LCU_OPENCODE_IDENTITY=strict` and the call carried no `_meta` session id. Unset it to restore the per-connection fallback.
- **`Computer Use server error -10005: cgWindowNotFound` on a bind or screenshot** — the target app's window is not on screen right now: the screen is locked (you were away), the window is on another Space, or the window was closed while the app kept running. Bring the window to the front (or unlock the screen) and retry; Finder's Desktop always binds, which makes it a good smoke target.
- **Permissions.** Screen recording must be granted to **ChatGPT**, accessibility to the **Codex Computer Use** helper — the grants belong to the signed identities that do the work, not to OpenCode. After granting, quit and reopen OpenCode so the runtime processes restart with the grants; a grant without a restart looks exactly like a missing one.
- **Logs.** `~/Library/Logs/LCU/opencode-*.jsonl` for the relay (metadata only), `[lcu-opencode]` warnings in OpenCode's output for the plugin, and OpenCode's own MCP log for transport errors.