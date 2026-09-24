// ============================================================================
// The extension seam: declare a PixInsight process as a tool descriptor without
// hand-writing PJSR. `defineProcessTool` turns a declarative `params` spec into
// `new <Process>` + parameter assignment + `executeOn`, and a JSON Schema for
// the MCP tool's inputSchema. `catalogFrom` flattens a `tools` array (core or a
// third-party pack) into the `{ definitions, handlers }` shape an MCP server
// wires up directly.
//
// No processing opinion belongs here or in any `description` a tool declares:
// state what a parameter is, never what value to pick. See CONTRIBUTING.md.
// ============================================================================

const IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

function validateIdentifier(value, label) {
  if (typeof value !== 'string' || !IDENTIFIER_RE.test(value)) {
    throw new Error(
      `${label} must be a bare identifier matching ${IDENTIFIER_RE} (letters, digits, underscore, ` +
      `not starting with a digit); got ${JSON.stringify(value)}`
    );
  }
}

// Native PixInsight processes throw odd values under V8; rethrow a real Error with a
// message. Adapted from the hand-written `guard()` in v0-pipeline:agents/llm/tools-essential.mjs,
// which wraps a fixed PJSR body string — this one wraps PJSR we generate from `params`.
function guard(body) {
  return `(function(){ try {
  function __run(P, v) { if (!P.executeOn(v)) throw new Error('the process did not run (see console message)'); }
  ${body}
} catch (e) { throw new Error(e && e.message ? e.message : String(e)); } })()`;
}

// The PJSR literal for one parameter's value. `constantsFrom` means the value is a
// bare V8 constant name off that object (e.g. `SCNR.MaximumMask`), never `.prototype.`
// and never quoted. Otherwise the literal follows the declared JSON Schema `type`.
function literalFor(def, key, value) {
  if (def.constantsFrom) {
    // `value` is only ever reached here after enum membership has been checked, so it
    // is already known to be one of `def.enum` — themselves validated at definition
    // time. Re-validate anyway: cheap, and it keeps this function safe if ever called
    // with an unchecked value.
    validateIdentifier(String(value), `"${key}" value`);
    return `${def.constantsFrom}.${value}`;
  }
  switch (def.type) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`"${key}" must be a finite number; got ${JSON.stringify(value)}`);
      }
      return String(value);
    }
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
    default:
      return JSON.stringify(String(value));
  }
}

function schemaForParam(def) {
  const prop = { type: def.type, description: def.description };
  if (def.enum) prop.enum = def.enum;
  if (def.default !== undefined) prop.default = def.default;
  return prop;
}

// defineProcessTool(spec) -> descriptor
//
// spec:
//   name        tool name (snake_case), e.g. 'run_scnr'
//   process     PJSR process class name, e.g. 'SCNR' — validated now, not at call time
//   description tool description (no processing opinion — see CONTRIBUTING.md)
//   target      'view' — the only target this seam supports today; the tool takes a
//               required `view_id` and the process runs via `executeOn(view)`. A tool
//               that isn't "run one process on one view" (multiple views, no view,
//               non-PJSR work) is out of scope for this helper — write its descriptor
//               by hand instead (see CONTRIBUTING.md's escape hatch).
//   params      { [key]: { type, pjsr, description, enum?, constantsFrom?, default?, required? } }
//               `pjsr` is the property name assigned on the process instance. `default`
//               is documentation only (surfaces in the JSON Schema); when a param is
//               omitted from a call, nothing is emitted for it and PixInsight's own
//               default stands. `enum` + `constantsFrom` together mean "the value is
//               one of these bare names on that V8 global", e.g. SCNR.MaximumMask.
//               `required: true` adds the param to the schema's `required` list (after
//               `view_id`), and the handler refuses a call that omits it.
//   additionalProperties  optional; `false` puts `additionalProperties: false` in the schema, and
//               the server then refuses a call carrying an argument the schema does not list.
//
// The handler returns `{ text }` naming the process, the view and each parameter it set
// (by its tool-input name), or saying that PixInsight's defaults were used.
export function defineProcessTool(spec) {
  const { name, process, description, target, params = {}, additionalProperties } = spec;

  validateIdentifier(process, 'process name');

  const paramEntries = Object.entries(params);
  for (const [key, def] of paramEntries) {
    if (def.constantsFrom) validateIdentifier(def.constantsFrom, `constantsFrom name (param "${key}")`);
  }

  if (target !== 'view') {
    throw new Error(
      `defineProcessTool("${name}"): unsupported target ${JSON.stringify(target)} — only "view" is ` +
      `currently supported. For anything else, write the descriptor by hand (see CONTRIBUTING.md).`
    );
  }

  const properties = { view_id: { type: 'string', description: 'PixInsight view identifier.' } };
  for (const [key, def] of paramEntries) properties[key] = schemaForParam(def);

  const requiredParams = paramEntries.filter(([, def]) => def.required === true).map(([key]) => key);
  const inputSchema = { type: 'object', properties, required: ['view_id', ...requiredParams] };
  if (additionalProperties === false) inputSchema.additionalProperties = false;

  async function handler(api, input) {
    input = input || {};
    for (const key of inputSchema.required) {
      if (input[key] === undefined || input[key] === null || input[key] === '') {
        throw new Error(`${name}: "${key}" is required`);
      }
    }

    const assignments = [];
    const applied = [];
    for (const [key, def] of paramEntries) {
      const value = input[key];
      if (value === undefined) continue;
      if (def.enum && !def.enum.includes(value)) {
        throw new Error(
          `${name}: invalid value ${JSON.stringify(value)} for "${key}" — expected one of ${def.enum.join(', ')}`
        );
      }
      assignments.push(`P.${def.pjsr} = ${literalFor(def, key, value)};`);
      applied.push(`${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
    }

    const viewIdLiteral = JSON.stringify(input.view_id);
    const lines = [
      `var P = new ${process};`,
      ...assignments,
      `var __w = ImageWindow.windowById(${viewIdLiteral});`,
      `if (__w.isNull) throw new Error('View not found: ' + ${viewIdLiteral});`,
      `__run(P, __w.mainView);`,
    ];

    const r = await api.pjsr(guard(lines.join('\n')));
    if (r.status === 'error') throw new Error(r.error?.message || JSON.stringify(r.error));
    const withText = applied.length ? `with ${applied.join(', ')}` : 'with PixInsight\'s default parameters';
    return { text: `${process} ran on view ${viewIdLiteral} ${withText}.` };
  }

  return { name, description, inputSchema, handler };
}

// catalogFrom(tools) -> { definitions, handlers }
//
// Flattens any `tools` array — the core's own, or a third-party pack's — into the
// shape an MCP server wires up: a list of `{ name, description, inputSchema }` for
// tool registration, and a name -> handler map for dispatch.
export function catalogFrom(tools) {
  const definitions = [];
  const handlers = new Map();
  for (const { name, description, inputSchema, handler } of tools) {
    definitions.push({ name, description, inputSchema });
    handlers.set(name, handler);
  }
  return { definitions, handlers };
}
