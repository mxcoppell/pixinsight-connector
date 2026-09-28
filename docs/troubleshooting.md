# Troubleshooting

Run `pixinsight-connector doctor` first: it checks the install, PixInsight, the target folder and any packs.

| Symptom | Cause and fix |
|---|---|
| The harness says the server failed to start or connect | Started with `npx`, which needs the npm registry until the package is cached: install it (`npm install -g …`, see the [README](../README.md#install)) and register `pixinsight-connector`. Otherwise run `pixinsight-connector doctor` |
| `Could not find a PixInsight installation`, or `Watcher did not start` | Not at the default path: set `PIXINSIGHT_BIN`, and `PIXINSIGHT_DIR` (the install root) if `doctor`'s `imagesolver` check fails |
| A long call is dropped after about a minute | The harness timed out. The server sends progress keepalives only when the harness requests progress (sends a `progressToken`); if it does not, or ignores them, raise its MCP tool timeout |
| `View not found: …` | A view id was mistyped or the view was closed; the error lists the views that are open |
| `run_plate_solve` fails | It needs an RA/Dec seed near the true center (`ra_deg`, `dec_deg`); a wrong seed fails to solve |
| `PixInsight is running but this target's watcher never started` | PixInsight runs one script at a time: a session in another target folder, or a long script, may hold it, so retry when it is free. Or PixInsight could not open the watcher script: its Process Console says why |
| The agent sees every tool twice, or calls time out after an upgrade from pixinsight-mcp 1.x | Both servers are registered (under two names) and compete for PixInsight's one script slot. Keep one entry named `pixinsight` with the command `pixinsight-connector`, remove the other, and run `npm uninstall -g pixinsight-mcp` |
| `STOPPED BY USER` | Pause/Abort was pressed in PixInsight; nothing runs until you say continue and the agent calls `resume_bridge` |
| Every call fails with `PixInsight appears to have crashed mid-command … retry`, and PixInsight is not running | A connector before 2.3.0 took the `busy` heartbeat a killed PixInsight left behind for a live watcher. Since 2.3.0 it is cleared on the next call and PixInsight is started again; `doctor` reports such a beat. On an older connector, delete `<workspace>/agentic/bridge/<machine-id>/heartbeat` |
| A call runs far longer than usual, and its result or progress says PixInsight may be showing a dialog | Look at PixInsight: a modal dialog (for example a Crop asking to delete the astrometric solution, or an API error box after a save into a missing folder) waits for a click, and the command resumes after it. A long native process gives the same hint and needs nothing |
| `PixInsight is busy with job …` | A job started with `run_pjsr` `async` is running; calls that use PixInsight are refused until it ends. `job_status` reports on it, `cancel_job` stops it |
| `cancel_job` was called but the job keeps running | A running job stops at its next `processEvents()` call. A native process in progress cannot be interrupted, and a script that never calls `processEvents()` runs to its end; Pause/Abort in PixInsight stops the watcher itself |
