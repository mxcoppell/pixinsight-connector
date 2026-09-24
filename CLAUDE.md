# pixinsight-connector — agent instructions

Claude Code reads this file; Codex and most other harnesses read `AGENTS.md`. Everything below is identical
in both (`test/agent-instructions.test.mjs`).

<!-- agent-instructions:start -->
## What this repository is

A generic MCP connector for PixInsight: `src/cli.mjs` starts a stdio MCP server (`src/server.mjs`) whose
tools operate PixInsight through a file-based bridge (`src/bridge.mjs`, protocol in
`docs/bridge-protocol.md`) and a PJSR watcher (`pjsr/watcher.template.js`) that `src/runtime.mjs`
materializes and launches on the first tool call. Installed with `npm install -g pixinsight-connector` (or run with `npx -y pixinsight-connector`).
It contains no processing workflow; see `README.md`.

## The separation rule

The connector may know how to **operate** PixInsight, never what makes a **good picture**. No pipeline,
no ordering, no recommended values, no target taxonomy, no scoring. A tool description states what the
tool does and what each parameter means, never which value to pick or what to do next
(`test/contract.test.mjs` enforces the wording). Technique belongs in skills and packs, outside this repo.

## The extension seam

- **Add a tool** by adding a module to `src/tools/` that exports a `tools` array. `buildCoreCatalog()`
  (`src/tools/index.mjs`) scans the directory; there is no registry, import list or category map to edit.
- "Run one process on one view" tools use `defineProcessTool` (`src/define.mjs`); anything else is a
  hand-written `{ name, description, inputSchema, handler(api, input) }` descriptor. See `CONTRIBUTING.md`.
- `workspace_info`, `set_workspace`, `resume_bridge` and `list_packs` are defined in `src/server.mjs` because they
  need server-owned state.
- After adding or renaming a tool, run `npm run docs:tools` to regenerate the tool list in `docs/tools.md`.

## Pack contract (Pack API v1)

A pack is an ES module outside the repo, loaded once at startup by `src/packs.mjs`. It exports
`apiVersion` (`1`), `name`, `version` and `tools`. Handlers receive the same frozen object core tools get,
built only by `src/api.mjs`: `pjsr`, `runProcess`, `stats`, `listImages`, `workspace`, `platform`, `log`,
`connectorVersion`. Discovery is `PIXINSIGHT_CONNECTOR_PACKS` only (comma-separated pack directories and `.mjs`
files; an npm package is given by the path to its folder); unset, no pack loads.
A pack tool may shadow a core tool, except the reserved `resume_bridge`, `run_pjsr`, `workspace_info`,
`set_workspace` and `list_packs`. Changing this surface is a Pack API version change.

## Conventions

- Node 22+, ESM only. The one runtime dependency is `@modelcontextprotocol/sdk`.
- Nothing is written to disk and nothing is launched during `initialize` or `tools/list`.
- Every OS-dependent decision is injectable (`platform`, `homeDir`, `env`, `existsSync`, `spawn`) and unit
  tested from any OS; module paths go through `fileURLToPath` / `pathToFileURL`.
- PJSR in `pjsr/` and in generated snippets stays ES5-style; V8 constants are `Process.CONSTANT`.
- No model name in `src/`, `test/` or `doctor` output. Nothing may assume a particular harness.
- Every tool call is logged by the one dispatch in `src/server.mjs` through `src/call-log.mjs`, so a new
  tool needs nothing to be logged. A logging failure never fails or changes a call.
- The connector writes only `<workspace>/agentic/` (scratch, the bridge and its watcher script, logs) and
  `<workspace>/output/` (`src/workspace.mjs`); nothing under the home directory or any per-user folder. A core
  tool writes nowhere else (`test/tools-hygiene.test.mjs`).

## Reading modules during startup is allowed — do not make it lazy

"Nothing written, nothing launched during `initialize` or `tools/list`" forbids writes and launches, not
reads. `buildCoreCatalog()` (`src/tools/index.mjs`) reads every `src/tools/*.mjs` module and `loadPacks()`
(`src/packs.mjs`) reads and imports every pack: there is no tool catalog without those reads, and neither
writes a file, creates a directory or spawns a process. `serve()` (`src/server.mjs`) loads packs once,
before `server.connect()`, so a `tools/list` request itself does no I/O. Making either lazier would only
make `tools/list` depend on timing and repeat a one-time cost. A real disk write or process launch in that
window is the bug to fix; the write/spawn spy tests in `test/server.test.mjs` assert zero writes and
spawns (not zero reads), so extend those.

## Pull requests

- AI-assisted and agent-authored PRs are welcome on the same two conditions as any other: `npm test`
  passes, and the PR description says what was verified and what was not.
- If a change could not be verified against a real PixInsight, say so in the PR: the maintainer has the
  telescope.
- Never edit a generated block by hand (the tool list in `docs/tools.md`: run `npm run docs:tools`).
- Never add a runtime dependency without asking first.

## Tests

```
npm test                        # the full suite; needs no PixInsight
npm run docs:tools              # regenerate docs/tools.md (a test fails if it is stale)
```

CI runs Node 22 and 24 on Linux, macOS and Windows. Before pushing, run `npm test` under Node 22 as well
as your default Node (for example with nvm: `nvm use 22`, then `npm test`). Live tests in `test/live/`
need a running PixInsight and run only with `PIXINSIGHT_CONNECTOR_LIVE=1`.

Repository gates: `test/agent-instructions.test.mjs` (this block is identical in `AGENTS.md` and
`CLAUDE.md`), `test/crossplatform-block.test.mjs` (the block below is identical here and in `README.md`),
`test/docs.test.mjs` (backticked paths, tool names and API names in the docs are real; README stays within
120 lines), `test/no-dead-files.test.mjs` (every `src/` module is reachable from
`src/cli.mjs`), `test/packaging.test.mjs` (the npm package ships only `src/**/*.mjs`,
`pjsr/watcher.template.js`, `README.md`, `LICENSE`, `package.json`) and `test/release-metadata.test.mjs`
(`package.json`, `server.json` and `manifest.json` agree on name and version).

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
<!-- agent-instructions:end -->
