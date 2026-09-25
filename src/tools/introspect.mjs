// ============================================================================
// Process introspection: enumerate every PixInsight process constructor and
// describe one's parameters, constants and execution capabilities.
//
// Built against the introspection spike's measured facts (PixInsight 1.9.5,
// macOS, 2026-09-22 — see Task 6's write-up), which contradict the obvious
// first guess in four ways:
//   1. There is no `Process` base class and no `Process.allProcesses()`. Every
//      process is a global constructor (`SCNR`, `PixelMath`, ...) sitting
//      among hundreds of other globals (UI widgets, catalogs, dialogs).
//   2. A process constructor is identified by its prototype chain —
//      `typeof C === 'function' && C.prototype instanceof ProcessInstance` —
//      with nothing ever instantiated to classify it. Instantiating a global
//      to find out what it is would open dialogs.
//   3. Parameters are isolated by value type, not by ownership:
//      `Object.keys(new SCNR)` already returns exactly the instance's own
//      members (its inherited-looking methods are own properties too, so
//      there is nothing to subtract against the prototype). The only correct
//      filter is `typeof value !== 'function'`.
//   4. Constants are non-enumerable own properties of the constructor, not
//      the prototype: `for (var k in SCNR)` returns `[]`.
//      `Object.getOwnPropertyNames(SCNR)` returns own names including
//      `length`/`name`/`prototype`, so constants are isolated by filtering to
//      `typeof value === 'number'`, never by an exclusion list (some
//      processes' own names include non-constant, non-numeric members too).
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

// Native PixInsight/PJSR code can throw odd (non-Error) values; rethrow a real Error with a message.
function guard(body) {
  return `(function(){ try {
  ${body}
} catch (e) { throw new Error(e && e.message ? e.message : String(e)); } })()`;
}

// A name that is not a process (undeclared, or a non-process global such as CheckBox) otherwise
// surfaces as PixInsight's bare "X is not defined". Same classification as list_processes, and it
// never instantiates the global.
function unknownProcessCheck(name) {
  return `if (typeof ${name} !== 'function' || !(${name}.prototype instanceof ProcessInstance)) ` +
    `throw new Error('No PixInsight process named ${name}. The name is a PJSR process constructor name; ` +
    `list_processes lists the ones installed.');`;
}

function parseJsonResult(r, what) {
  if (r.status === 'error') throw new Error(r.error?.message || JSON.stringify(r.error));
  const raw = r.outputs?.consoleOutput ?? r.result ?? '';
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${what}: could not parse PJSR result as JSON (${e.message}): ${JSON.stringify(raw)}`);
  }
}

// The verified list_processes enumeration shape (see file header, finding 1/2),
// kept as one literal string matching the spike's own snippet exactly, byte
// for byte, for auditability.
const LIST_PROCESSES_PJSR = `
  var DEPRECATED = { coreDocDirPath:1, coreDirPath:1, coreColorDirPath:1,
                     coreBinDirPath:1, coreBaseDirPath:1, coreAppDirPath:1 };
  var g = globalThis, procs = [];
  for (var k in g) {
    if (DEPRECATED[k]) continue;
    try { var C = g[k]; if (typeof C === 'function' && C.prototype instanceof ProcessInstance) procs.push(k); }
    catch (e) {}
  }
  JSON.stringify(procs.sort());
`;

// listProcesses(api) -> { processes: string[] }
//
// Enumerates every global whose prototype chain descends from ProcessInstance.
// Never instantiates anything — some globals (e.g. CatalogDownloaderDialog)
// are dialogs, and opening one to classify it would be a disaster.
export async function listProcesses(api) {
  const r = await api.pjsr(LIST_PROCESSES_PJSR);
  const processes = parseJsonResult(r, 'list_processes');
  return { processes };
}

// describeProcess(api, name) ->
//   { process, category, canProcessViews, canProcessGlobal,
//     parameters: [{name, value, type}], constants: [{name, value}] }
//
// `name` becomes a bare identifier interpolated into PJSR (`new <name>`,
// `Object.getOwnPropertyNames(<name>)`) — the same injection surface
// `run_process` has — so it is validated up front, before any string is built.
export async function describeProcess(api, name) {
  validateIdentifier(name, 'process name');
  const body = `
    ${unknownProcessCheck(name)}
    var P = new ${name};
    var keys = Object.keys(P);
    var parameters = [];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i], v = P[k];
      if (typeof v !== 'function') parameters.push({ name: k, value: v, type: typeof v });
    }
    var ownNames = Object.getOwnPropertyNames(${name});
    var constants = [];
    for (var j = 0; j < ownNames.length; j++) {
      var cn = ownNames[j], cv = ${name}[cn];
      // Every function's own 'length' is itself typeof 'number' (its arity) — exclude the three
      // structural own names by name, not just by value type, or 'length' shows up as a fake
      // constant on every process (name/prototype are never numeric, but excluded for clarity).
      if (cn !== 'length' && cn !== 'name' && cn !== 'prototype' && typeof cv === 'number') {
        constants.push({ name: cn, value: cv });
      }
    }
    return JSON.stringify({
      process: P.processId(),
      category: P.processCategory(),
      canProcessViews: P.canProcessViews(),
      canProcessGlobal: P.canProcessGlobal(),
      parameters: parameters,
      constants: constants
    });
  `;
  const r = await api.pjsr(guard(body));
  return parseJsonResult(r, `describe_process(${name})`);
}

const listProcessesTool = {
  name: 'list_processes',
  description: 'List every PixInsight process available on this installation, by its PJSR constructor name (e.g. "SCNR", "PixelMath"). Read-only; classifies by prototype chain and never instantiates a process to build the list.',
  inputSchema: { type: 'object', properties: {} },
  async handler(api, _input) {
    const result = await listProcesses(api);
    return { text: JSON.stringify(result, null, 2) };
  },
};

const describeProcessTool = {
  name: 'describe_process',
  description: 'Describe one PixInsight process by its PJSR constructor name: whether it can run on a view and/or globally, its current parameter values and their types, and any named numeric constants it exposes for those parameters.',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string', description: 'PJSR process constructor name, e.g. "SCNR".' } },
    required: ['name'],
  },
  async handler(api, input) {
    if (!input?.name) throw new Error('describe_process: "name" is required');
    const result = await describeProcess(api, input.name);
    return { text: JSON.stringify(result, null, 2) };
  },
};

export const tools = [listProcessesTool, describeProcessTool];
