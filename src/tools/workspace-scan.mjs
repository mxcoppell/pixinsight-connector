// ============================================================================
// Workspace scan: find image masters under the workspace, any subfolder name.
// Ported from v0-pipeline:agents/llm/mcp-interactive.mjs's scan_target, renamed to
// scan_workspace. The channel-guessing (mapping a FILTER value or filename
// token to L/R/G/B/Ha/Oiii/Sii) is dropped — that is a processing-workflow
// judgment, not a capability fact — so this reports the FILTER header (or
// null) verbatim instead of a guessed channel.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { isInside } from '../workspace.mjs';

const IMAGE_EXT = /\.(xisf|fits?|fts)$/i;
// Skipped by name at any depth. The connector's own folders (the state folder and output/) are
// skipped by full path instead, so a user's nested folder that happens to be called `output` is
// still scanned. `.pixinsight` is the state folder's pre-1.1 name, left behind in old workspaces.
const SKIP_DIRS = new Set(['node_modules', '.git', '.pixinsight']);

// The keywords reported verbatim (quotes stripped) for every file, null when absent.
const REPORTED_KEYWORDS = ['INSTRUME', 'TELESCOP', 'FOCALLEN', 'XPIXSZ', 'YPIXSZ', 'XBINNING'];
// The XISF properties PixInsight (1.8.9 and later) writes for an astrometric solution; the three
// its own WCS readers need (src/scripts/AdP/WCSmetadata.jsh) make a solution.
const SOLUTION_PROPERTIES = ['ProjectionSystem', 'ReferenceCelestialCoordinates', 'LinearTransformationMatrix'].map((n) => `PCL:AstrometricSolution:${n}`);
const MAX_HEADER = 4 * 1024 * 1024;

const decodeXml = (t) => t.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|quot|apos|amp);/gi, (m, e) => {
  const named = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[e.toLowerCase()];
  if (named) return named;
  const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return Number.isFinite(code) ? String.fromCodePoint(code) : m;
});

// A FITS value as written: a quoted string (with '' for a quote, trailing blanks not significant)
// loses its quotes; anything else is trimmed.
function unquote(v) {
  const t = v.trim();
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'").trimEnd();
  return t;
}

// The elements of an XML header, each { name, attrs }. Comments and CDATA are skipped, so text
// that merely mentions a keyword or a property (a processing history) is never read as one.
function xmlElements(xml) {
  const clean = xml.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const out = [];
  for (const m of clean.matchAll(/<([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>/g)) {
    const attrs = {};
    for (const a of m[2].matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decodeXml(a[2] ?? a[3]);
    out.push({ name: m[1], attrs });
  }
  return out;
}

// headerFacts({ keywords, properties, geometry, colorSpace }) -> what scan_workspace reports.
// `keywords` maps a FITS keyword to its first value (unquoted); `properties` is the set of XISF property ids.
function headerFacts({ keywords, properties, geometry, colorSpace }) {
  const kw = (name) => (keywords.has(name) ? keywords.get(name) : null);
  const exp = kw('EXPTIME') || kw('EXPOSURE');
  const wcsKeywords = ['CTYPE1', 'CTYPE2', 'CRVAL1', 'CRVAL2'].every((k) => kw(k))
    && ['CD1_1', 'CDELT1', 'PC1_1'].some((k) => kw(k));
  return {
    geometry,
    colorSpace,
    filter: kw('FILTER') || kw('FILT-1') || kw('FILTER1'),
    object: kw('OBJECT'),
    exposureS: exp ? Number(exp) : null,
    hasWCS: wcsKeywords || SOLUTION_PROPERTIES.every((id) => properties.has(id)),
    keywords: Object.fromEntries(REPORTED_KEYWORDS.map((k) => [k, kw(k)])),
  };
}

// readXisfHeader(file) -> { geometry, colorSpace, filter, object, exposureS, hasWCS, keywords } | null
//
// Reads just the XISF header block (its size is declared in the first 16 bytes, capped at 4MB
// here) rather than opening the whole file. null for anything that is not a well-formed XISF
// header, or that cannot be read at all.
export function readXisfHeader(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    if (head.toString('latin1', 0, 8) !== 'XISF0100') return null;
    const n = Math.min(head.readUInt32LE(8), MAX_HEADER);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, 16);
    const elements = xmlElements(buf.toString('utf8'));
    const keywords = new Map();
    const properties = new Set();
    for (const { name, attrs } of elements) {
      if (name === 'FITSKeyword' && attrs.name && !keywords.has(attrs.name)) keywords.set(attrs.name, unquote(attrs.value ?? ''));
      if (name === 'Property' && attrs.id) properties.add(attrs.id);
    }
    const img = elements.find((e) => e.name === 'Image')?.attrs ?? {};
    return headerFacts({ keywords, properties, geometry: img.geometry ?? null, colorSpace: img.colorSpace ?? null });
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

// readFitsHeader(file) -> the same facts as readXisfHeader | null
//
// Reads the primary header's 2880-byte blocks up to its END card (capped at 4MB). Geometry is
// NAXIS1:NAXIS2:NAXIS3 (1 channel when there is no NAXIS3), colorSpace null. null for anything
// that does not start like a FITS file, or has no END card within the cap.
export function readFitsHeader(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const keywords = new Map();
    const block = Buffer.alloc(2880);
    for (let pos = 0; pos < MAX_HEADER; pos += 2880) {
      if (fs.readSync(fd, block, 0, 2880, pos) !== 2880) return null;
      const text = block.toString('latin1');
      if (pos === 0 && !text.startsWith('SIMPLE  =')) return null;
      for (let i = 0; i < 2880; i += 80) {
        const c = text.slice(i, i + 80);
        const name = c.slice(0, 8).trim();
        if (name === 'END') {
          const naxis = [1, 2, 3].map((k) => keywords.get(`NAXIS${k}`));
          const geometry = naxis[0] && naxis[1] ? `${naxis[0]}:${naxis[1]}:${naxis[2] || 1}` : null;
          return headerFacts({ keywords, properties: new Set(), geometry, colorSpace: null });
        }
        if (c.slice(8, 10) !== '= ' || keywords.has(name)) continue;
        const raw = c.slice(10);
        // A string value may contain '/', a comment follows the closing quote.
        const str = raw.match(/^\s*'((?:[^']|'')*)'/);
        keywords.set(name, str ? unquote(`'${str[1]}'`) : raw.split('/')[0].trim());
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

// scanWorkspace(workspaceDir, skipPaths) -> { workspace, files }
function scanWorkspace(workspaceDir, skipPaths = []) {
  const files = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 4 && !SKIP_DIRS.has(e.name) && !skipPaths.some((s) => isInside(full, s))) walk(full, depth + 1);
      } else if (IMAGE_EXT.test(e.name)) {
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        const h = /\.xisf$/i.test(e.name) ? readXisfHeader(full) : readFitsHeader(full);
        files.push({
          path: full,
          rel: path.relative(workspaceDir, full),
          sizeMB: Math.round(st.size / 1048576),
          filter: h?.filter ?? null,
          ...(h || {}),
        });
      }
    }
  };
  walk(workspaceDir, 0);
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return { workspace: workspaceDir, files };
}

export const tools = [{
  name: 'scan_workspace',
  description: 'Scan the working folder (recursively, any subfolder name) for XISF/FITS files and report each one\'s FILTER header value, geometry, exposure, ' +
    'whether it has an astrometric solution (WCS keywords CTYPE/CRVAL with a CD, CDELT or PC matrix, or PixInsight\'s PCL:AstrometricSolution properties), ' +
    'and its INSTRUME, TELESCOP, FOCALLEN, XPIXSZ, YPIXSZ and XBINNING keywords verbatim (null when absent). ' +
    'The connector\'s own state and output folders are not scanned. Read-only.',
  inputSchema: { type: 'object', properties: {} },
  async handler(api, _input) {
    const { dir, scratchDir, outputDir } = api.workspace;
    // The state folder is scratchDir's parent (src/workspace.mjs's workspacePaths). A folder that is
    // the workspace itself or above it (PIXINSIGHT_CONNECTOR_STATE=.) is not skipped: that would skip everything.
    const skip = [path.dirname(scratchDir), outputDir].filter((s) => s && !isInside(dir, s));
    const result = scanWorkspace(dir, skip);
    return { text: JSON.stringify(result, null, 2) };
  },
}];
