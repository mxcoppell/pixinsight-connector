# Contributing

Three kinds of contribution, three places:

- **A PixInsight capability the connector has no tool for** — this file.
- **A skill or a pack** (technique) — publish it in your own repository and add a row to
  [COMMUNITY.md](COMMUNITY.md). No connector change is needed.
- **A bug or a portability fix** — this file's development setup, then a PR. CI must be green on Linux,
  macOS and Windows.

Tool descriptions and docs carry no processing opinion: what a tool does and what its parameters mean,
never which value to pick. See the separation rule in [AGENTS.md](AGENTS.md).

**Humans and agents alike.** AI-assisted and agent-authored PRs are welcome on the same two conditions as
any other: the gates pass (`npm test`), and the PR description says what was verified and what was not.
If a change could not be verified against a real PixInsight, say so in the PR: the maintainer has the
telescope. The test suite needs no PixInsight, so every gate can be run anywhere.

**No CLA. MIT in, MIT out.**

## Development setup

You need Node 22 or newer and `git`. PixInsight is **not** needed: the suite fakes the bridge.

```
git clone https://github.com/mxcoppell/pixinsight-connector.git
cd pixinsight-connector
npm ci
npm test
```

CI runs Node 22 and 24 on Linux, macOS and Windows. Run `npm test` under Node 22 as well as your default
Node before pushing; a newer local Node can hide an API that 22 lacks.

- **Live tests** in `test/live/` drive a real PixInsight. They are skipped unless `PIXINSIGHT_CONNECTOR_LIVE=1`
  is set, with PixInsight installed.
- **The tool list in `docs/tools.md`** is generated. After adding, renaming or re-describing a tool, run
  `npm run docs:tools` and commit the result; `test/docs-tools.test.mjs` fails while it is stale.
- **Repository gates** that fail the build: `test/docs.test.mjs` (every backticked path, tool name and
  API name in `README.md`, `CONTRIBUTING.md`, `AGENTS.md`, `CLAUDE.md`, `COMMUNITY.md` and
  `docs/bridge-protocol.md`, `docs/tools.md` and `docs/troubleshooting.md` is real, and the README stays
  within 120 lines),
  `test/no-dead-files.test.mjs` (every module under `src/` is reachable from `src/cli.mjs`),
  `test/packaging.test.mjs` (the npm package holds only `src/**/*.mjs`, `pjsr/watcher.template.js`,
  `README.md`, `LICENSE` and `package.json`), `test/release-metadata.test.mjs` (`package.json`,
  `server.json` and `manifest.json` agree on name and version), `test/crossplatform-block.test.mjs` and
  `test/agent-instructions.test.mjs`.

### Running your checkout against PixInsight

Point your harness at the checkout instead of the published package, with an absolute path, e.g.
`claude mcp add -s user pixinsight-dev -- node /absolute/path/to/pixinsight-connector/src/cli.mjs`.
The workspace is the session's working directory unless `PIXINSIGHT_CONNECTOR_WORKSPACE` or the `set_workspace` tool
names another folder; generated files go to `<workspace>/agentic/scratch/`, the bridge's files (commands,
results, the watcher's heartbeat and launch tickets) to `<workspace>/agentic/bridge/<machine-id>/`, the
watcher script to `<workspace>/agentic/watcher/`, and `export_image` writes under `<workspace>/output/`.
Nothing is written outside the workspace (`docs/bridge-protocol.md`).
A workspace that is missing or read-only fails every call that needs it with the fix. On Windows the
up-front check cannot see a folder that only its permissions (ACLs) make read-only; the first write into it
then fails the call with the same fix.
Each session logs every tool call to `<workspace>/agentic/logs/<YYYYMMDD-HHMMSS>-<pid>.jsonl` (UTC): the
input, each bridge command's exact PJSR as it is sent and the watcher's raw result when it settles, the result returned, and
events such as a launch or a `watcher start` with the PixInsight version (`src/call-log.mjs`). Start there
when a call misbehaves. The file opens when a call first uses the workspace (reads `api.workspace` or reaches
the bridge; `buildRuntimeApi` reports it through `callLog.touch()`), not for a list of tool names: a call that
never does (`workspace_info`, `find_filters`, a new tool of that kind) waits and is written, `deferred`, with
any event it raised, into the file that opens next; if none ever opens, it is not written. `set_workspace` is
logged in the new workspace's file, so a launch folder left before any call used it gets nothing.
PixInsight and the watcher are started on the first tool call. `node src/cli.mjs doctor` checks the
machine, and `docs/bridge-protocol.md` documents what travels over the bridge.

| Variable | Effect |
|---|---|
| `PIXINSIGHT_BIN` | PixInsight executable, overriding the per-OS default; the install root is derived from it when it follows the OS layout and ImageSolver is under that root |
| `PIXINSIGHT_DIR` | PixInsight install root (ImageSolver, filter database, white references); wins over a root derived from `PIXINSIGHT_BIN` |
| `PIXINSIGHT_CONNECTOR_AUTOSTART` | `0` stops the connector from starting PixInsight itself |
| `PIXINSIGHT_CONNECTOR_AUTOLAUNCH` | `0` stops the connector from launching the watcher script; start it yourself |
| `PIXINSIGHT_CONNECTOR_LINGER_MS` | how long the watcher stays up with no commands (default 8000) |
| `PIXINSIGHT_CONNECTOR_WORKSPACE` | the workspace folder, instead of the working directory (`~/` allowed; `set_workspace` overrides it) |
| `PIXINSIGHT_CONNECTOR_STATE` | where generated files go, instead of `<workspace>/agentic` |
| `PIXINSIGHT_CONNECTOR_LOG` | `0` turns the call logs off |
| `PIXINSIGHT_CONNECTOR_PACKS` | packs to load; see [Developing a pack](#developing-a-pack) |

When something fails inside PixInsight, its Process Console has the detail; tool results carry its
`*** Error` lines.

## Contributing a tool

The connector's tool catalog is built by scanning `src/tools/` for modules that
export a `tools` array. There is no central registry file to edit: adding a tool
means adding a module to that directory, and `buildCoreCatalog()` (in
`src/tools/index.mjs`) picks it up automatically the next time the catalog is
built.

Every tool is a **descriptor**:

```js
{ name, description, inputSchema, handler(api, input) }
```

`name` is the MCP tool name (snake_case). `description` and `inputSchema` are
what the client sees. `handler` does the work: it receives the bridge API and
the call's input, and returns the tool's result (see "What a handler returns"
below). Every argument the `inputSchema` lists under `required` is checked
before the handler runs: a call that leaves one out, or passes `null` or `""`,
gets an error naming it and never reaches PixInsight. A schema that sets
`additionalProperties: false` also refuses any argument it does not list under
`properties`, the same way (for `defineProcessTool`, pass
`additionalProperties: false` in the spec).

## Adding a process tool, in three steps

Most PixInsight tools are "run one process on one view with some parameters" —
SCNR, HDRMultiscaleTransform, StarAlignment, and so on. For these,
`defineProcessTool` builds the descriptor for you: the JSON Schema, the
generated PJSR (`new <Process>` + parameter assignment + `executeOn`), and the
error handling.

**1. Describe the process.**

```js
// src/tools/example.mjs (ExampleProcess is made up; substitute a real PixInsight process)
import { defineProcessTool } from '../define.mjs';

export const runExampleProcess = defineProcessTool({
  name: 'run_example_process',
  process: 'ExampleProcess',
  description: 'Run ExampleProcess on a view.',
  target: 'view',
  params: {
    amount: {
      type: 'number', pjsr: 'amount', default: 0.8,
      description: 'Effect strength, 0 to 1.',
    },
    mode: {
      type: 'string', pjsr: 'operatingMode', constantsFrom: 'ExampleProcess',
      enum: ['ModeA', 'ModeB'], default: 'ModeA',
      description: 'Operating mode.',
    },
  },
});
```

- `process` is the PJSR class name (`new ExampleProcess` gets emitted). It's validated as
  a bare identifier the moment `defineProcessTool` runs — a typo or an
  injection attempt fails at import time, not on the first real tool call.
- `target: 'view'` is the only target this helper supports: the tool takes a
  required `view_id` input, and the process runs via `P.executeOn(view)`.
  Anything else (no view, multiple views, a non-PJSR handler) needs the escape
  hatch below.
- Each entry in `params` maps one input field to one property on the process
  instance (`pjsr`). `type` drives both the JSON Schema and how the value is
  emitted into PJSR (`number` and `boolean` as bare literals, `string` as a
  quoted literal).
- `constantsFrom` + `enum` together mean "this value is a bare name on that V8
  global" — e.g. `mode: 'ModeB'` emits `ExampleProcess.ModeB`, never
  `ExampleProcess.prototype.ModeB`, and never a quoted string. The `constantsFrom`
  name is validated as a bare identifier at the same time as `process`.
- `default` is documentation only. It surfaces in the JSON Schema so a caller
  knows what PixInsight itself defaults to, but omitting a param from a call
  emits nothing for it — PixInsight's own default stands. `defineProcessTool`
  never invents a value you didn't send.
- `required: true` puts a param in the schema's `required` list after
  `view_id`; a call that leaves it out is refused before any PJSR is sent.
- The generated handler returns `{ text }` naming the process, the view and
  each parameter it set, e.g. `ExampleProcess ran on view "RGB" with amount=0.6.`, or
  saying PixInsight's defaults were used.

**2. Export it from a `tools` array.**

```js
export const tools = [runExampleProcess];
```

**3. That's it.** `buildCoreCatalog()` scans every `.mjs` file in `src/tools/`
(other than `index.mjs` itself) and concatenates each module's `tools` export.
There's no import list and no catalog object to update — a module that exports
no `tools` array (a helper file, say) is simply skipped. Run `npm run docs:tools`
so the README lists the new tool.

### Descriptions carry no processing opinion

`test/contract.test.mjs` enforces this across the whole catalog: a
`description` states what a tool does and what a parameter *is*, never what
value to pick or what to do next. No tuning ranges like `0.5 to 1.0`, none of
`recommended`, `should use`, `ALWAYS`, `never use`, and no ordering such as
"use this after …" or "run … first". That guidance belongs in a skill or in the calling
agent's own judgment, not baked into the connector.

## The escape hatch: hand-written handlers

`defineProcessTool` only covers "one process, one view." When a tool needs
something else — multiple processes, no view at all, custom PJSR, or logic
that isn't PJSR at all — write the descriptor directly instead:

```js
// src/tools/export.mjs
export const tools = [{
  name: 'export_view',
  description: 'Export a view to a file in the given format.',
  inputSchema: {
    type: 'object',
    properties: {
      view_id: { type: 'string', description: 'PixInsight view identifier.' },
      path: { type: 'string', description: 'Destination file path.' },
    },
    required: ['view_id', 'path'],
  },
  async handler(api, input) {
    // ... whatever the tool needs, including api.pjsr(), api.runProcess(), etc.
    return { text: `exported to ${input.path}` };
  },
}];
```

The contract doesn't care how a descriptor was produced — `defineProcessTool`
output and a hand-written object are the same shape, and `catalogFrom` (and
therefore `buildCoreCatalog`) treats them identically. Mix both in the same
`tools` array as needed.

### A hand-written handler that still instantiates a stock process

`src/tools/processes.mjs` holds 15 tools that each wrap one PixInsight
process. Six are plain `defineProcessTool` declarations. The other nine
(`run_bxt`, `run_sxt`, `run_abe`, `run_hdrmt`, `run_curves`, `find_filters`,
`run_spfc`, `run_spcc`, `run_mgc`) need real logic `defineProcessTool` can't
express — a forced parameter that was never part of the tool's input schema
(e.g. `run_bxt`'s `AI = true`), dynamic PJSR property selection (`run_curves`'
channel → property map), or a filesystem database lookup (`find_filters`'
filter curves) — so they're hand-written per the escape hatch above.

A test in `test/tools-hygiene.test.mjs` (`'every tool that wraps a stock
process is declared, not hand-written'`) greps `processes.mjs`'s own source
for a literal `new ClassName;` next to the `new` keyword, to catch PJSR that
was copy-pasted instead of going through `defineProcessTool`. Since these
nine legitimately need to write `new <Process>;` themselves, they route the
class name through a local variable instead of a literal:

```js
async handler(api, input) {
  const PROC = 'BlurXTerminator';
  await api.pjsr(`
    var P = new ${PROC};   // not `new BlurXTerminator;` — see below
    ...
  `);
}
```

This isn't working around the test — it's the same technique
`defineProcessTool` itself uses in `src/define.mjs` (`` `var P = new
${process};` ``). The invariant the test protects is "no PixInsight process
class name is hand-copied as a bare literal next to `new`," and a
`${PROC}` interpolation satisfies that exactly as well as going through
`defineProcessTool` does. If you add a tenth hand-written process tool,
follow the same pattern.

## Compound tools

Some tools run several steps in one call: `multi_scale_enhance` builds a mask
and runs LocalHistogramEqualization at three scales, `lrgb_combine` can run a
LinearFit before LRGBCombination, and the `measure_*` tools run one measurement
snippet and return its numbers. These are hand-written descriptors, and they
follow the same separation rule as every other tool, made concrete:

- **A value that shapes the result has no default.** It goes in
  `inputSchema.required`, so the server refuses a call that leaves it out.
  A default is allowed only for a value PixInsight (or the named algorithm)
  itself defines, or for geometry derived from the image.
- **A step that is technique is opt-in.** Omitted, the step does not run.
  The params that turn it on are checked together in the handler, before any
  PJSR is sent: given one without the others, the tool throws.
- **Results are numbers, never verdicts or advice.** A `measure_*` tool
  returns exactly one JSON text. A threshold that defines what is counted is
  a required input.
- **Views come in through checked names** (below), so the handler does not
  re-check them.
- **The schema is closed** (`additionalProperties: false`), so a removed or
  misspelt input is refused rather than ignored.

Three helper modules in `src/tools/` export no `tools` array, so the catalog
scan skips them:

- `src/tools/pjsr-args.mjs`: `q` (a PJSR string literal), `vid` (refuses
  anything but a PixInsight identifier; use it for every id spliced into
  PixelMath), `num`/`int`/`bool`/`oneOf` (pass `undefined` as the fallback
  for a required value and they throw with the param name), `lit` (a
  PixelMath number at full precision, never in exponent form), `pjsrJson`,
  `newImages`, `closeViews`, `fixed`.
- `src/tools/zones.mjs`: `createZoneMasks` and `createAdaptiveZoneMasks`.
- `src/tools/image-metrics.mjs`: one function per `measure_*` measurement.

A new compound tool is added to the tables in
`test/tools-capability.test.mjs`: `REQUIRED` (every required look-shaping
param, `[]` if none), `REQUIRED_TOGETHER` (each opt-in group) and `CALLS` (one
representative call whose result must carry no verdict or advice). Its tests
use the compiling API from `test/helpers.mjs`, which compiles every emitted
PJSR snippet before replying. If the generic input that
`test/tools-failure-contract.test.mjs` builds from the schema is invalid for
your tool (ordered thresholds, say), add a line to its `overrides`.

## Developing a pack

A pack is a standalone ES module, living outside this repository, that adds
tools to (or replaces core tools in) every session. `src/packs.mjs` loads packs
once at server startup. A pack module must export all four of:

- `apiVersion = 1`: the Pack API version it was written against. Any other
  value, or none, and the pack is skipped.
- `name` and `version`: shown by `list_packs` and `doctor`. A pack missing
  either still loads, with a warning, and is shown by its path.
- `tools`: an array of tool descriptors, the same shape as
  `src/tools/*.mjs`: a snake_case `name`, a `description` longer than 20
  characters, an `inputSchema` whose `type` is `"object"`, and a
  `handler(api, input)` function. A malformed tool is dropped on its own; a
  pack with no `tools` array, or no valid tools, is skipped.

This is the smallest complete pack. It is `test/fixtures/pack-ok/index.mjs`
verbatim, which the loader tests really load both ways shown below
(`test/packs.test.mjs` fails if this block and that file ever differ):

<!-- pack-example: test/fixtures/pack-ok/index.mjs -->
```js
export const apiVersion = 1;
export const name = 'ok';
export const version = '1.0.0';
export const tools = [{
  name: 'fixture_stretch',
  description: 'A fixture tool that exists only to exercise the pack loader in tests.',
  inputSchema: { type: 'object', properties: { view_id: { type: 'string' } }, required: ['view_id'] },
  handler: async (api, input) => ({ text: `stretched ${input.view_id}` }),
}];
```

`handler` receives the same Pack API v1 object core tools get (`pjsr`,
`runProcess`, `stats`, `listImages`, `workspace`, `platform`, `log`,
`connectorVersion`; see `src/api.mjs`). It is frozen: packs share it.
When no PixInsight install resolves, `platform` is `{ error }` with no paths, and `pjsr` and
`listImages` reject with that message; a handler that reads a `platform` path checks `platform.error` first.
`workspace.dir`, `workspace.scratchDir` and `workspace.outputDir` read the current workspace on every access
(`set_workspace` can change it); while there is no usable workspace, reading any of them throws an error naming
the fix, and the server returns that as the tool's result.
Write only under `workspace.scratchDir` (working files) or `workspace.outputDir` (results): those are the
two folders a session's output goes to, and core tools keep to them too.
A pack tool is logged like a core tool: its input, every `pjsr` call's code and result, and what it returns.

### What a handler returns

The same for core and pack tools:

- `{ text }` or a bare string: a successful result.
- `{ text, isError: true }`: the tool did not do its job, but nothing threw — a
  refusal, an unmet precondition, an operation that did not apply. The client
  receives an MCP error result (`isError`) with that text, so an agent cannot
  mistake it for success.
- An array of either: one content item each. The result is an error if any
  item carries `isError: true`.

Throwing is still fine for unexpected failures; the server turns the exception
into an error result. `isError` is part of Pack API v1 (added without a version
bump because a handler that never sets it behaves exactly as before).

### Arguments the server checks

Before any handler runs, core or pack, the server refuses a call whose string
argument named `view_id`, `target_id`, `source_id`, `reference_id`,
`r_view_id`, `g_view_id`, `b_view_id`, `size_from`, `old_id`, `rgb_id`,
`l_id`, `ha_id`, `oiii_id`, `stars_id` or `pre_star_id` (and `mask_id` for
`apply_mask` and `shell_detail_enhance`) does not name an open view: the result is an error,
`View not found: …`, listing the open views. So use these names only for a
view that must already exist; name a view your tool creates something else
(`output_id`, for example). Required arguments (`inputSchema.required`) that
are missing, `null` or `""` are refused the same way, and so is any argument a
schema with `additionalProperties: false` does not list.

### Loading it

List it in `PIXINSIGHT_CONNECTOR_PACKS`, then restart the MCP server (packs load
once, at startup). It is a comma-separated list; unset, no pack loads. Each
entry is a path: a pack directory (its `index.mjs` is loaded) or a
`.mjs`/`.js` file. Absolute paths, `./` or `../` paths and `~/` paths count
(plus `C:\...` and `\\server\...` on Windows), e.g.
`PIXINSIGHT_CONNECTOR_PACKS=~/dev/my-pack`. A pack published to npm is installed
anywhere you like (`npm install --prefix ~/packs @me/my-pack`) and listed by
the path to its folder (`~/packs/node_modules/@me/my-pack`); a bare package
name is refused with that fix, since the connector keeps no folder of its own
to resolve one from.

A relative entry resolves against the MCP server's working directory, which a
harness sets to whatever folder the session starts in, so in a harness config
prefer an absolute or `~/` path.

For a pack split across its own modules, see `test/fixtures/pack-multi/`. A
full one (32 tools, shared helpers, per-group tests) is
`mxcoppell/pixinsight-pack-astro`, listed in [COMMUNITY.md](COMMUNITY.md).

Check the result with `pixinsight-connector doctor` (its `packs` line fails, with
the reason, for any pack that did not load) or the `list_packs` tool, which
also lists the core tools packs replaced.

### Replacing a core tool

A pack tool with the same name as a core tool replaces it; `list_packs` reports
it under `shadowed`. `resume_bridge`, `run_pjsr`, `workspace_info`,
`set_workspace` and `list_packs` are reserved and cannot be replaced. If two packs provide the same
tool, the one loaded later wins and the collision is logged.
