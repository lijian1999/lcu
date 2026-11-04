# OpenCode adapter verification, 2026-11-04

This record covers the second-phase host experiments under bare LCU registration and the
acceptance of the OpenCode adapter's stages 1–3 (`adapters/opencode/`), all on 2026-11-04.
Host: macOS Apple Silicon, OpenCode Desktop 2.2.5 (`ai.opencode.desktop`), LCU 0.13.5,
ChatGPT.app 26.1027.51404 for the afternoon experiment session as recorded in the design
document (`docs/opencode-adapter-design.md` §2.2). The adapter work is commits `363923c`
(relay core), `69a07ed` (lifecycle plugin), and `c13aa9b` (installer); the phase-2 results
themselves are recorded in the design document (commit `8772f47`).

The record states what was done, how, and what it proves. Everything it does not prove is
listed under "Not claimed" at the end.

## E1 — approval elicitation never reaches the user (failed)

Method: in an OpenCode session with bare LCU registration (no relay, no plugin), an agent
triggered `getApp` binding and a control action (`performSecondaryAction(0, 'Raise')`)
against three apps that were not in the allowance store (Activity Monitor, Typora, Mail)
in sequence. The user watched the screen for approval UI, then repeated the run with
OpenCode's "auto-accept permissions" toggle switched off.

Result: every call succeeded silently. No approval form appeared at any point, with the
toggle on or off.

Discrimination experiment: a standalone MCP probe client that declares the elicitation
capability issued the same call against Typora. The probe received the original
`elicitation/create` request (full JSON preserved at `/tmp/elicit_request_1.json`; form
mode, empty `requestedSchema`, `_meta` naming `connector_id: computer-use`,
`tool_name: get_app_state`, `tool_params.app: abnerworks.Typora`, `riskLevel: low`,
`persist: [session, always]`). The probe answered `cancel` and the runtime failed closed
with "Computer Use was not approved to use Typora". Control: the identical call inside the
OpenCode session succeeded with no form.

Conclusion: LCU's approval machinery is intact — it issues elicitation requests, fails
closed on cancel, and carries persist semantics. OpenCode Desktop 2.2.5's MCP client
answers `elicitation/create` with accept before any user interaction, independent of its
auto-accept-permissions toggle, and the empty `requestedSchema` rules out a "default
answer" explanation. This matches the upstream issues (`opencode#51856`, `#23066`,
`#28567`: the session-form filter keeps only `question`/`websearch.provider` kinds;
`#58184` closed 2026-10-22, but Desktop 2.2.5 still presents nothing). Consequence: the
v0.4 user ruling of 2026-11-04 accepts auto-approval, removes approval presentation from
the adapter's scope, and makes the host guard the primary hard gate.

## E2 — screenshot bytes reach the model (passed)

Method: in the same bare-registration session, after permissions were granted, the agent
called `getScreenshot()` against Activity Monitor and inspected what the model received.

Result: a 211,946-byte screenshot reached the model, and its visible content matched the
accessibility tree read in the same session. The check was byte-count plus visual
comparison against the AX state; no SHA-256 comparison was taken.

## E4 — MCP connection topology (worse than expected)

Method: process and log observation while more than one OpenCode project directory was
open and issuing LCU calls.

Result: OpenCode starts one LCU MCP server per open project directory (the home view
counts as one); two to three `runtime.mjs` processes were observed concurrently. Closing
the tabs does not stop the servers — they persist until the app is fully restarted. While
several instances were live, they disconnected each other's Sky connections (`MCP server
process exited` appeared repeatedly in the logs) and the js kernel's `cua` binding was
lost between calls. Consequence: the adapter deploys the relay as a per-state-directory
singleton (file lock) with explicit in-use errors instead of shared concurrency.

## Zero-window finding under bare registration

Method: differential probes during the zero-window troubleshooting, recorded in the design
document §2.2.2.

Result: `listApps()` enumerated 9 running apps with every `windows` array empty, while AX
reads, screenshots, and control actions all worked. The same Swift probe
(`CGWindowListCopyWindowInfo`) saw 206 windows outside the sandbox and 0 windows when run
with the LCU worker's `codex sandbox` parameters, identifying the worker sandbox as the
blocker; `LCU_NODE_REPL_SANDBOX` was confirmed by source reading to be a Linux-only no-op
on macOS, so the environment variable neither causes nor fixes this. The window lists
remain empty with the adapter installed (same worker sandbox); AX, screenshots, and
actions keep working through the Sky helper. This is benign but real: the adapter must not
depend on in-worker window enumeration.

Related observation: `lcu apps` prints the permanently allowed store, not the installed
apps — 8 apps were allowed on this machine before the session (carried over from
2026-11-02 Pi-adapter `always` grants), including Finder and Chrome. This is the audit
surface the README points at.

## Adapter acceptance

### Stage 1 — relay core (`363923c`), on-machine

Method: manual smoke per the implementation spec's acceptance recipe — a JSON-RPC probe
over stdio driving `node relay.mjs --lcu ~/.local/share/lcu/current/bin/lcu` with a
disposable state directory, plus the committed unit suite.

Result: `tools/list` returned exactly `js` and `js_reset` (no `turn_ended`, no
`js_add_node_module_dir`); a real `js` call against the installed LCU succeeded through
the relay (upstream started lazily, result passed through unchanged); a second relay on
the same state directory served the static standby descriptors and refused a call with
the owner-pid in-use error.

### Stage 2 — lifecycle plugin and IPC interop (`69a07ed`)

Method: the plugin's sender and the owner relay's IPC server were exercised together over
the real Unix socket with the relay-written token file (not the in-process test fakes),
sending the mapped `bind` / `turn_ended` / `ping` messages.

Result: the relay accepted the token-gated messages and ended the open turns they named.
The OpenCode-hosted event subscription itself (real `session.execution.*` events inside a
live Desktop session) is deliberately left to the pending on-machine checklist below.

### Stage 3 — installer (`c13aa9b`)

Method: run the installer, then exercise the deployed copy — the flattened import-closure
prefix with the rewritten `../` imports, launched exactly as `mcp.lcu.command` names it,
under ChatGPT.app's bundled node
(`/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node`).

Result: the deployed `relay.mjs` started under that node and completed a real `js` call
against the installed LCU, proving the deployed copy executes outside the repo tree and
that the import rewrite is sound at runtime.

### Production deployment and the idle-owner starvation (2026-11-04 evening)

`install.mjs --yes` was run against the real `~/.config/opencode/opencode.json` and
OpenCode was restarted, so the relay replaced the bare registration in production. The
restart immediately reproduced the E4 starvation in the real app: OpenCode had spawned a
relay for the home directory (the Start tab) and one for the working directory; the home
relay won the startup race and kept the singleton lock while permanently idle, so every
`js` call in the working session failed with the standby in-use error naming the owner
pid. Killing the idle owner freed the lock and the working session's next `js` call took
over (`relay_takeover` in the relay's diagnostic log, 89.9 s after its start) and ran
real computer use.

That incident produced the D3.1 idle-owner yield (see the relay commit "idle-owner
yield"): a standby whose call is blocked requests a step-down over the token IPC, and an
idle owner drains its open turns, closes its upstream, demotes itself to standby and
frees the lock; a busy owner refuses with `busy`. The yield path was verified on-machine
with two real relays on a disposable state directory (idle owner stepped down, the
standby's call succeeded through a fresh upstream). In-app validation of the yield path
is pending the next OpenCode restart, because relays keep their pre-yield code until
then; until that restart, a working session can still be blocked by an idle owner from
another directory (workaround: quit OpenCode and reopen, or kill the owner pid named in
the in-use error).

Known cosmetic quirk from the same deployment: OpenCode snapshots MCP tool descriptions
when it connects, so a directory whose relay was a standby at startup keeps showing the
standby tool description ("calls are refused…") even after its relay takes over; calls
work regardless, and the full cua guide reaches the model in the first call's result.

### On-machine checks through the live relay (2026-11-04, post-implementation)

Method: a stdio JSON-RPC probe drove `relay.mjs` against the installed LCU 0.13.5 with the
user at the computer, plus the relay's own diagnostic log
(`~/Library/Logs/LCU/opencode-*.jsonl`). These checks ran through the live production
relay after the deployment above.

- `approval_auto_accepted` was logged for `com.apple.ActivityMonitor` with the tool
  metadata (`connector_id: computer-use`, `riskLevel`), and no tool arguments or results
  appear in the log (checked: every line lacks an `args`/`code` field).
- A real screenshot of Typora's window through the relay returned a 39,271-byte PNG to the
  model (E2 semantics through the relay, after the earlier bare-registration screenshot
  had passed with 211,946 bytes).
- `js_reset` passed through and reported success; the worker-turn Interrupt bookkeeping
  inside the shared client ran under it.
- Targeting `ai.opencode.desktop` (OpenCode itself) was not completed live: the attempt
  hit a kernel-level crash in the runtime before the guard answered; the host-guard
  refusal for agent-host apps is covered by the committed unit tests instead
  (`adapters/opencode/test/relay-core.test.mjs`), and `ai.opencode.desktop` is in the
  shared guard's static list.

### Finding: `cgWindowNotFound` when the user is away

Repeated `-10005: cgWindowNotFound` failures on `getApp` bindings (Activity Monitor,
Mail, Typora, WeChat) while Finder's Desktop always bound were traced to the machine's
state, not to the adapter: with the user away (screen locked), regular apps' windows are
not on screen, and the runtime's window lookup fails with `-10005`; the shared client's
`CGWindowListCopyWindowInfo(.optionAll)` probe still lists those windows across Spaces,
so a window-listing probe alone is misleading. A Finder bind (the Desktop is always
present) is the control case. Bindings succeed again as soon as the user returns and the
window is on screen (verified live for Typora, above). Consequence for agents: treat
`cgWindowNotFound` on bind as "target window is not on screen (locked screen, other
Space, or closed window)", not as a permission or adapter failure.

### Test statistics (this tree, 2026-11-04)

- `node --test adapters/opencode/test/`: 70 tests, 70 pass, 0 fail, 0 skipped (63 through
  stage 3, plus 7 for the D3.1 idle-owner yield).
- `npm test --prefix adapters` (the upstream adapter suite; its glob covers
  `adapters/test/*.test.mjs` only, so the OpenCode tests above are not part of this
  count): 262 tests — 254 pass, 0 fail, 8 skipped. No new failures introduced by the
  adapter work.

## Not claimed

- **Chrome site approvals** — the relay starts LCU without the Chrome opt-in and carries
  no approved-origin list; Chrome behavior through this adapter is untested end to end.
- **Computer audio** — the `--audio` opt-in is not exercised by this adapter.
- **Windows** — out of scope (LCU defers Windows; the adapter is macOS-only and the
  installer refuses other platforms).
- **Linux** — untested; the `codex/sandbox-state-meta` handling of the Linux hosts has no
  OpenCode-specific treatment and was never exercised here.
- **Full on-machine Desktop walkthrough (M4)** — the checklist items that need a restarted
  OpenCode session (auto-accept logging in a live session, Esc → `Interrupt`, second-
  directory standby behavior in the real app, host-guard refusal in the real app,
  `js_reset` recovery, and Stop-driven temporary-tab cleanup, which additionally needs the
  Chrome opt-in) are pending and listed in the design document §6.3; nothing above claims
  them.
- **Organization/managed-policy environments** — never tested; OpenCode's counterpart to
  managed policy was not researched.

Two further boundaries: E3 (`_meta['ai.opencode/sessionID']` on `tools/call`) is
confirmed only indirectly, via the packet capture referenced in `opencode#51856`; it was
not retested directly in this session, and the relay's fallback identity exists for
exactly that gap. And the ChatGPT.app build involved (26.1027.x) is not one of LCU's
verified runtime pairs (`tested-versions.json` stops at 26.1013.40934); the adapter
records what ran and does not endorse the combination.