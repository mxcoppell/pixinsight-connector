# PixInsight Connector

An MCP connector that lets any AI agent operate [PixInsight](https://pixinsight.com): about 80 PixInsight
operations as tools, for chat sessions and the skills that guide them.

> Community project, not affiliated with or endorsed by Pleiades Astrophoto. PixInsight® is a registered
> trademark of Pleiades Astrophoto S.L.

## The principle: a toolbox, not a pipeline

The connector knows how to **operate** PixInsight, never what makes a **good picture**. No pipeline, no
ordering, no recommended values, no verdicts: every tool takes the values that shape the image as inputs,
and every measurement returns numbers. The knowledge (which tools, in what order, with which values, what
counts as good enough) lives in **skills**: markdown in your own repositories, public or private.

```mermaid
%%{init: {'theme': 'base', 'flowchart': {'wrappingWidth': 320}, 'themeVariables': {'fontFamily': 'ui-sans-serif, system-ui, sans-serif', 'lineColor': '#a8a29e', 'textColor': '#78716c', 'edgeLabelBackground': '#fef3c7'}}}%%
flowchart TB
    classDef know fill:#c2410c,stroke:#9a3412,stroke-width:1px,color:#fff7ed,rx:14,ry:14
    classDef harness fill:#a16207,stroke:#854d0e,stroke-width:1px,color:#fefce8,rx:14,ry:14
    classDef tool fill:#b45309,stroke:#92400e,stroke-width:1px,color:#fffbeb,rx:14,ry:14
    classDef app fill:#78716c,stroke:#57534e,stroke-width:1px,color:#fafaf9
    You(["You, in a chat session"]):::know
    Skills("<b>THE KNOWLEDGE · yours</b><br/>your skills: order, values, quality gates<br/>kept in your own repositories"):::know
    Harness("<b>Any MCP agent harness</b><br/>Claude Code · Codex · Cursor · Gemini CLI · …"):::harness
    Tools("<b>THE TOOLBOX · this connector</b><br/>~80 PixInsight operations as MCP tools<br/>measurements return numbers, never verdicts"):::tool
    Bridge("<b>File bridge + watcher script</b><br/>starts PixInsight on the first call"):::tool
    PI(["PixInsight 1.9.5+"]):::app
    You --> Harness
    Skills -. guides .-> Harness
    Harness -- MCP tool calls --> Tools
    Tools --> Bridge
    Bridge <--> PI
```

## Install

Needs Node 22+, `git` and PixInsight 1.9.5+. The same three steps work whether you or your agent runs them.

**1. Install the connector**, pinned to a release:

```sh
npm install -g github:mxcoppell/pixinsight-connector#v2.0.0
```

**2. Register it** with your agent harness as the MCP server `pixinsight`. Claude Code:

```sh
claude mcp add -s user pixinsight -- pixinsight-connector
```

Any harness configured with an `mcpServers` JSON file (Cursor, Windsurf, Gemini CLI, Claude Desktop, Cline, Kiro):

```json
{ "mcpServers": { "pixinsight": { "command": "pixinsight-connector" } } }
```

Codex, OpenCode, VS Code and Zed use other shapes; each one, and where its file lives: [docs/setup.md](docs/setup.md).

**3. Check the machine:**

```sh
pixinsight-connector doctor
```

PixInsight and its watcher script start on the first tool call; there is nothing else to launch. Upgrade by
re-running step 1 with the new tag. Without installing, register `npx -y github:mxcoppell/pixinsight-connector#v2.0.0`
as the command instead (it needs GitHub at every start).

## Where files go

The tools work in a target folder: the one `set_workspace` names, else `PIXINSIGHT_CONNECTOR_WORKSPACE`, else the
folder the harness started in. The connector writes only `<target>/agentic/` (scratch, the bridge, call logs) and
`<target>/output/`, never your home folder. Details and every environment variable: [docs/setup.md](docs/setup.md).

## Tools, packs and skills

- **Tools:** 78, grouped as images, processes, channels, tone, detail, masks, stars, narrowband, astrometry,
  measurement, preview, PJSR execution, introspection and session. Full list: [docs/tools.md](docs/tools.md).
- **Skills** hold the technique. Have one that works? Add it to [COMMUNITY.md](COMMUNITY.md) in a one-line PR.
- **Packs** are ES modules that add or replace tools at startup, listed in `PIXINSIGHT_CONNECTOR_PACKS`. A pack is
  arbitrary code running with your privileges; only packs you configure load. See
  [CONTRIBUTING.md](CONTRIBUTING.md#developing-a-pack).
- **Models:** use one with vision (the agent must look at previews) and reliable long tool use: [docs/setup.md](docs/setup.md#models).

## Contributing

A PixInsight capability with no tool yet is one module in `src/tools/`, no registry: [CONTRIBUTING.md](CONTRIBUTING.md).
Humans and agents are both welcome; `npm test` needs no PixInsight.

<!-- crossplatform:start -->
## Cross-platform

macOS, Windows and Linux are all first-class, for running this connector and for developing it.
A change that works on one OS and breaks another is a bug, not a limitation.

- **No shell pipelines.** No `ps`, `grep`, `awk`, `wc`, `df` or `&&` in `src/` or in npm scripts.
  OS-specific behaviour goes behind `src/platform.mjs` (paths) or `src/process-probe.mjs` (process
  inspection), one implementation per OS.
- **No POSIX path literals.** Use `path.join`. Use forward slashes only when handing a path to
  PixInsight, which accepts them everywhere.
- **CI runs the full suite on Linux, macOS and Windows.** Green on one is not green.
- **Degrade, never fail.** If an OS cannot supply something optional — a memory reading, a process
  start time — carry on without it. Never report it as a crash.
- **Overrides always win:** `PIXINSIGHT_BIN` for the executable, `PIXINSIGHT_DIR` for the install root.

Tests need no PixInsight and no astronomy software, so you can develop on any of the three.
<!-- crossplatform:end -->

## Troubleshooting

Run `pixinsight-connector doctor` first. Common symptoms and fixes: [docs/troubleshooting.md](docs/troubleshooting.md).

## Credit and license

This project began as [aescaffre/pixinsight-mcp](https://github.com/aescaffre/pixinsight-mcp) by Alain Escaffre;
parts of the original file bridge and watcher script remain. MIT licensed: see [LICENSE](LICENSE).
