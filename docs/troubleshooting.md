# Troubleshooting

Run `pixinsight-connector doctor` first: it checks the install, PixInsight, the target folder and any packs.

| Symptom | Cause and fix |
|---|---|
| The harness says the server failed to start or connect | Started with `npx`, which needs GitHub at every start: install it (`npm install -g …`, see the [README](../README.md#install)) and register `pixinsight-connector`. Otherwise run `pixinsight-connector doctor` |
| `Could not find a PixInsight installation`, or `Watcher did not start` | Not at the default path: set `PIXINSIGHT_BIN`, and `PIXINSIGHT_DIR` (the install root) if `doctor`'s `imagesolver` check fails |
| A long call is dropped after about a minute | The harness timed out. The server sends progress keepalives only when the harness requests progress (sends a `progressToken`); if it does not, or ignores them, raise its MCP tool timeout |
| `View not found: …` | A view id was mistyped or the view was closed; the error lists the views that are open |
| `run_plate_solve` fails | It needs an RA/Dec seed near the true center (`ra_deg`, `dec_deg`); a wrong seed fails to solve |
| `PixInsight is running but this target's watcher never started` | PixInsight runs one script at a time: a session in another target folder, or a long script, may hold it, so retry when it is free. Or PixInsight could not open the watcher script: its Process Console says why |
| `STOPPED BY USER` | Pause/Abort was pressed in PixInsight; nothing runs until you say continue and the agent calls `resume_bridge` |
