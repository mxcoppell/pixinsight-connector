// ============================================================================
// Auto-discovery: every `.mjs` file in this directory (other than this one) is a
// tool module. A tool module exports `tools`, an array of descriptors (built with
// `defineProcessTool` or written by hand — see CONTRIBUTING.md). Adding a tool
// means adding a module here; it never means editing this file or any registry.
// ============================================================================
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { catalogFrom } from '../define.mjs';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.basename(fileURLToPath(import.meta.url));

// buildCoreCatalog() -> Promise<{ definitions, handlers }>
//
// Scans this directory for `.mjs` tool modules and concatenates every module's
// exported `tools` array. A module that exports no `tools` array (e.g. a plain
// helper file) contributes nothing and is not an error. Each import is cache-busted
// so a module rewritten between calls (as tests do via a temp file) is re-read
// rather than served stale from Node's ESM module cache.
export async function buildCoreCatalog() {
  const entries = await readdir(TOOLS_DIR, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.mjs') && e.name !== SELF)
    .map((e) => e.name)
    .sort();

  const tools = [];
  for (const file of files) {
    const href = pathToFileURL(path.join(TOOLS_DIR, file)).href;
    const mod = await import(`${href}?bust=${Date.now()}-${Math.random()}`);
    if (Array.isArray(mod.tools)) tools.push(...mod.tools);
  }

  return catalogFrom(tools);
}
