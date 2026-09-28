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
| A call hangs for a minute or more with nothing in the Process Console | PixInsight is probably showing a modal dialog nobody can see, and the watcher waits for it. Look at PixInsight and answer the dialog. Two sources are known: a geometric process on a plate-solved image asks before deleting the astrometric solution, and a save into a folder that does not exist raises an API error box |
| `crop_image` or a `run_process` Crop/Resample says the astrometric solution was removed | Geometric processes (Crop, DynamicCrop, Resample, IntegerResample, Rotation, FastRotation, ChannelMatch) delete the solution; PixInsight has no option to keep it. The connector sets `noGUIMessages`, so the question goes to the Process Console instead of a dialog. `run_plate_solve` solves the image again |
| A PJSR `saveAs` returns `false`, or opens "PixInsight API Error: … Invalid or nonexistent directory" | The target folder does not exist. The error box appears even when saveAs is told not to allow messages and cannot be caught with try/catch. `ensure_dir` creates the folder first; `export_image` and `save_preview` create theirs |
| `run_pixelmath` reports samples truncated to [0,1] | PixInsight images hold [0,1]; values outside are clipped. A flux or gain above 1 is kept in a PixelMath expression or in JSON, never stored in an image |

## PJSR pitfalls

- Process enumerations live on the constructor: `SCNR.AverageNeutral`, `Crop.AbsolutePixels`. `SCNR.prototype.AverageNeutral` is undefined, and assigning it (for example `PixelMath.newImageColorSpace = PixelMath.prototype.RGB`) throws. `describe_process` lists a process's constants.
- `UndoFlag_NoSwapFile` is not defined in PixInsight's V8 PJSR; call `beginProcess()` without flags.
- `ImageWindow.saveAs(path, …)` with its allow-messages argument false silences format warnings only. A file-format error still opens a modal box, so create the folder before saving and check the boolean result.
- A new image made by PixelMath (`createNewImage`) or `new ImageWindow` has no astrometric solution. `copyAstrometricSolution(sourceWindow)` copies one from a solved image of the same geometry; `pixelmath_new_image` does it for `size_from`.

