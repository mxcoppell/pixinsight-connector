import { buildApi } from '../src/api.mjs';

// api.stats exactly as buildApi() builds it, bound to whichever api object calls it.
const statsOver = (api, viewId) => buildApi({ ctx: { pjsr: (c) => api.pjsr(c), listImages: () => api.listImages() }, platform: {}, workspace: {}, log() {}, version: '0' }).stats(viewId);

export function createFakeBridge({ replies = [] } = {}) {
  const emitted = [];
  let i = 0;
  const next = () => {
    const r = replies[i++];
    if (r === undefined) return { status: 'ok', outputs: { consoleOutput: '' }, result: '' };
    if (typeof r === 'string') return { status: 'ok', outputs: { consoleOutput: r }, result: r };
    return r;
  };
  return {
    emitted,
    ctx: {
      async pjsr(code) { emitted.push(code); return next(); },
      async listImages() { return []; },
      log() {},
    },
  };
}

// Pack API v1 shape over a fake ctx, so core and pack handlers are called identically in tests.
// Anything not stubbed throws, so a handler that quietly depends on an unstubbed capability fails
// loudly instead of passing against a fake.
// `stats` is the real src/api.mjs implementation over the same fake ctx, since core tools read
// statistics through api.stats: its PJSR reaches ctx.pjsr like any other call.
export function apiFrom(ctx, overrides = {}) {
  const unstubbed = (name) => async () => { throw new Error(`${name} is not stubbed in this test`); };
  const api = {
    pjsr: (code) => ctx.pjsr(code),
    runProcess: unstubbed('runProcess'),
    stats: (viewId) => statsOver(api, viewId),
    listImages: () => ctx.listImages(),
    workspace: { dir: '/tmp/ws', scratchDir: '/tmp/ws/agentic/scratch', outputDir: '/tmp/ws/output' },
    platform: {
      piBin: '/fake/PixInsight',
      imageSolverPath: '/fake/ImageSolver.js',
      filterDbPath: '/fake/filters.xspd',
      whiteRefPath: '/fake/white-references.xspd',
      settingsPath: '/fake/core-001-pxi.settings',
      verified: true,
    },
    log: () => {},
    connectorVersion: '0.0.0-test',
    ...overrides,
  };
  return api;
}
