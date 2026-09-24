// ============================================================================
// Execution primitives: raw PJSR, PixelMath in place, PixelMath into a new
// image. Ported from v0-pipeline:agents/llm/tools.mjs, v0-pipeline:agents/llm/tools-essential.mjs and
// v0-pipeline:agents/llm/mcp-interactive.mjs. run_process and run_pjsr_file are Task 6's.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const q = (s) => JSON.stringify(String(s));

const IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

function validateIdentifier(value, label) {
  if (typeof value !== 'string' || !IDENTIFIER_RE.test(value)) {
    throw new Error(
      `${label} must be a bare identifier matching ${IDENTIFIER_RE} (letters, digits, underscore, ` +
      `not starting with a digit); got ${JSON.stringify(value)}`
    );
  }
}

// Native PixInsight processes throw odd values under V8; rethrow a real Error with a message.
// Same shape as the guard() in v0-pipeline:agents/llm/tools-essential.mjs:19 and src/define.mjs — duplicated
// per file by this repo's convention (see CONTRIBUTING.md's escape hatch) rather than shared.
function guard(body) {
  return `(function(){ try {
  function __run(P, v) { if (!P.executeOn(v)) throw new Error('the process did not run (see console message)'); }
  ${body}
} catch (e) { throw new Error(e && e.message ? e.message : String(e)); } })()`;
}

// runProcess(api, name, params, viewId) -> { ok, message }
//
// The generic escape hatch: instantiate any PixInsight process by its PJSR
// constructor name, assign JSON-valued parameters, and run it — on a view via
// executeOn() when viewId is given, or globally via executeGlobal() otherwise.
// `name` is the one tool argument in this whole file that becomes code (it is
// interpolated bare as `new <name>`), so it is validated against the bare-
// identifier pattern before any string is built. Each params key becomes a
// bare `P.<key> = ...` assignment target and is validated the same way; each
// value is emitted via JSON.stringify, so only JSON-representable values
// (numbers, strings, booleans, arrays, plain objects) can be assigned.
export async function runProcess(api, name, params, viewId) {
  validateIdentifier(name, 'process name');

  const assignments = [];
  for (const [key, value] of Object.entries(params || {})) {
    validateIdentifier(key, `param key "${key}"`);
    assignments.push(`P.${key} = ${JSON.stringify(value)};`);
  }

  const hasView = viewId !== undefined && viewId !== null;
  const nameLiteral = JSON.stringify(name);
  const lines = [`var P = new ${name};`, ...assignments];
  if (hasView) {
    const viewIdLiteral = JSON.stringify(viewId);
    lines.push(
      `if (!P.canProcessViews()) throw new Error(${nameLiteral} + ' cannot process views (see console message)');`,
      `var __w = ImageWindow.windowById(${viewIdLiteral});`,
      `if (__w.isNull) throw new Error('View not found: ' + ${viewIdLiteral});`,
      `__run(P, __w.mainView);`
    );
  } else {
    lines.push(
      `if (!P.canProcessGlobal()) throw new Error(${nameLiteral} + ' cannot run globally (see console message)');`,
      `if (!P.executeGlobal()) throw new Error('the process did not run (see console message)');`
    );
  }

  const r = await api.pjsr(guard(lines.join('\n')));
  if (r.status === 'error') throw new Error(r.error?.message || JSON.stringify(r.error));
  return { ok: true, message: hasView ? `${name} executed on ${viewId}.` : `${name} executed globally.` };
}

const runProcessTool = {
  name: 'run_process',
  description: 'Instantiate any PixInsight process by its PJSR constructor name, assign JSON-valued parameters onto the instance, and execute it on a view (when view_id is given) or globally (when it is omitted). Generic fallback for processes with no dedicated tool.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'PJSR process constructor name, e.g. "SCNR".' },
      params: { type: 'object', description: 'Property name to JSON-valued setting, assigned on the process instance before it runs.' },
      view_id: { type: 'string', description: 'View to run the process on. Omit to run the process globally instead.' },
    },
    required: ['name'],
  },
  async handler(api, input) {
    input = input || {};
    if (!input.name) throw new Error('run_process: "name" is required');
    const result = await runProcess(api, input.name, input.params, input.view_id);
    return { text: JSON.stringify(result) };
  },
};

// PixInsight runs a snippet with eval(), so a snippet that does not parse fails there with no line
// number and an error in the Process Console. Parse it here first and name the line instead.
// Node's V8 is at least as new as PixInsight's, so it never rejects code PixInsight would accept.
export function syntaxProblem(parts) {
  const code = parts.map((p) => p.text).join('\n');
  try {
    new vm.Script(code, { filename: 'pjsr' });
    return null;
  } catch (e) {
    if (!(e instanceof SyntaxError)) return null;
    const m = /^pjsr:(\d+)/m.exec(String(e.stack));
    if (!m) return `Syntax error: ${e.message}`;
    let line = Number(m[1]);
    for (const part of parts) {
      const count = part.text.split('\n').length;
      if (line <= count) {
        const text = part.text.split('\n')[line - 1].trim().slice(0, 200);
        return `Syntax error: ${e.message}, ${part.name} line ${line}: ${JSON.stringify(text)}`;
      }
      line -= count;
    }
    return `Syntax error: ${e.message}`;
  }
}

async function runChecked(api, parts) {
  const problem = syntaxProblem(parts);
  if (problem) return { isError: true, text: `${problem}. Nothing was sent to PixInsight.` };
  const r = await api.pjsr(parts.map((p) => p.text).join('\n'));
  if (r.status === 'error') return { isError: true, text: `PJSR error: ${r.error?.message ?? JSON.stringify(r.error)}` };
  return { text: String(r.result ?? '') };
}

function readSource(file, label) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error(`${label} must be an absolute path: ${JSON.stringify(file)}`);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`${label} cannot be read: ${file} (${e.code || e.message})`);
  }
}

const runPjsrFile = {
  name: 'run_pjsr_file',
  description: 'Run a PJSR (JavaScript, V8 engine) source file from disk inside PixInsight and return its console output. Same execution model as run_pjsr, with the code read from a file instead of passed inline. No ES6 module syntax; the file content is eval-ed, so #include does not work. Code that does not parse is refused with its line number before anything reaches PixInsight.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Absolute path to the PJSR source file.' } },
    required: ['path'],
  },
  async handler(api, input) {
    const code = readSource(input.path, 'path');
    return runChecked(api, [{ name: path.basename(input.path), text: code }]);
  },
};

const runPjsr = {
  name: 'run_pjsr',
  description: 'Run a PJSR (JavaScript, V8 engine) snippet inside PixInsight and return its console output. Last resort for things the other tools do not cover. Call processEvents() before each long process (BXT, NXT, SXT) so Pause/Abort works. No ES6 module syntax; the snippet is eval-ed as a script, so #include does not work and a top-level return is a syntax error; `include` prepends files instead. Code that does not parse is refused with its line number before anything reaches PixInsight.',
  inputSchema: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'PJSR code. The value of the last expression is returned.' },
      include: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of PJSR source files whose contents run before `code`, in this order, in the same scope, so functions they define can be called from `code`.' },
    },
    required: ['code'],
  },
  async handler(api, input) {
    const includes = input.include ?? [];
    if (!Array.isArray(includes)) throw new Error('run_pjsr: "include" must be an array of absolute paths');
    const parts = includes.map((f) => ({ name: path.basename(f), text: readSource(f, 'include') }));
    parts.push({ name: 'code', text: String(input.code) });
    return runChecked(api, parts);
  },
};

const runPixelmath = {
  name: 'run_pixelmath',
  description: 'Run an arbitrary PixelMath expression in place on a view. RULES: (1) NO pow() — use exp(exponent*ln(base)). (2) Channel access is $T[0] for R, $T[1] for G, $T[2] for B — NOT $T.R or $T.B. (3) For other images use viewId[0], viewId[1], viewId[2].',
  inputSchema: {
    type: 'object',
    properties: {
      view_id: { type: 'string', description: 'View ID to process' },
      expression: { type: 'string', description: 'PixelMath expression using $T for current pixel value' },
      single_expression: { type: 'boolean', description: 'Apply the same expression to all channels (default true)' },
      symbols: { type: 'string', description: 'Symbol declarations (comma-separated)' },
    },
    required: ['view_id', 'expression'],
  },
  async handler(api, input) {
    const useSingle = input.single_expression !== false ? 'true' : 'false';
    const pmResult = await api.pjsr(`
      var P = new PixelMath;
      P.expression = ${q(input.expression)};
      P.useSingleExpression = ${useSingle};
      ${input.symbols ? `P.symbols = ${q(input.symbols)};` : ''}
      P.use64BitWorkingImage = true;
      P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
      P.createNewImage = false;
      if (!P.executeOn(ImageWindow.windowById(${q(input.view_id)}).mainView)) throw new Error('PixelMath did not run');
    `);
    if (pmResult.status === 'error') {
      return { isError: true, text: `PixelMath FAILED: ${pmResult.error?.message ?? JSON.stringify(pmResult.error)}` };
    }
    return { text: 'PixelMath applied.' };
  },
};

const pixelmathNewImage = {
  name: 'pixelmath_new_image',
  description: 'Run PixelMath to create a NEW image from expressions that reference other open views by id. Color "rgb" takes red/green/blue expressions; color "gray" takes a single expression. View ids used inside expressions must be simple identifiers (rename_view renames a view). No pow() — use exp(exponent*ln(base)) or the ^ operator.',
  inputSchema: {
    type: 'object',
    properties: {
      output_id: { type: 'string', description: 'Id for the new image' },
      size_from: { type: 'string', description: 'A view whose width and height the new image copies' },
      color: { type: 'string', enum: ['rgb', 'gray'] },
      red: { type: 'string', description: 'Red channel expression (color "rgb")' },
      green: { type: 'string', description: 'Green channel expression (color "rgb")' },
      blue: { type: 'string', description: 'Blue channel expression (color "rgb")' },
      expression: { type: 'string', description: 'Single expression for color "gray"' },
      symbols: { type: 'string', description: 'PixelMath symbols; constants only, e.g. "k=0.3". Symbols cannot hold images: write image expressions inline.' },
    },
    required: ['output_id', 'size_from', 'color'],
  },
  async handler(api, input) {
    const rgb = input.color === 'rgb';
    if (rgb && !(input.red && input.green && input.blue)) return { isError: true, text: 'color "rgb" needs red, green and blue expressions.' };
    if (!rgb && !input.expression) return { isError: true, text: 'color "gray" needs expression.' };
    const r = await api.pjsr(`
      var __w = ImageWindow.windowById(${q(input.size_from)}); if (__w.isNull) throw new Error('View not found: ' + ${q(input.size_from)});
      var img = __w.mainView.image;
      var P = new PixelMath;
      ${rgb
        ? `P.useSingleExpression = false; P.expression = ${q(input.red)}; P.expression1 = ${q(input.green)}; P.expression2 = ${q(input.blue)};`
        : `P.useSingleExpression = true; P.expression = ${q(input.expression)};`}
      ${input.symbols ? `P.symbols = ${q(input.symbols)};` : ''}
      P.use64BitWorkingImage = true; P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
      P.createNewImage = true; P.showNewImage = true; P.newImageId = ${q(input.output_id)};
      P.newImageWidth = img.width; P.newImageHeight = img.height;
      P.newImageColorSpace = ${rgb ? 'PixelMath.RGB' : 'PixelMath.Gray'};
      P.newImageSampleFormat = PixelMath.f32;
      P.executeGlobal();
      if (ImageWindow.windowById(${q(input.output_id)}).isNull) throw new Error('PixelMath produced no image; check the expressions and that every view id exists.');
    `);
    if (r.status === 'error') throw new Error(r.error?.message || JSON.stringify(r.error));
    return { text: `Created ${input.output_id} (${input.color}).` };
  },
};

export const tools = [runPjsr, runPixelmath, pixelmathNewImage, runProcessTool, runPjsrFile];
