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
| `run_plate_solve` solves, but its scale ratio is far from 1 (about 0.5, 1.9 or 2) | The master's pixel scale is not the optics' scale: the stacker resampled, binned or drizzled it. The ratio is solved scale ÷ expected scale (the seed, or what the keywords give). When the seeded solve fails, `run_plate_solve` retries with the seed × 0.5, 2, 1/3 and 3, and lists the seeds it tried |
| StarAlignment in a matrix mode still writes registered "_r" files | Seen with PixInsight's StarAlignment run on files. `align_files` with `matrix_only` points StarAlignment at a temporary folder under `<workspace>/agentic/scratch/align_files`, lists whatever was written there and deletes the folder |
| A StarAlignment run over many full-size files crashes PixInsight | Too many targets in one execution. `align_files` runs at most 20 targets per StarAlignment execution (`batch_size`) |
| `catalog_stars` lacks the brightest stars of the field | The installed Gaia files do not hold them. Pass them in `supplement` ({ra, dec, mag, name}); a Gaia star within `merge_px` of one is replaced by it |
| `catalog_stars` or a script hangs or crashes after a Gaia error | Searching one data release after another after a failed search has crashed PixInsight's script engine. `catalog_stars` searches one release per call and reports a failed search instead of trying another |
| `run_wbpp` returns at once; where is the result? | WBPP runs in a separate PixInsight instance for minutes to hours. `wbpp_status` reports it (running, finished with its exit code, masters, per-group counts, log files, the console tail). Records are under `<workspace>/agentic/scratch/wbpp/<run id>` |
| `run_wbpp` refuses to start | The GUI instance was running a command for this workspace (watcher busy), or an earlier `run_wbpp` run is still running. A path with a comma is refused too: WBPP's command line splits its parameters on commas |
