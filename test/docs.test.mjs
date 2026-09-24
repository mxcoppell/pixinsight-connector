// Doc-accuracy gate. Every backticked token in the top-level docs that names a repo path must exist,
// every one that looks like a tool name must be a real tool, every PIXINSIGHT_* variable must be one
// the code reads, and every relative markdown link must resolve (anchor included). Stale docs are
// what this repo is designed against: five "historical" design documents rotted unnoticed.
//
// How a backticked token is classified (fenced code blocks are skipped; they are examples):
//   - contains whitespace, or starts with ~ / < $ % @ - # { [ " * \ or http, or a drive letter:
//     a command, a snippet, a user-machine path or a URL. Not checked.
//   - contains "/": a repo path if its first segment is a known repo root (REPO_ROOTS) or exists at
//     the repo root; then it must exist (globs are checked up to the first wildcard). Paths under
//     scratch roots that are never committed (local/, node_modules/, ...) are always an error.
//     Anything else (`.cursor/mcp.json`, `owner/repo`) is someone else's path. Not checked.
//   - a bare `*.md` must exist at the repo root; a bare `*.mjs` or `*.js` must exist somewhere in the
//     repo, or be a PixInsight script listed in EXTERNAL_FILES.
//     Scratch directory names on their own (`node_modules`) are not paths into the repo either.
//   - snake_case with an underscore: a tool name. Must be a catalog tool (core or server-defined), a
//     parameter of one, a tool of a test fixture pack, or listed in NON_TOOL_IDENTIFIERS.
//   - PIXINSIGHT_*: must appear in src/.
//   - camelCase, possibly dotted or called (`defineProcessTool`, `buildCoreCatalog()`): an API name.
//     Must appear in src/*.mjs or pjsr/*.js, or be another program's key in NON_CODE_API_NAMES.
//
// docs/bridge-protocol.md gets the path, variable and link checks, and instead of the tool-name check
// every identifier it names (`createBridge()`, `outputs.images`, `run_script`) must appear in src/*.mjs
// or pjsr/*.js, except the few listed in BRIDGE_DOC_NON_CODE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildCoreCatalog } from '../src/tools/index.mjs';
import { assembleCatalog } from '../src/server.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = ['README.md', 'CONTRIBUTING.md', 'AGENTS.md', 'CLAUDE.md', 'COMMUNITY.md', 'docs/setup.md', 'docs/tools.md', 'docs/troubleshooting.md'];
// The protocol reference is held to the path, variable and link checks too, plus its own identifier
// check below. It is not held to the tool-name check: its snake_case words are watcher command names.
const BRIDGE_DOC = path.join('docs', 'bridge-protocol.md');
const CHECKED_DOCS = [...DOCS, BRIDGE_DOC];

// Top-level directories a doc might point into, including retired ones, so a reference into a
// directory that has since been deleted still counts as a repo path (and fails) rather than
// silently passing as "someone else's path".
const REPO_ROOTS = new Set(['src', 'pjsr', 'test', 'docs', 'packs', '.github', '.claude', 'agents', 'scripts', 'editor']);
// Present on a developer's disk, never in a clean clone: a doc pointing here is always wrong.
const SCRATCH_ROOTS = new Set(['local', 'node_modules', 'build', 'dist', '.superpowers']);
// Directories that live in the user's workspace or project, never in this repo, even if a local run
// happened to create one at the repo root.
const EXTERNAL_ROOTS = new Set(['agentic', 'output', '.pixinsight', '.cursor', '.vscode']);

// snake_case words in the docs that are not tools: harness config keys and illustrative names.
const NON_TOOL_IDENTIFIERS = new Set([
  'mcp_servers', // Codex CLI config table
  'context_servers', // Zed config key
  'export_view', // CONTRIBUTING.md's hand-written-descriptor example
]);

// camelCase words in the docs that name nothing in this repo's code: other programs' keys.
const NON_CODE_API_NAMES = new Set([
  'mcpServers', // the harness config key most MCP clients use
]);

// Bare script names the docs mention that ship with PixInsight, not with this repo.
const EXTERNAL_FILES = new Set([
  'ImageSolver.js', // PixInsight's own AdP script, #included by the watcher
]);

const lf = (s) => s.replace(/\r\n/g, '\n');

// Inline code spans outside fenced blocks and HTML comments, with the line each starts on.
export function inlineCode(markdown) {
  const text = lf(markdown)
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, (m) => m.replace(/[^\n]/g, ' '));
  const out = [];
  for (const m of text.matchAll(/(`+)([\s\S]*?[^`])\1(?!`)/g)) {
    out.push({ token: m[2].trim(), line: text.slice(0, m.index).split('\n').length });
  }
  return out;
}

export function classify(token) {
  if (!token || /\s/.test(token) || SCRATCH_ROOTS.has(token)) return 'skip';
  if (/^(?:[~/<$%@\-#{["*\\]|https?:|[A-Za-z]:[\\/])/.test(token)) return 'skip';
  if (/^PIXINSIGHT_[A-Z0-9_]+$/.test(token)) return 'env';
  if (token.includes('/')) return 'path';
  if (/^[\w.-]+\.(?:md|mjs|js)$/.test(token)) return 'file';
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(token)) return 'tool';
  return 'skip';
}

async function allRepoFiles(dir = ROOT, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || SCRATCH_ROOTS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await allRepoFiles(full, out);
    else out.push(full);
  }
  return out;
}

// Returns an error string, or null when the path is fine or not a repo path at all.
function checkPath(token) {
  const clean = token.replace(/:\d+(?:-\d+)?$/, '').replace(/\(\)$/, '').replace(/\/+$/, '');
  const segments = clean.split('/');
  if (segments[0].includes(':') || EXTERNAL_ROOTS.has(segments[0])) return null; // github:owner/repo, workspace dirs
  if (SCRATCH_ROOTS.has(segments[0])) return `\`${token}\` points into ${segments[0]}/, which is never committed`;
  if (!REPO_ROOTS.has(segments[0]) && !existsSync(path.join(ROOT, segments[0]))) return null;
  const literal = [];
  for (const s of segments) {
    if (/[*?{<]/.test(s)) break;
    literal.push(s);
  }
  return existsSync(path.join(ROOT, ...literal)) ? null : `\`${token}\` does not exist`;
}

// GitHub's heading anchor: lowercase, punctuation dropped (hyphens kept), spaces to hyphens.
export function slug(heading) {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

async function anchorsOf(file) {
  const text = lf(await readFile(file, 'utf8')).replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '');
  return new Set([...text.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)].map((m) => slug(m[1])));
}

async function knownToolWords() {
  const core = await buildCoreCatalog();
  const { definitions } = assembleCatalog({ core, packs: [], packTools: [], resetBridge: () => {} });
  const tools = new Set(definitions.map((d) => d.name));
  const params = new Set(definitions.flatMap((d) => Object.keys(d.inputSchema?.properties ?? {})));
  const fixtures = new Set();
  const fixturesDir = path.join(ROOT, 'test', 'fixtures');
  for (const e of await readdir(fixturesDir, { withFileTypes: true })) {
    const index = path.join(fixturesDir, e.name, 'index.mjs');
    if (!e.isDirectory() || !existsSync(index)) continue;
    try {
      const mod = await import(pathToFileURL(index).href);
      for (const t of Array.isArray(mod.tools) ? mod.tools : []) fixtures.add(t.name);
    } catch {
      // pack-throws exists to fail on import; it has no tools to learn.
    }
  }
  return { tools, params, fixtures };
}

async function srcText() {
  const files = (await allRepoFiles(path.join(ROOT, 'src'))).filter((f) => f.endsWith('.mjs'));
  return (await Promise.all(files.map((f) => readFile(f, 'utf8')))).join('\n');
}

// The connector's code (src/*.mjs) plus the watcher (pjsr/*.js), with optional chaining flattened so
// a doc's `outputs.images` matches the code's `outputs?.images`.
async function codeText() {
  const files = [
    ...(await allRepoFiles(path.join(ROOT, 'src'))).filter((f) => f.endsWith('.mjs')),
    ...(await allRepoFiles(path.join(ROOT, 'pjsr'))).filter((f) => f.endsWith('.js')),
  ];
  return (await Promise.all(files.map((f) => readFile(f, 'utf8')))).join('\n').replace(/\?\./g, '.');
}

// A backticked token that names something in code: an identifier, optionally dotted or hyphenated
// (`outputs.images`, `last-stop`), optionally called (`ensureWatcher()`, `pjsr(code)`). Returns the
// name without the call, or null for anything else (a path, a message, a placeholder, a command line).
export function codeName(token) {
  const m = token.match(/^([A-Za-z_$@][\w$@.-]*?)(?:\([\w, ]*\))?$/);
  return m ? m[1] : null;
}

function mentionedIn(code, name) {
  return new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\$]/g, '\\$&')}(?![\\w$])`).test(code);
}

// Words in docs/bridge-protocol.md that legitimately name nothing in src/ or pjsr/.
const BRIDGE_DOC_NON_CODE = new Set([
  'O_EXCL', // the POSIX name of the 'wx' flag src/bridge.mjs creates launch.lock with
  'watcher.js.tmp', // composed in src/runtime.mjs as `${destPath}.tmp`
]);

test('every backticked repo path in the checked docs exists', async () => {
  const problems = [];
  const files = (await allRepoFiles()).map((f) => path.basename(f));
  for (const doc of CHECKED_DOCS) {
    for (const { token, line } of inlineCode(await readFile(path.join(ROOT, doc), 'utf8'))) {
      const kind = classify(token);
      if (kind === 'path') {
        const err = checkPath(token);
        if (err) problems.push(`${doc}:${line}: ${err}`);
      } else if (kind === 'file') {
        const ok = token.endsWith('.md') ? existsSync(path.join(ROOT, token)) : files.includes(token) || EXTERNAL_FILES.has(token);
        if (!ok) problems.push(`${doc}:${line}: \`${token}\` does not exist`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('every backticked tool name in the top-level docs is a real tool, a tool parameter or a known example', async () => {
  const { tools, params, fixtures } = await knownToolWords();
  const problems = [];
  for (const doc of DOCS) {
    for (const { token, line } of inlineCode(await readFile(path.join(ROOT, doc), 'utf8'))) {
      if (classify(token) !== 'tool') continue;
      if (tools.has(token) || params.has(token) || fixtures.has(token) || NON_TOOL_IDENTIFIERS.has(token)) continue;
      problems.push(`${doc}:${line}: \`${token}\` is not a tool in the catalog`);
    }
  }
  assert.deepEqual(problems, []);
});

test('every PIXINSIGHT_* variable named in the checked docs is read somewhere in src/', async () => {
  const src = await srcText();
  const problems = [];
  for (const doc of CHECKED_DOCS) {
    for (const { token, line } of inlineCode(await readFile(path.join(ROOT, doc), 'utf8'))) {
      if (classify(token) === 'env' && !new RegExp(`\\b${token}\\b`).test(src)) problems.push(`${doc}:${line}: \`${token}\` is not read by src/`);
    }
  }
  assert.deepEqual(problems, []);
});

test('every relative markdown link in the checked docs resolves, including its #anchor', async () => {
  const problems = [];
  for (const doc of CHECKED_DOCS) {
    const text = lf(await readFile(path.join(ROOT, doc), 'utf8')).replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '');
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^[a-z]+:/i.test(target)) continue; // http:, https:, mailto:
      const [file, anchor] = target.split('#');
      const dest = file ? path.join(ROOT, path.dirname(doc), file) : path.join(ROOT, doc);
      if (!existsSync(dest)) {
        problems.push(`${doc}: link target ${target} does not exist`);
      } else if (anchor && dest.endsWith('.md') && !(await anchorsOf(dest)).has(anchor)) {
        problems.push(`${doc}: link ${target} has no heading #${anchor}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

// A camelCase API name, possibly dotted (`outputs.consoleOutput`), as returned by codeName().
export function isCamelApiName(name) {
  return /^[a-z][\w$.]*[a-z0-9][A-Z][\w$.]*$/.test(name ?? '') && !name.endsWith('.');
}

test('every camelCase API name in the checked docs exists in src/ or pjsr/', async () => {
  const code = await codeText();
  const problems = [];
  for (const doc of CHECKED_DOCS) {
    for (const { token, line } of inlineCode(await readFile(path.join(ROOT, doc), 'utf8'))) {
      const name = codeName(token);
      if (!isCamelApiName(name) || NON_CODE_API_NAMES.has(name) || mentionedIn(code, name)) continue;
      problems.push(`${doc}:${line}: \`${token}\` names nothing in src/ or pjsr/`);
    }
  }
  assert.deepEqual(problems, []);
});

test('every identifier docs/bridge-protocol.md names exists in src/ or pjsr/', async () => {
  const code = await codeText();
  const problems = [];
  for (const { token, line } of inlineCode(await readFile(path.join(ROOT, BRIDGE_DOC), 'utf8'))) {
    const kind = classify(token);
    if (kind === 'path' || kind === 'env' || kind === 'file') continue; // checked by the tests above
    const name = codeName(token);
    if (!name || BRIDGE_DOC_NON_CODE.has(name) || mentionedIn(code, name)) continue;
    problems.push(`${BRIDGE_DOC}:${line}: \`${token}\` names nothing in src/ or pjsr/`);
  }
  assert.deepEqual(problems, []);
});

// "Documentation is brief or it is wrong": the README stays short; the tool list lives in docs/tools.md.
const README_MAX_LINES = 120;
test(`README.md is at most ${README_MAX_LINES} lines`, async () => {
  const counted = lf(await readFile(path.join(ROOT, 'README.md'), 'utf8')).replace(/\n$/, '').split('\n').length;
  assert.ok(counted <= README_MAX_LINES, `README.md has ${counted} lines; the limit is ${README_MAX_LINES}`);
});

test('the classifier tells paths, tools, variables and commands apart', () => {
  assert.equal(classify('src/tools/index.mjs'), 'path');
  assert.equal(classify('src/tools/*.mjs'), 'path');
  assert.equal(classify('.cursor/mcp.json'), 'path'); // then treated as external by checkPath
  assert.equal(classify('~/packs/my-pack/'), 'skip');
  assert.equal(classify('npx -y github:mxcoppell/pixinsight-connector'), 'skip');
  assert.equal(classify('C:\\Program'), 'skip');
  assert.equal(classify('https://example.com/x'), 'skip');
  assert.equal(classify('<state>/watcher/<version>/watcher.js'), 'skip');
  assert.equal(classify('CONTRIBUTING.md'), 'file');
  assert.equal(classify('run_process'), 'tool');
  assert.equal(classify('defineProcessTool'), 'skip'); // checked by isCamelApiName instead
  assert.equal(classify('watcher.template.js'), 'file');
  assert.ok(isCamelApiName('defineProcessTool'));
  assert.ok(isCamelApiName('outputs.consoleOutput'));
  assert.ok(!isCamelApiName('run_process'));
  assert.ok(!isCamelApiName('SCNR.MaximumMask'));
  assert.ok(!isCamelApiName('pjsr'));
  assert.equal(classify('PIXINSIGHT_BIN'), 'env');
  assert.equal(checkPath('.cursor/mcp.json'), null);
  assert.equal(checkPath('mxcoppell/pixinsight-pack-astro'), null);
  assert.equal(checkPath('github:mxcoppell/pixinsight-connector'), null);
  assert.match(checkPath('src/no-such-module.mjs'), /does not exist/);
  assert.match(checkPath('scripts/run-pipeline-that-never-was.mjs'), /does not exist/);
  assert.match(checkPath('local/notes.md'), /never committed/);
  assert.equal(checkPath('src/tools/*.mjs'), null);
});

test('inlineCode skips fenced blocks and comments, and handles double-backtick spans', () => {
  const md = [
    'Use `run_process` here.',
    '```js',
    'const x = `not_a_token`;',
    '```',
    '<!-- `hidden_token` -->',
    'A span with a backtick inside: `` `var P = new X;` `` and `src/cli.mjs`.',
  ].join('\n');
  assert.deepEqual(inlineCode(md).map((t) => t.token), ['run_process', '`var P = new X;`', 'src/cli.mjs']);
  assert.equal(slug('Developing a pack'), 'developing-a-pack');
  assert.equal(codeName('ensureWatcher()'), 'ensureWatcher');
  assert.equal(codeName('pjsr(code)'), 'pjsr');
  assert.equal(codeName('outputs.images'), 'outputs.images');
  assert.equal(codeName('last-stop'), 'last-stop');
  assert.equal(codeName('Timeout: <tool>'), null);
  assert.equal(codeName('-x=<path>'), null);
  assert.equal(codeName('"running"'), null);
  assert.equal(slug('Credit, and why this was rearchitected'), 'credit-and-why-this-was-rearchitected');
});
