# Changelog

Each release's full notes are on its [GitHub release](https://github.com/mxcoppell/pixinsight-connector/releases).

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
