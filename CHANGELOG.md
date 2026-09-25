# Changelog

Each release's full notes are on its [GitHub release](https://github.com/mxcoppell/pixinsight-connector/releases).

## 2.2.0

- New tool `inspect_environment`: reports what the PixInsight installation has by asking PixInsight. Gaia answers
  `get-info` for DR2, EDR3, DR3 and DR3/SP (valid, files, magnitude range, mean spectra), plus a 0.1-degree search.
  Each configured MARS file is tested with one MultiscaleGradientCorrection run on a temporary synthetic
  plate-solved image: readable, missing or corrupt, and how many MARS reference images cover a given position.
  BlurXTerminator, NoiseXTerminator and StarXTerminator run once on a 64x64 image to report their version, ML
  model version and gpu/cpu. Also free memory and free space on the workspace volume. Temporary images are closed.
- `doctor` and `install` name the companion skills repository, `mxcoppell/pixinsight-connector-skills`.
- A Gaia release with no database files prints `No database files have been selected`; `inspect_environment`
  reports that per release instead of failing the call.

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
