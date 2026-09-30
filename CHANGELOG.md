# Changelog

Each release's full notes are on its [GitHub release](https://github.com/mxcoppell/pixinsight-connector/releases).

## 2.4.0

- New `reproject_to_reference`: resamples a plate-solved image onto the pixel grid of another plate-solved image through the two astrometric solutions (PixInsight's astrometric reprojection, called directly, so no script library is needed). One interpolation, default Lanczos3 with clamp 0.3. The result is a new 32-bit float view with the reference's size and solution; the source is untouched, and an empty result (no overlap) is reported. In one live check with masters from two telescopes on a 9549x6361 grid it took 3 s and left a star-centroid residual of 0.39 px, where StarAlignment had left 0.92 px on the same pair.
- `run_sxt`: the default `overlap` is now 0.5 (it was 0.10). The old default left a faint rectangular tile grid, cells of about 470 px, in linear starless images. Pass `overlap` to override.

## 2.3.0

**No more hidden dialogs or silent damage.**
- `crop_image` with all margins 0 runs nothing. Crop, and every process run through `run_process` or a declared process tool, runs with `noGUIMessages`, so PixInsight writes confirmations to the Process Console instead of opening a dialog that stalls the bridge. `crop_image` says when the crop removed the astrometric solution.
- New `ensure_dir` creates a folder inside `output/` or the state folder. `export_image`, `save_preview` and `align_to_reference` fail, naming the path, when `saveAs` returns false.
- `run_pixelmath` and `pixelmath_new_image` report, per channel, the fraction of samples truncated to [0,1]. `pixelmath_new_image` copies `size_from`'s astrometric solution.
- `run_mgc` refuses a mono image without `filter`.
- `get_image_stats` reports the fractions of samples at exactly 0 and exactly 1.

**Bridge and jobs.**
- A "busy" heartbeat left by a PixInsight that was killed, restarted, or whose command finished is cleared on the next call, and PixInsight and the watcher start again. It used to block every call until the file was removed by hand. `doctor` reports the heartbeat.
- A watcher launch into a PixInsight the connector just started is sent again if it does not come up within 10 s.
- `run_pjsr` and `run_pjsr_file` take `async`: the code runs as a job, `job_status` reports its state (queued, running, ending, done, failed, cancelled, stopped), progress and result, and `cancel_job` stops it at its next `processEvents()`. Scripts can call `mcpProgress(text)` and `mcpCancelRequested()`.
- Calls that use PixInsight are refused while a job runs, or while a `run_wbpp` run is alive in the workspace.
- A call that shows no progress for 90 s (`PIXINSIGHT_CONNECTOR_DIALOG_HINT_MS`) says PixInsight may be showing a dialog.

**New tools.**
- `set_stf`: sets PixInsight's auto-stretch as a view's STF, or copies another view's.
- `save_preview` takes an optional STF (`stf_from`, or `stf_m` with `stf_c0`), a `crop` rectangle and a `downsample` factor.
- `catalog_stars`: local Gaia stars over a solved view, one search per call, with a supplement list for the brightest stars.
- `compare_images`: per-channel max, mean and p99 absolute difference, and the out-of-range fractions.
- `resample_image`: IntegerResample, or Resample by a factor or to a reference size, with no confirmation dialog; it reports plate-solution loss.
- `align_files`: StarAlignment file to file, in batches of at most 20, with a matrix-only mode that keeps no image files.
- `run_wbpp` / `wbpp_status`: headless WBPP in a separate PixInsight instance, passing only the given parameters. Dark optimization and drizzle go through a pipeline-builder script.

**Other changes.**
- `run_plate_solve` retries with wider scale seeds and reports solved scale ÷ expected scale (the failed seeds' console errors do not flag a solve that succeeded). An image that already has a solution is now really re-solved.
- `docs/troubleshooting.md` covers stale heartbeats, jobs and cancel limits, hidden dialogs, plate-solution loss, `saveAs` error boxes, StarAlignment batching and matrix mode, Gaia, WBPP, and PJSR pitfalls.

## 2.2.3

- `QUICKSTART.md`: from a new computer to a processed LRGB image. What to install, copyable prompts to install
  the connector and skills and to start processing, the target folder before and after, what a run costs, how to
  build your own skill repository and how to report issues. The README links to it. No code change.

## 2.2.2

- `clone_image` keeps the source's FITS keywords, astrometric solution and view properties in the clone, as
  `export_image` does since 2.2.1. A clone used to hold only the pixels, so it could not stand in for a
  plate-solved or flux-calibrated image.

## 2.2.1

- `describe_process` and `run_process` check that the name is a PixInsight process before instantiating it.
  An abbreviation or any other name that is not a process constructor (`SPCC`, `CheckBox`) now fails with
  `No PixInsight process named SPCC. The name is a PJSR process constructor name; list_processes lists the ones
  installed.` instead of PixInsight's bare `SPCC is not defined`. Real process names run exactly as before.
- `export_image` keeps the image's FITS keywords, astrometric solution and view properties (for example SPFC's flux
  calibration) in the file. It used to save a bare pixel copy, so an exported stage file could not be plate-solved
  again from its own metadata or feed `copy_astrometric_solution`.

## 2.2.0

- New tool `inspect_environment`: reports what the PixInsight installation has by asking PixInsight. Gaia answers
  `get-info` for DR2, EDR3, DR3 and DR3/SP (valid, files, magnitude range, mean spectra), plus a 0.1-degree search.
  Each configured MARS file is tested with one MultiscaleGradientCorrection run on a temporary synthetic
  plate-solved image: readable, missing or corrupt, and how many MARS reference images cover a given position.
  BlurXTerminator, NoiseXTerminator and StarXTerminator run once on a 64x64 image to report their version, ML
  model version and gpu/cpu. Also free memory and free space on the workspace volume. Temporary images are closed.
- `doctor` and `install` name the companion skills repository, `mxcoppell/pixinsight-connector-skills`.
- A Gaia release with no database files reports `valid: false`; a console error PixInsight prints during the
  query (`No database files have been selected`, seen on the first query of a session) is reported in that
  release's `error` instead of failing the call.

## 2.1.3

- `run_pjsr` and every other tool report what a failing script actually threw. PixInsight's own methods and process
  setters throw a plain string, not an Error, which was reported as `Script error: undefined`; an invalid process
  parameter now reads, for example, `Script error: IntegerResample.downsamplingMode(): Invalid argument type: signed
  integer value expected.`
- A script that throws a falsy value (`undefined`, `0`, `""`, `false`, `null`) fails instead of being reported as a
  success.

## 2.1.2

- `doctor` has a `pixinsight-mcp` check: it fails when the 1.x command (this connector's old name) is still on
  PATH, and says to uninstall it and register one server, `pixinsight`, with the command `pixinsight-connector`.
  Two servers driving one PixInsight compete for its single script slot.
- The README says how to move from pixinsight-mcp 1.x without registering a second server.

## 2.1.1

- Published on npm as `pixinsight-connector` and listed in the MCP registry as
  `io.github.mxcoppell/pixinsight-connector`. Install with `npm install -g pixinsight-connector`, or register
  `npx -y pixinsight-connector`; `git` is no longer needed. The `install` command and the doctor hints print the
  npm form.
- Releases are published from the `v*` tag by CI, to npm with provenance and then to the MCP registry.

## 2.1.0

- `measure_stars` locates each star's half-maximum crossing to a fraction of a pixel, interpolating linearly between
  the samples either side, instead of reporting the first whole pixel below it. `median_fwhm_px` is no longer
  quantized to 0.5 px, so small changes such as a sharpening pass show up. Values are up to 1 px lower than 2.0.0
  reported for the same stars; the half-of-peak definition is unchanged. Checked against real PixInsight: Gaussian
  stars of FWHM 3.53, 3.77 and 5.89 px measure 3.55, 3.77 and 5.90 px (2.0.0 reported 4.0, 4.0 and 6.0).

## 2.0.0

The connector continues as **pixinsight-connector**, a new repository with the same tools and behaviour as
pixinsight-mcp 1.2.2. The history of 1.x is in the archived
[mxcoppell/pixinsight-mcp](https://github.com/mxcoppell/pixinsight-mcp) repository.

Breaking changes, all renames:

- Package and command: `pixinsight-mcp` → `pixinsight-connector`. Install with
  `npm install -g github:mxcoppell/pixinsight-connector#v2.0.0` and register the command `pixinsight-connector`.
  The MCP server name stays `pixinsight`, so tool names seen by agents do not change.
- Environment variables: `PIXINSIGHT_MCP_*` → `PIXINSIGHT_CONNECTOR_*` (`WORKSPACE`, `STATE`, `PACKS`, `LOG`,
  `AUTOSTART`, `AUTOLAUNCH`, `LINGER_MS`, `LAUNCH_PORT`). The old names are no longer read.
  `PIXINSIGHT_BIN` and `PIXINSIGHT_DIR` are unchanged.
- MCP registry name: `io.github.mxcoppell/pixinsight-connector`.

Also: a shorter README built around the toolbox/knowledge split; the tool list, setup reference and
troubleshooting moved to `docs/`.
