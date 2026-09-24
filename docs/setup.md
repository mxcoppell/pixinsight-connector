# Setup reference

The short install is in the [README](../README.md#install). This page has every harness, the target folder,
the environment variables, where PixInsight is looked for, and which models work.

## Registering with a harness

The server command is `pixinsight-connector` (after `npm install -g github:mxcoppell/pixinsight-connector#v2.0.0`).
Register it under the name `pixinsight`. A harness that cannot find the command takes its full path: run
`npm prefix -g` and append `bin/pixinsight-connector`.

| Harness | Config | Where |
|---|---|---|
| Claude Code | `claude mcp add -s user pixinsight -- pixinsight-connector` | `~/.claude.json` |
| Codex CLI | `[mcp_servers.pixinsight]`, `command = "pixinsight-connector"` | `~/.codex/config.toml` |
| Cursor | `mcpServers` | `~/.cursor/mcp.json` or `.cursor/mcp.json` |
| OpenCode | `mcp` → `"type": "local"`, `"command": ["pixinsight-connector"]` | `~/.config/opencode/opencode.json` |
| Windsurf | `mcpServers` | `~/.codeium/windsurf/mcp_config.json` |
| VS Code / Copilot | `servers` | `.vscode/mcp.json` or the user profile `mcp.json` |
| Gemini CLI | `mcpServers` | `~/.gemini/settings.json` |
| Zed | `context_servers` | `~/.config/zed/settings.json` |
| Cline | `mcpServers` | `~/.cline/data/settings/cline_mcp_settings.json` |
| Kiro | `mcpServers` | `~/.kiro/settings/mcp.json` |
| Claude Desktop | `mcpServers`, or double-click the `.mcpb` bundle attached to a GitHub release | `claude_desktop_config.json` |

Every `mcpServers` entry is `{"pixinsight": {"command": "pixinsight-connector"}}`, plus an optional `env`. Three
shapes differ: **Codex** is TOML under `mcp_servers` (underscore), **OpenCode** wants `command` as an array, and
**VS Code** names the top-level key `servers`. With npx instead of an install, the command is `npx` and the args
are `["-y", "github:mxcoppell/pixinsight-connector#v2.0.0"]`; npx asks GitHub at every start, so the server fails
to start while GitHub is unreachable.

## Target folder and files

The tools work in the folder `set_workspace` names, else `PIXINSIGHT_CONNECTOR_WORKSPACE` (`~/` allowed), else
the launch folder. Claude Desktop has no useful launch folder, so set the bundle's *Target folder* option or
call `set_workspace`. PixInsight cannot run a script from a path containing a comma or a double quote, so such a
target is refused: rename the folder or set `PIXINSIGHT_CONNECTOR_STATE` to a folder without one.

The connector writes only `<target>/agentic/` (scratch, the bridge and its watcher script, logs) and
`<target>/output/`, nothing in your home folder. `PIXINSIGHT_CONNECTOR_STATE` replaces `agentic/` (resolved
against the target; an absolute path moves it outside the target, the one explicit exception). PixInsight keeps
its own settings, swap and temp files where it always does (`run_plate_solve` puts ImageSolver's star lists
under `agentic/scratch/`).

Every tool call, with the PJSR it sent and PixInsight's reply, is logged as JSONL in `<target>/agentic/logs/`
(it holds paths and code: check before sharing). The log opens in the workspace of the first call that uses
one. `workspace_info` and `pixinsight-connector doctor` show every folder in use.

## Environment variables

| Variable | Meaning |
|---|---|
| `PIXINSIGHT_BIN` | The PixInsight executable, when it is not at the default path below |
| `PIXINSIGHT_DIR` | The PixInsight install root, from which the executable and its resources are derived |
| `PIXINSIGHT_CONNECTOR_WORKSPACE` | The target folder, when `set_workspace` has not named one |
| `PIXINSIGHT_CONNECTOR_STATE` | Where the session files go instead of `<target>/agentic` |
| `PIXINSIGHT_CONNECTOR_PACKS` | Comma-separated tool packs to load: pack folders and `.mjs` files |
| `PIXINSIGHT_CONNECTOR_LOG` | `0` turns off the call logs |
| `PIXINSIGHT_CONNECTOR_AUTOSTART` | `0` stops the connector from starting PixInsight when it is not running |
| `PIXINSIGHT_CONNECTOR_AUTOLAUNCH` | `0` expects a watcher you started by hand instead of launching one per session |
| `PIXINSIGHT_CONNECTOR_LINGER_MS` | How long an idle watcher waits before it exits (8000 by default) |
| `PIXINSIGHT_CONNECTOR_LAUNCH_PORT` | The local port of the launch mutex, when the default is taken |

## Where PixInsight is looked for

| OS | Default path | Status |
|---|---|---|
| macOS | `/Applications/PixInsight/PixInsight.app/Contents/MacOS/PixInsight` | verified |
| Windows | `C:\Program Files\PixInsight\bin\PixInsight.exe` | unverified: set `PIXINSIGHT_BIN` if it differs |
| Linux | `/opt/PixInsight/bin/PixInsight` | unverified: set `PIXINSIGHT_BIN` if it differs |

## Models

What the work needs, whatever the model:

| Needs | Why |
|---|---|
| **Vision (required)** | `save_preview` returns a JPEG path and the agent has to look at it; without vision it works blind |
| Reliable tool calling | tens to a hundred sequential calls, some taking minutes, all state inside PixInsight |
| Long context | skill text, about 80 tool schemas and a transcript of numeric results |

**Test drive with a small, cheap model first.** A run is many calls, so the price per token matters more than usual.
All of these take image input. Prices are per million tokens, input / output, as of 2026-09-24:

| Model | Access | Price | Notes |
|---|---|---|---|
| GPT-6 Luna | OpenAI API | $0.10 / $0.50 | 1.05M context |
| GLM-5.3-Flash | MIT open weights, Z.ai API | $0.15 / $0.50 | 320B MoE (18B active), 1M context |
| DeepSeek V4.1 Flash | MIT open weights, DeepSeek API (`deepseek-flash`) | $0.15 / $0.60 off-peak, $0.30 / $1.20 at peak | 552B MoE, 1M context; the API downsizes images to about 1300 px (at most 1024 tokens each), so previews lose fine detail |
| MiniMax M3 | open weights, MiniMax API | $0.30 / $1.20 (list $0.60 / $2.40) | 1M context; images bill at a separate rate |
| Gemini 3.5 Flash-Lite | Gemini API | $0.30 / $2.50 | fastest Gemini 3.5-class model |
| Gemini 3.8 Flash | Gemini API | $0.75 / $3.75 (introductory) | Google's strongest current model for agents |
| Claude Haiku 4.5 | Anthropic API | $1 / $5 | |
| Qwen3.8-27B | Apache-2.0 open weights, run locally | free locally | 27B dense, 262K context; a 4-bit build fits a 24 GB GPU. Some serving stacks load it text-only: check that images reach the model |

Frontier models, for the hardest targets:

| Vendor | Models |
|---|---|
| Anthropic | Claude Opus 5.5, Claude Fable 5.1, Claude Sonnet 5 ($2 / $10) |
| OpenAI | GPT-6 Astra, GPT-6 Sol |
| Google | Gemini 3.8 Flash (Gemini 3.5 Pro is not yet released) |
| Moonshot AI | Kimi K3: open weights, 2.8T MoE, 1M context, $3 / $15 |
| DeepSeek | none with image input yet: V4-Pro is text-only, and since 2026-09-14 the API routes it to V4.1 Flash until V4.1-Pro ships |

| Tested with this connector | Status |
|---|---|
| Claude models | run end to end |
| Every other model above | meets the requirements on paper, not yet run; please report a run as an issue |
| Open checkpoints | use the multimodal checkpoint: some coding checkpoints are text-only |
