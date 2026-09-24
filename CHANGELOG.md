# Changelog

Each release's full notes are on its [GitHub release](https://github.com/mxcoppell/pixinsight-connector/releases).

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
