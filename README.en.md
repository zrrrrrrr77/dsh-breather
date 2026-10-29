# dsh-breather

**Pause a running turn. Take a breath. Pick up exactly where it stopped.**

A DSH turn can run for a long time — dozens of tool calls, minutes of streaming. Until now
your only options were to let it finish or to stop it, and stopping aborts the turn: to carry
on you have to send a new message, which re-sends the whole context and pays for it again.

dsh-breather adds the third option. It holds the turn right before the next model request,
then lets the loop continue from that point when you hit Resume. No new request, no re-sent
context, no tokens spent twice. The live timer freezes while it waits and leaves paused time
out of the count.

![Pause / Resume button, frozen timer and the sidebar pause icon](pause-control.png)

## Seven notes

1. **Zero-cost pause.** Pausing makes no new request. The current step finishes, then the turn
   holds; only the button or a new message resumes it. Background wakes — subagent completion,
   scheduled reminders — cannot.
2. **Sidebar and timer.** The session row swaps its spinner for a pause glyph; the live timer
   and its shimmer animation freeze, paused time is not counted, and resume continues from the
   pre-pause value.
3. **Two paused states.** "Pausing" (request sent, current step still running) and "paused"
   (the gate is actually held) are shown as different button labels.
4. **Scope.** One pause affects only the current session.
5. **The turn summary still shows wall-clock time.** The "Thought for X" line is
   `turn.end - turn.start` and therefore **includes paused time**. This is a core limitation;
   the plugin does not patch it, to stay compatible across DSH versions. You can patch it
   yourself, but that change dies on the next DSH update.
6. **A restart does not keep the pause.** After a DSH restart, clicking Resume terminates the
   turn and pays tokens for a new "continue" message. There is currently no way to keep a
   conversation paused across a restart.
7. **A broken timer module cannot break pause.** If a DSH update breaks the timer takeover
   (core DOM hooks), the UI falls back to the stock display; pause and resume keep working and
   no extra tokens are spent.

![Notes 5–7 as an image (same text as above)](notes.png)

## What it does

- While a session is running, a **Pause** button appears at the right of the composer, next to
  the model picker and on the same row as the stop button.
- Click it and the current step finishes normally — streaming output and running tools are not
  interrupted. The turn is held right before the next model request, and the button becomes
  **Resume**.
- Click **Resume** and the loop continues from the held point. Cost: zero.
- Until the gate engages the button reads "Pausing…"; clicking again cancels the request.
- Once held, the live timer freezes as `Paused · 12m 3s`. Paused time is excluded, so resume
  continues from the frozen value instead of jumping forward.
- In the sidebar the paused row shows a blue pause glyph; other rows keep spinning. The row's
  hover card gains one extra line describing the state.
- Stop (or Esc Esc) still works while paused: the gate is released together with the cancelled
  turn and nothing hangs.
- **There is no timeout.** A paused session stays paused until you resume it.
- Sending your own message while paused resumes the turn (it counts as "continue").
  Background wakes — subagent completion, scheduled reminders — do not.

## What it cannot do

- **It cannot interrupt an in-flight model response.** The pause takes effect at the next
  request boundary, so a long tool call or a long answer finishes first. To stop immediately,
  use the stop button.
- It only affects the current turn. Subagents, background jobs and scheduled tasks keep
  running.
- If a subagent's inline session renders its own timer next to the main one, only the main
  conversation timer is taken over. When the plugin cannot tell which timer is the main one,
  it touches **none** of them and reports the degradation — showing a wrong number in someone
  else's pane would be worse than leaving the clock alone.

## Self-check

Two effects depend on core DOM hooks. When a hook disappears, the client notices within a few
seconds and says so instead of failing silently:

- **Timer**: once the hook has been seen, 6 consecutive misses (about 4.2 s) mark it degraded
  and stop the 700 ms re-attach loop. A cold page — the hook has never been seen yet, for
  example a long transcript still rendering — gets 20 attempts (about 14 s).
- **Sidebar rows**: only when `[role="treeitem"]` rows exist and the whole page has no
  `data-row-key` at all.
- **Timer scope**: several timers on screen but none that can be identified as the main
  conversation's.

A degradation logs one `console.warn`, appends a note to the button tooltip, and stops the
related takeover. The gate, the button states and zero-cost resume keep working. The flag heals
itself: when the hook shows up twice in a row it is cleared, with a `console.info` line.

Labels follow the core UI language (`<html lang>`, falling back to `navigator.language`).
Chinese gets Chinese copy; every other language falls back to English.

## Install

```sh
dsh plugin --profile <name> add dsh-breather
```

The package declares `dsh.bundle`, so installing it appends its patch layer to the profile and
the host half starts with the next DSH launch. The browser half is loaded by the Web UI
(`dsh.client.platform: web`); reload the page afterwards.

`engines.dsh` is `>=0.2.1-rc.2 <0.3.0-0`. The lower bound must carry `-0`, otherwise semver
does not match prerelease builds such as `0.2.1-rc.x` and DSH refuses to install the bundle.

Restart DSH completely after installing or upgrading — the host half is loaded once at startup.
Client-only changes take effect on a page reload.

Remove it with:

```sh
dsh plugin --profile <name> remove dsh-breather
```

If you registered the plugin row by hand in your profile's `cordis.patch.yml` before, delete
that row first — otherwise the plugin is mounted twice and you get two gates and two pollers
for the same session.

## Configuration

Override the row in your own profile's `cordis.patch.yml` if you need to. A patch replaces the
**whole** `config` object, so restate every key you want to keep.

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | Master switch |
| `engagedTimeoutMs` | `0` | Optional auto-release after a held pause. `0` means never (default) |

The HTTP route is fixed at `/api/session-pause` and cannot be changed: the browser half
hard-codes the same path, so a host-only switch would just leave the button blind.

## How it works

Host half (`index.js`):

- Hooks `agent/pre-step`, which the agent loop calls — and awaits — before every model
  request. Awaiting a gate there holds the turn; returning `next()` continues it.
- The turn's `AbortSignal` is part of the hook payload, so Stop / Esc Esc releases the gate and
  rejects the step cleanly.
- `agent/status` (non-running) releases the pause; `agent/inbox/inserted` releases it only for
  messages whose source is the user.
- Per-session state is pruned once it is neither paused nor holding a timer baseline. A paused
  entry is **never** released by cleanup: an orphaned pause whose agent is gone is hidden from
  the UI after three consecutive misses, but keeps the gate state.
- `/api/session-pause` serves `GET` (snapshot) and `POST` (`pause` / `resume` / `baseline`),
  owner peer only. `baseline` records how far the turn had run when it was paused, so a page
  reload does not lose the offset. Values above 30 days are rejected.

Browser half (`client.js`):

- Registers a cordis plugin through `window.__ModuleLoader__` and three slots:
  `conversation.input.right` (the button), `sidebar.session.row.leading` (the row glyph, only
  rendered for running rows once the core renders that slot) and `sidebar.session.row.hover`
  (one extra line in the hover card).
- Polls the route (900 ms visible, 4 s hidden, 20 s while it returns 404) and shares one
  snapshot between all composers.
- Clicks send the **target** state, never a toggle, and every request carries a 5 s timeout. A
  timeout is treated as "outcome unknown": the client re-reads the host state instead of
  claiming failure. Only an explicit refusal produces a one-line notice next to the button —
  the button's own state label is never replaced.
- The live timer is corrected through a `MutationObserver`: one text node plus the
  `data-shimmer-text` attribute of the shimmer layer. Each node keeps the prefix and suffix it
  was first seen with; nodes that never carried a duration are left alone.

## Development

```sh
npm test                       # host, wiring and client suites
node tools/browser-rig.mjs     # real Edge + real React + real DOM/CSS (29 checks, mock host)
node tools/check-release.mjs   # pre-publish checklist (metadata, pack contents, listing, endpoints)
```

`tools/`, `test*.mjs` and `packaging/` are **not** shipped in the npm package. The browser rig
needs one download of React (vendored into `smoke/vendor/`, offline afterwards) and a browser
process that can create named pipes, so it has to run outside the DSH sandbox.

## License

MIT
