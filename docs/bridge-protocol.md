# Command Bridge Protocol

## Overview

The connector talks to PixInsight through JSON files. The Node side is `src/bridge.mjs` (`createBridge()`);
the PixInsight side is a PJSR watcher script generated from `pjsr/watcher.template.js` and started by the
connector itself (`src/runtime.mjs`). Paths per OS come from `src/platform.mjs`; liveness readings come from
`src/process-probe.mjs`.

Everything lives in the target folder (the workspace). Each target has its own bridge dir for the machine
it runs on and its own watcher, a script written into the target with that bridge dir baked in, which
serves only that dir. Nothing is read or written outside the target: no per-user folder, no registry.

Nothing here happens during MCP `initialize` or `tools/list`. The first tool call that needs PixInsight
writes the command, writes the watcher script into the target, starts PixInsight if needed, and launches
the watcher.

## Directory structure

In the workspace's state dir (`<workspace>/agentic/`, or `PIXINSIGHT_CONNECTOR_STATE`):

```
<workspace>/agentic/
  bridge/<machine-id>/
    commands/     # the connector writes {id}.tmp and renames it to {id}.json; the watcher claims it ({id}.running), runs it, deletes it
    quarantine/   # stale command files moved aside (by the connector or the watcher); never run
    results/      # the watcher writes {id}.json here; the connector reads and deletes it
    heartbeat     # watcher liveness: `starting <ms>`, `idle <ms>` or `busy <tool> <ms>` (ms since epoch),
                  # replaced via heartbeat.tmp + move where the platform allows
    last-stop     # why the watcher last stopped: `<reason> | <ms>` (`idle for 8s`, `abort requested`, `shutdown file`)
    watcher.json  # written at watcher start, before the first heartbeat: { watcherVersion, pixinsightVersion, startedAt }
    launches/     # one linger ticket per connector launch ({ lingerMs, at, pid }); each watcher takes one
    launch.lock   # the launch lock of this dir ({ pid, token, at }), created with O_EXCL
    shutdown      # if present, the watcher deletes it and stops
  watcher/<version>/<machine-id>/watcher.js   # the watcher serving bridge/<machine-id>/
```

**The machine id** is derived from this machine's hostname (`machineId()`, `src/machine-id.mjs`); no file
holds it. It is a readable prefix (the full hostname lowercased, other characters turned into `-`, at most 20
characters, `host` if nothing is left), then `-` and the first 8 hex digits of the sha256 of the raw hostname,
e.g. rig-north-example-co-1a2b3c4d. The hash keeps apart hostnames the prefix alone would merge
(`rig.north`/`rig.south`, two long names cut to one prefix, two all-non-ASCII names). A target on network
storage may be used from two machines at once, each with its own PixInsight: each machine works only in its
own subdir, with its own watcher script, so neither machine runs, answers or quarantines the other's commands.
Two machines with identical hostnames working in one target at once are not supported. A hostname that
changes (macOS may report a different name on another network) gives a new id and a new subdir: the old
subdir is left unused, and a watcher started by hand from the old subdir's script serves nothing.

**One target at a time** is the supported model. PixInsight runs one script at a time, so while one
target's watcher runs, a second target's launch waits in PixInsight's queue until the first exits (a few
seconds after its last command). A call in the second target that waits longer than 30 s for its watcher
fails with an error naming the possible causes: PixInsight still running another script (another target's
watcher, say), so retry, or a watcher script it could not open, which its Process Console explains.
Nothing is lost or run twice. Two connectors in the same target share its bridge dir and its one watcher.

**`set_workspace`** points the bridge at the new target's dir and its watcher (`setBridgeDir()`). It never
waits and never loses or repeats a command: a command already written finishes in the dir it was written
to, answered by that dir's watcher; commands written after the switch go to the new dir.

When the harness stops the connector (it closes its stdin, or sends SIGTERM, SIGINT or SIGHUP;
`exitOnStop()`), the connector removes its queued (unclaimed) commands, then exits. SIGKILL or a crash skips
that; the next connector to use that dir quarantines them (see Stale commands).

**Upgrading from 1.0.** Restart every session still running a 1.0 connector. Until then, the two versions
never run each other's commands and never run a command twice, but a call can fail while the other
version's watcher holds PixInsight, and two cold starts at the same moment can launch PixInsight twice. The
1.0 per-user folder is no longer used by 1.1 and is safe to delete once no 1.0 session is running.

## The watcher script

`materializeWatcher()` (`src/runtime.mjs`) writes `pjsr/watcher.template.js` to
`<state>/watcher/<version>/<machine-id>/watcher.js` (`watcherPathOf()`) before every launch, where
`<version>` is the connector's `package.json` version. Two tokens are replaced: `@@IMAGESOLVER@@` with this
platform's `ImageSolver.js` path, and `@@BRIDGEDIR@@` with the bridge dir it serves, as a JSON string
literal. A Windows path gets forward slashes (`toPixPath()`, `src/platform.mjs`); a macOS/Linux path is
kept as it is, so a backslash in a folder name there stays part of the name. The write is atomic
(`watcher.js.tmp`, then rename) and skipped when the file already has identical content. A target that
cannot be written fails the call before PixInsight is started.

This is the one path passed to PixInsight on a command line: `-x=<path>`, one argument, spawned without a
shell. A path with a space works on macOS (verified live with PixInsight 1.9.5); on Windows and Linux it is
unverified, and `workspace_info` and `doctor` say so for such a target (`spaceInPathNote()`).
PixInsight turns `-x=<arg>` into the console command `run -a="<after the first comma>" -x=auto "<before
the first comma>"`: it splits at the first comma before anything else (no quoting or `\,` escape protects
it) and runs whatever path comes before it, so a comma in the path runs a different path; a double quote
would end the quoted path early. A workspace whose state folder contains either is therefore unusable
(`scriptPathProblem()`, `src/workspace.mjs`): `set_workspace` refuses it and every tool that needs it fails
at once with the fix (rename the folder, or set `PIXINSIGHT_CONNECTOR_STATE` to a folder without one). The
launch checks the path again and never passes such a path to `-x=`. The watcher
`#include`s ImageSolver so that `run_script` snippets can use it (an eval'd snippet cannot `#include`).

## Command file

Written by the connector to `commands/{id}.tmp` in its bridge dir and renamed to `commands/{id}.json`, so the
watcher's `*.json` scan never reads one half-written (and quarantines it as unparseable, with no result).
If the command, its claimed `{id}.running` and its result are all absent for 3 seconds, the sender fails at
once instead of waiting out its 20-minute timeout: "not run; retry" if no watcher ever claimed it, otherwise
"whether any of it was applied is unknown" (a watcher may have run it and failed only to write the result).

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2026-09-22T10:30:00.000Z",
  "senderPid": 12345,
  "tool": "run_script",
  "process": "__script__",
  "parameters": { "code": "ImageWindow.windows.length" },
  "executeMethod": "executeGlobal",
  "targetView": null
}
```

| Field | Type | Description |
|---|---|---|
| `id` | string (UUID) | Unique command identifier; also the result file name |
| `timestamp` | string (ISO 8601) | When the command was written. The watcher refuses a command without one |
| `senderPid` | number | Process id of the connector that wrote it; a command whose sender has exited is an orphan |
| `tool` | string | The watcher command: `run_script` or `list_open_images` |
| `process` | string | `__script__` for `run_script`, `__internal__` for `list_open_images` |
| `parameters` | object | `{ code }` for `run_script`, `{}` for `list_open_images` |
| `executeMethod`, `targetView` | string, string \| null | Always `executeGlobal` and `null` from this connector |

The connector sends exactly two commands:

- **`run_script`** — every tool, including `run_process`, works by generating a PJSR snippet and
  sending it as `run_script`. `run_process` builds `new <Process>`, assigns the JSON parameters and calls
  `executeOn(view)` or `executeGlobal()`; there is no separate process command.
- **`list_open_images`** — returns `outputs.images`, one `{ id, filePath, width, height, channels, isColor,
  bitDepth }` per open window. The server uses it to reject calls that name a view that is not open
  (`View not found: …`).

The watcher runs only these two. A command with any other `tool` gets an `error` result ("Unknown
command: …") and is not run.

## Result file

Written by the watcher to `results/{id}.json` in its bridge dir:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2026-09-22T10:30:01.000Z",
  "status": "success",
  "process": "__script__",
  "duration_ms": 412,
  "outputs": {
    "consoleOutput": "3",
    "consoleErrors": []
  },
  "message": "Script executed successfully"
}
```

On failure, `status` is `"error"` and `outputs`/`message` are replaced by
`"error": { "message", "type", "stack" }`. A `status` of `"running"` is tolerated by the connector (it keeps
waiting) but the current watcher never writes it.

### `run_script` results

The snippet is evaluated with `eval` inside a function whose `processEvents` parameter shadows the global
with one that throws `MCP_ABORTED` once Pause/Abort is pressed. `outputs.consoleOutput` is the string value
of the snippet's last expression (`"Script executed."` if it is `undefined`). `outputs.consoleErrors` holds
the last six `** Warning` / `*** Error` lines the Process Console printed while the snippet ran: a process
whose `executeOn()` returns false throws nothing, so these lines are the only explanation. A thrown error
becomes `Script error: <message>`, with the console lines appended.

On the Node side, `pjsr(code)` sets `result` to `outputs.consoleOutput` and `status` to `ok` unless it is
`error`. The MCP server appends console lines to the tool result and marks the result as an error when any
of them is a `*** Error` line, except the few a tool declares benign (`BENIGN_CONSOLE_ERRORS`).

## Watcher lifecycle

PixInsight greys out image right-click and STF while any script runs, and a script's timers die when it
returns, so the watcher cannot stay resident without locking the UI. It is launched on demand and exits
after an idle linger.

Before each command, `ensureWatcher()` (`src/bridge.mjs`):

1. returns at once if the watcher is alive: `heartbeat` is `idle` and under 5 s old, `starting` and under
   60 s old (written once at start-up, before UI work that cannot refresh it; not alive if PixInsight is
   confirmed not running or started after the beat), or `busy` (a running
   command blocks the loop, so a `busy` beat stays alive however old — unless it is over 30 s old and
   predates the PixInsight process, in which case it is a leftover from a crash and is removed). An empty
   or unparseable heartbeat (a read that landed mid-rewrite) is read again up to 3 times, 25 ms apart,
   before it counts as no watcher;
2. throws `BridgeAbortError` if `last-stop` says `abort requested` or `shutdown file` and was written after
   this bridge was created — an abort is never silently undone;
3. takes this dir's launch lock (see "One launch at a time" below). If a watcher comes up while it
   waits, some other server launched it and this one launches nothing. After taking the lock it checks
   both liveness and the step-2 deliberate-stop test again, so a server that waited while the user aborted
   the watcher another server was starting throws `BridgeAbortError` instead of launching a second one;
4. writes the watcher script into the target (see "The watcher script"), then starts PixInsight if it is
   not running (`ensurePixInsight()`, `src/runtime.mjs`), holding the machine's launch mutex (see "One
   launch at a time"): spawns the binary detached and waits up to 90 s for it. It does nothing when `PIXINSIGHT_CONNECTOR_AUTOSTART=0`, and never spawns
   when the process probe cannot tell whether PixInsight is running (a second instance is worse than a
   clear error). A failure, or a PixInsight confirmed not running afterwards, is a `BridgeCrashError`; an
   executable that cannot be run at all (spawn reports an error, e.g. a missing `PIXINSIGHT_BIN`) fails at
   once, naming the path;
5. moves orphaned command files from `commands/` to `quarantine/` in this bridge dir (see "Stale commands"
   below), and removes linger tickets no watcher of the running PixInsight can use (see "A linger per
   launch" below);
6. writes a linger ticket to `launches/` (the linger, default 8000, `PIXINSIGHT_CONNECTOR_LINGER_MS`), runs
   `PixInsight -x=<materialized watcher.js>` and waits up to 30 s for a heartbeat. If `last-stop` shows
   that a watcher started and exited on idle after this launch without its heartbeat being seen, the
   watcher is launched again (at most twice more). The 30 s is per launch, so with both relaunches the
   wait can reach about 90 s; an `abort requested`/`shutdown file` stop in that window
   is a `BridgeAbortError`. A timeout's message lists what was checked: launches, the last heartbeat seen,
   `last-stop` relative to the launch, and whether PixInsight was running. When PixInsight is running and
   no heartbeat was ever seen, it first names the two possible causes without claiming either: PixInsight
   still running another script (another target's watcher, say), so retry; or PixInsight could not open the
   watcher script, which its Process Console explains. Every relaunch writes its own
   ticket. A launch that gives up removes its own tickets when no watcher can take them any more (the spawn
   failed, or PixInsight is confirmed not running); while PixInsight runs they stay, since the `-x` may still
   be queued and a watcher that starts without a ticket stays resident (see "A linger per launch").
   The lock is released when the watcher is seen alive or the launch gives up. If the spawn itself
   reports an error (the executable cannot be run), the launch fails at once with the path and the fix.

The call log (`src/call-log.mjs`) records each new watcher start once, as a `watcher start` event with the
PixInsight version from `watcher.json`, on the call whose command that watcher answered first.

`send()` writes the command file before `ensureWatcher()` runs, so a watcher launched for it sees it on
its first look and its idle-exit last look can never miss it. The pickup relaunch check below counts
from when `ensureWatcher()` saw the watcher alive, not from the write, so a slow launch never makes a
starting watcher look overdue. If the watcher disappears before picking the command up more than twice
for one send (for example, it keeps dying during start-up), the send fails with the start-up diagnostics
instead of relaunching until the 20-minute timeout. If the command has been claimed (`{id}.running`) and
the watcher is no longer alive, the watcher died while running it: the send fails at once with an error
saying so, and the command is never re-run (part of it may already have been applied). Any way a send gives up (timeout, crash,
abort, launch failure) deletes its own command file (and its claimed `{id}.running`), so no later watcher
runs a command nobody is waiting for.

### One launch at a time

PixInsight does not reject a second `-x` while a script runs: it queues it and starts that script after the
running one returns. Two servers that both saw "no watcher" and both launched therefore got a second watcher
that started once the first had exited. Three rules prevent that from hurting:

- **The launch mutex.** Starting PixInsight itself is guarded machine-wide, across targets, by an exclusive
  bind of one loopback TCP port, `127.0.0.1:29467` (`PIXINSIGHT_CONNECTOR_LAUNCH_PORT` names another;
  `createLaunchMutex()`, `src/runtime.mjs`). No file is involved and the OS releases it when its holder
  exits. It is held only while `ensurePixInsight()` starts PixInsight and waits for it, and the holder
  answers every connection to the port with a one-line banner and closes it. After every acquire the
  connector looks again whether PixInsight is running before starting it. A connector that finds the port
  bound connects to it: the banner means another connector is starting PixInsight, so it waits (up to the
  90 s start plus 30 s); no banner within a second (another program owns the port) means it starts
  PixInsight at once without the mutex and logs that once. If the port cannot be bound for any other
  reason, or a connector holds it past that wait, the connector likewise starts PixInsight without it.
- **The launch lock.** `<bridge dir>/launch.lock` is created with `O_EXCL` (`{ pid, token, at }`), so
  at most one server in this target on this machine decides to launch its watcher at a time. It is held from the
  decision to launch until the watcher is seen alive or the launch gives up. A waiting server polls every
  100 ms and stops waiting, without launching, as soon as a watcher is alive. A lock whose holder process has
  exited, or that is older than 5 minutes (longer than a wait on another connector's 90 s PixInsight start, a 90 s
  autostart and three 30 s launches), is taken
  over. Before removing a stale lock the connector re-reads it and leaves it alone if another waiter has
  already replaced it; two waiters deciding in the same instant can still race there, which at worst means one
  extra queued launch, and that launch is harmless because of the next rule.
- **A linger per launch.** The watcher's idle linger used to come from a single shared file, which
  the first watcher consumed; the queued second watcher then found none and stayed resident, locking the UI.
  Now every connector launch writes its own ticket to `launches/`, and each watcher takes the oldest fresh
  one at start-up. A queued second watcher still finds its own ticket and exits on idle. A watcher that
  finds no ticket was started by hand and stays resident, as before, which keeps `PIXINSIGHT_CONNECTOR_AUTOLAUNCH=0`
  plus a hand-started watcher working.

  - A ticket is written as `<ms>-<uuid>.tmp` and renamed to `.json`, and the watcher lists only `*.json`,
    so it never reads half of one. An unreadable `.json` ticket whose name says it was written less than
    60 s ago is skipped, not deleted, in case another launch is still writing it; older unreadable ones are
    removed.
  - PixInsight can hold a queued `-x` for as long as the script ahead of it runs, and a long user script
    (WBPP, say) can run for hours. Tickets therefore live 24 hours. Older ones are removed and ignored, so
    only a launch queued for more than a day can still come up resident.
  - Before each launch the connector removes the tickets no watcher of the running PixInsight can use: all
    of them when it has just started a fresh PixInsight process (nothing can be queued in a new process),
    otherwise those written before the running process started (when the process probe can tell).
  - What remains are tickets for launches this PixInsight has not run (yet): queued ones, or ones it dropped.
    **A watcher you start by hand takes such a spare ticket and exits after the linger (8 s by default)
    instead of staying resident.** Under `PIXINSIGHT_CONNECTOR_AUTOLAUNCH=0` this can only happen within a
    PixInsight session in which the connector also launched watchers itself. If it happens, restart
    PixInsight or empty `<bridge dir>/launches/`, then start the watcher again.

A queued second watcher cannot run a command twice. The first watcher deletes each command file after writing
its result, and it now claims each command before running it by renaming `{id}.json` to `{id}.running`, which
drops it out of every watcher's `*.json` scan. If the rename fails, that watcher remembers the file and never
runs it again itself. A `.running` file found while no watcher is alive belonged to a watcher that died
mid-command; the connector moves it to `quarantine/` before its next launch and never re-runs it.

`PIXINSIGHT_CONNECTOR_AUTOLAUNCH=0` skips all of this: the connector neither starts PixInsight nor launches the
watcher, and expects a watcher you started yourself. `PIXINSIGHT_BIN` / `PIXINSIGHT_DIR` override where
PixInsight is found.

Pause/Abort in the Process Console stops the watcher (`last-stop` = `abort requested`), and a running
snippet stops at its next `processEvents()`. The connector reports this as `STOPPED BY USER`; the
`resume_bridge` tool discards the bridge so the next command may launch the watcher again.

Pause/Abort stops **one target**: the one whose watcher is running. `last-stop` is written only in that
target's bridge dir, so a session working in another target is not stopped: its watcher, queued in
PixInsight behind the aborted one or launched on its next call, starts and carries on. To stop every
session, press Pause/Abort again each time another target's watcher starts, or end those sessions.

## Stale commands

A command is only meant to run while its sender is still waiting for it. Two independent guards keep an
orphan (a command left by a client that crashed, timed out without cleaning up, or never had a watcher)
from running on the next launch:

- **Connector**, just before launching a watcher (so only while no watcher of that dir is alive, when
  nothing can be legitimately queued behind a running command), in that bridge dir: every command file that
  is not one of this bridge's own
  pending commands is moved to that dir's `quarantine/` if its `senderPid` names a process that is no longer running,
  or if it is more than 5 minutes old by its `timestamp` (by the file's modification time when it has
  none) and its sender is not known to be running: a live sender may still be waiting for it, and removes
  it itself when it gives up. Five minutes covers a cold start (4 s pickup + up to 90 s behind another connector's PixInsight start
  + 90 s PixInsight autostart + 3 × 30 s watcher launches ≈ 4.6 minutes). It is not a hard ceiling: a sender whose watcher keeps dying
  during start-up can keep a command pending for several minutes of relaunches. That outcome is still safe,
  because a watcher that finally starts refuses such a command with the explicit "Refused stale command"
  error rather than running it late.
- **Connector**, the first time it writes into a bridge dir (a target an earlier session used, or one it
  just switched to), before its own command: command files there whose `senderPid` names a process that is
  no longer running are moved to `quarantine/`, even while that dir's watcher is alive.
- **Watcher**, before running each command: it refuses a command with no valid `timestamp`, one written
  more than 5 minutes before the watcher started, or one more than 30 minutes old (longer than any sender
  waits). A refused command is moved to `quarantine/`, gets an `error` result ("Refused stale command: …"),
  and is logged to the Process Console. This also covers a watcher started by hand. A command file that
  is not a JSON object is moved to `quarantine/` too, with no result, since it carries no id to answer to.
  A refused file the watcher can neither move nor delete (a
  locked file on Windows) is remembered by its file name (`mcpRefusedKey()`; ids are UUIDs) and skipped,
  so it cannot run twice, block the queue or keep the watcher from idling out.

Known limits:

- **`PIXINSIGHT_CONNECTOR_AUTOLAUNCH=0`.** The connector then waits up to 20 minutes for a watcher you start by
  hand, but that watcher refuses any command written more than 5 minutes before it started. The sender
  gets the explicit "Refused stale command" error, never a silent run; start the watcher first, or resend.
  (Kept deliberately: the watcher cannot check from PJSR whether the sender is still alive, and relaxing the
  pre-start check would let exactly the e2e's orphaned commands through.)
- **Commands without `senderPid`** (older connectors, hand-written clients) that are younger than
  5 minutes pass both guards; only their age protects against them.
- **Watchers this connector did not generate** (an older watcher script launched by an older client) have
  no watcher-side guard at all.
- **The connector's sweep runs only when it launches a watcher itself.** A watcher launched by someone else
  is protected only by its own guard.

## Polling and timeouts

Connector (`src/bridge.mjs`):

- polls `results/{id}.json` every 500 ms; a command times out 20 minutes after it was written
  (`Timeout: <tool>`);
- if the command file is still unconsumed after 4 s and the watcher is not alive (it may have exited on
  idle just as the command was written), relaunches it;
- every 10 s checks that PixInsight is still running; two consecutive confirmed "not running" readings are
  a crash (`BridgeCrashError`). A single miss is ignored because the check can be starved while
  PixInsight saturates every core, and an unknown reading never counts;
- when a bridge is created or re-pointed, deletes result files older than 5 minutes left in that dir by an
  earlier session.

Watcher:

- writes `starting` as soon as it starts, before showing the console, then `idle` from its first UI event
  pump on; it starts its idle clock only after that first pump, so a slow start cannot use up the idle
  linger;
- about every 500 ms while idle, checks its bridge dir's `commands/` (`mcpPendingCommandFiles()`),
  refreshing the heartbeat. A missing dir (a target deleted, a volume unmounted) has no commands;
- runs one command at a time, the first by sorted file name (ids are random UUIDs, so this is not arrival
  order): it claims it (`{id}.running`), runs it, writes the result into `results/`, then deletes the
  claimed file;
- exits after the linger from its launch ticket with no commands, but never while a command file is
  waiting. Launched by hand from the Script menu (no fresh ticket), it stays until Pause/Abort or the
  `shutdown` file; since its bridge dir is baked in, run the script from `<state>/watcher/…` of the target
  you work in.
