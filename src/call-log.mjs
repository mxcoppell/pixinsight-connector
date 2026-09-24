// ============================================================================
// Full call logs: one append-only JSONL file per server session and workspace,
// `<state>/logs/<YYYYMMDD-HHMMSS>-<pid>.jsonl` (UTC), opened only for a call
// that runs in a workspace, never before (initialize and tools/list stay
// write-free). PIXINSIGHT_CONNECTOR_LOG=0 turns it off.
//
// Where the log goes is decided by the first call that uses the workspace,
// at the moment it first does (touch(): the server calls it on every read of
// api.workspace and every use of the bridge, which reads the workspace), or
// by a successful set_workspace. There is no list of tools: a call that never
// uses the workspace (workspace_info, list_packs, find_filters, a tool name
// that does not exist, ...) waits, and is written, marked `deferred: true`,
// with any event it raised, into the file that decision opens. With a file
// already open in the current workspace, every call is written there as it
// happens. set_workspace itself is written into the NEW workspace's file
// (call_start carries `previousWorkspace`), with any event raised while it
// ran; a file already open in the old workspace gets only the `log switch`
// event. So a server launched in a folder it must not write to, whose first
// call that uses a workspace comes after set_workspace, creates nothing there.
//
// Every record is one line: { v: 1, ts: <ISO>, type, ... }, type one of
//   session     connectorVersion, pid, node, os, workspace, stateDir, machineId,
//               packs, previousLog (the file set_workspace closed, else null)
//   call_start  seq, tool, input (verbatim), written before the handler runs
//   bridge_sent a bridge command as it is sent: seq, cmdId, tool, code (or
//               params), dir, sentAt; so a command that hangs, or a server
//               killed outright, still shows the exact PJSR that was running
//   bridge      the same command once it settled: seq, cmdId, tool, code (or
//               params), dir, sentAt, ms, and the raw watcher result or a
//               failure. A command that failed before it could be sent (a
//               write failure) has only this record.
//   call_end    seq, tool, ms, result (the full MCP result), error (a thrown one)
//   event       launch, relaunch, abort, crash, vanished, quarantine, bridge
//               reset, log switch, exit, start-up errors; seq when inside a call
// Nothing is truncated. The logs hold paths and PJSR code, never pixels.
//
// Records are written synchronously (writeSync on an fd kept open), so a
// process that exits abruptly (exitOnStop, a crash) loses nothing already
// logged. Logging never fails or alters a tool call: a write that fails gives
// one stderr warning and stops logging to that file. With no usable workspace
// nothing is logged (there is nowhere legitimate to write); status() says so.
// Calls made while nothing could be logged for want of a usable workspace, or
// while waiting as above (at most the last UNLOGGED_MAX), are written, with
// their own times and `deferred: true`, into the first file that opens
// afterwards; the set_workspace that fixes an unusable start opens that file
// itself. If no file ever opens, they are not written anywhere.
// A workspace deleted or unmounted mid-session, or a log file deleted while
// open, is noticed before the next write (the workspace check, fstat's link
// count): one warning, that file stops, and nothing is re-created; once the
// workspace is usable again, the next call opens a new file.
//
// Bridge records reach the call that sent them through an AsyncLocalStorage
// (run()); the bridge reports through createBridge's opts.trace (bridge()).
// The fs, clock, pid, exit hook and session info are injected.
// ============================================================================
import nodeFs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { onProcessExit } from './process-probe.mjs';

export const LOG_VERSION = 1;
const MAX_NAME_TRIES = 100;
const UNLOGGED_MAX = 50;
const SET_WORKSPACE = 'set_workspace';

const pad = (n) => String(n).padStart(2, '0');

// logFileName(ms, pid) -> '<YYYYMMDD-HHMMSS>-<pid>.jsonl', in UTC so it does not depend on the machine's zone.
export function logFileName(ms, pid) {
  const d = new Date(ms);
  const date = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return `${date}-${time}-${pid}.jsonl`;
}

const errorFields = (e) => (e instanceof Error || (e && typeof e === 'object' && 'message' in e)
  ? { name: e.name, message: e.message, stack: e.stack }
  : { message: String(e) });

// What a bridge command was sent with: the PJSR itself for run_script, the parameters otherwise.
const payload = (t) => (typeof t.params?.code === 'string' ? { code: t.params.code } : { params: t.params ?? null });

// createCallLog({ workspace, env, fs?, now?, pid?, log?, sessionInfo?, onExit? }) -> call log
//
// `workspace` is a src/workspace.mjs workspace (snapshot(), onChange()). `sessionInfo()` returns the
// session record's connectorVersion, node, os, machineId and packs; it is read when a file opens.
// `onExit(fn)` runs fn(code) when the process exits. Constructing it does no I/O.
export function createCallLog({
  workspace,
  env = {},
  fs = nodeFs,
  now = Date.now,
  pid = process.pid,
  log = () => {},
  sessionInfo = () => ({}),
  onExit = onProcessExit,
}) {
  const enabled = env.PIXINSIGHT_CONNECTOR_LOG !== '0';
  const als = new AsyncLocalStorage();
  const iso = (ms) => new Date(ms).toISOString();

  let seq = 0;
  let current = null; // the file new calls go to: { file, fd, dir, refs, closing, dead, reason }
  let lastFile = null; // the file this session opened last, for the next file's previousLog
  let firstFile = true;
  let exitHooked = false;
  let exited = false;
  const open = new Set(); // sinks whose fd is still open
  const inflight = new Map(); // seq -> call
  const pending = new Map(); // cmdId -> the bridge command's 'sent' trace, with its call's seq and sink
  const startup = []; // start-up events, written after the first file's session record
  const unlogged = []; // calls not yet written: { start, records, end }, each record { type, fields, ts }
  let unloggedDropped = 0;

  function warn(sink, e) {
    sink.dead = true;
    sink.reason = e?.message ?? String(e);
    log(`call log: ${sink.file ? `stopped writing ${sink.file}` : `could not create a log file in ${sink.dir}`}: ${sink.reason}`);
    close(sink);
  }

  function close(sink) {
    if (sink.fd === null) return;
    try { fs.closeSync(sink.fd); } catch {}
    sink.fd = null;
    open.delete(sink);
  }

  // Why the sink's file can no longer be read back, or null: its workspace went missing (deleted,
  // unmounted), or the file itself was deleted while open. Writes to the open fd would still succeed.
  function goneReason(sink) {
    const snap = workspace.snapshot();
    if (snap.dir === sink.workspaceDir && !snap.usable) return `the workspace "${snap.dir}" ${snap.reason}`;
    if (typeof fs.fstatSync === 'function' && fs.fstatSync(sink.fd).nlink === 0) return 'the log file was deleted';
    return null;
  }

  // Stops a sink whose file is gone (one warning), marking it so the next call may open a new one.
  function checkGone(sink) {
    if (!sink || sink.dead || sink.fd === null) return;
    let why;
    try { why = goneReason(sink); } catch (e) { why = e?.message ?? String(e); }
    if (!why) return;
    sink.gone = true;
    warn(sink, new Error(why));
  }

  function write(sink, type, fields, ts = now()) {
    if (!sink || sink.dead || sink.fd === null || exited) return;
    checkGone(sink);
    if (sink.dead) return;
    try {
      const buf = Buffer.from(JSON.stringify({ v: LOG_VERSION, ts: iso(ts), type, ...fields }) + '\n', 'utf8');
      for (let off = 0; off < buf.length;) {
        const n = fs.writeSync(sink.fd, buf, off, buf.length - off);
        if (!(n > 0)) throw new Error('write returned no progress');
        off += n;
      }
    } catch (e) {
      warn(sink, e);
    }
  }

  function openSink(snap) {
    const sink = { file: null, fd: null, dir: snap.logsDir, workspaceDir: snap.dir, refs: 0, closing: false, dead: false, gone: false, reason: null };
    try {
      fs.mkdirSync(snap.logsDir, { recursive: true });
      const base = logFileName(now(), pid).replace(/\.jsonl$/, '');
      for (let i = 1; sink.fd === null; i++) {
        const file = path.join(snap.logsDir, `${base}${i === 1 ? '' : `-${i}`}.jsonl`);
        try {
          sink.fd = fs.openSync(file, 'wx');
          sink.file = file;
        } catch (e) {
          if (e?.code !== 'EEXIST' || i >= MAX_NAME_TRIES) throw e;
        }
      }
    } catch (e) {
      warn(sink, e);
      return sink;
    }
    open.add(sink);
    if (!exitHooked) {
      exitHooked = true;
      onExit(onProcessEnd);
    }
    let info;
    let infoError;
    try { info = sessionInfo() ?? {}; } catch (e) { info = {}; infoError = e?.message ?? String(e); }
    write(sink, 'session', {
      ...info,
      pid,
      workspace: snap.dir,
      workspaceSource: snap.source,
      stateDir: snap.stateDir,
      previousLog: lastFile,
      ...(infoError ? { sessionInfoError: infoError } : {}),
    });
    if (firstFile) for (const e of startup) write(sink, 'event', e.fields, e.ts);
    firstFile = false;
    lastFile = sink.file;
    flushUnlogged(sink);
    return sink;
  }

  function flushUnlogged(sink) {
    if (!unlogged.length && !unloggedDropped) return;
    if (unloggedDropped) write(sink, 'event', { event: 'unlogged calls dropped', count: unloggedDropped, deferred: true }, unlogged[0]?.start.ts);
    for (const entry of unlogged.splice(0)) writeDeferred(sink, entry);
    unloggedDropped = 0;
  }

  // A waiting call's records, written after the fact: call_start, what it raised meanwhile, call_end.
  function writeDeferred(sink, { start, records, end }) {
    write(sink, 'call_start', start.fields, start.ts);
    for (const r of records) write(sink, r.type, r.fields, r.ts);
    write(sink, 'call_end', end.fields, end.ts);
  }

  function release(sink) {
    if (!sink) return;
    sink.refs--;
    if (sink.closing && sink.refs <= 0) close(sink);
  }

  // The current file stops taking new calls; it closes once the calls that started in it have ended.
  function retire(fields) {
    const sink = current;
    if (!sink) return;
    current = null;
    write(sink, 'event', fields);
    sink.closing = true;
    if (sink.refs <= 0) close(sink);
  }

  // The file a call starting now goes to, opening one if needed; null when nothing may be logged.
  // A current file whose workspace or file went missing is stopped here (one warning); once the
  // workspace is usable again, a new file takes its place, linking it as previousLog.
  function sinkForCall() {
    checkGone(current);
    const snap = workspace.snapshot();
    if (!snap.usable) return null;
    if (current && current.workspaceDir !== snap.dir) retire({ event: 'log switch', reason: 'workspace change', from: current.workspaceDir, to: snap.dir });
    if (current?.gone) current = null;
    if (!current) current = openSink(snap);
    return current.dead ? null : current;
  }

  // The file an event or bridge record goes to: its call's, else the current open one.
  const activeSink = () => {
    const call = als.getStore();
    if (call) return call.sink;
    return current && !current.dead ? current : null;
  };

  function onProcessEnd(code) {
    for (const sink of [...open]) {
      const inFlight = [...inflight.values()].filter((c) => c.sink === sink).map((c) => ({ seq: c.seq, tool: c.tool, ms: now() - c.t0 }));
      const pendingBridge = [...pending.values()].filter((p) => p.sink === sink).map((p) => ({
        seq: p.seq, cmdId: p.cmdId, tool: p.tool, ...payload(p), dir: p.dir, sentAt: iso(p.sentAt),
      }));
      write(sink, 'event', { event: 'exit', code: code ?? null, inFlight, pendingBridge });
      close(sink);
    }
    exited = true;
  }

  // A workspace switch closes the current file; the next call opens one in the new workspace.
  workspace.onChange?.(({ previous, current: next }) => {
    try {
      if (!enabled || !current) return;
      retire({ event: 'log switch', reason: 'workspace change', from: previous?.dir ?? current.workspaceDir, to: next?.dir ?? null });
    } catch {}
  });

  // Nothing below may throw into a tool call.
  const safe = (fn, fallback) => (...args) => {
    try { return fn(...args); } catch (e) {
      try { log(`call log: ${e?.message ?? e}`); } catch {}
      return typeof fallback === 'function' ? fallback(...args) : fallback;
    }
  };

  // A file open in the current, usable workspace, else null.
  function liveFile() {
    checkGone(current);
    const snap = workspace.snapshot();
    return snap.usable && current && !current.dead && current.workspaceDir === snap.dir ? current : null;
  }

  function begin(call, sink, input, ts) {
    call.sink = sink;
    sink.refs++;
    inflight.set(call.seq, call);
    write(sink, 'call_start', { seq: call.seq, tool: call.tool, input }, ts);
  }

  // A waiting call that uses the workspace: the log's place is decided now, and the call is written
  // there whole (what it raised while waiting included). Not for set_workspace, which decides at its end.
  function promote(call) {
    if (!call?.deferred || call.deferred.setter || !workspace.snapshot().usable) return;
    const sink = sinkForCall();
    const { input, records } = call.deferred;
    call.deferred = null;
    if (!sink) return; // the log for this workspace failed: the call is not logged, as any other now
    begin(call, sink, input, call.t0);
    for (const r of records) write(sink, r.type, r.fields, r.ts);
  }

  // A record a call raised: kept with the call while it waits, else written to its file (or the open one).
  function emit(call, type, fields) {
    if (call?.deferred) call.deferred.records.push({ type, fields: { ...fields, deferred: true }, ts: now() });
    else write(activeSink(), type, fields);
  }

  const startCall = safe((tool, input) => {
    const call = { seq: ++seq, tool, t0: now(), sink: null };
    if (!enabled) return call;
    const given = input === undefined ? null : input;
    // set_workspace is written where it leaves the log: in the new workspace's file, once it has ended.
    if (tool === SET_WORKSPACE) {
      call.deferred = { input: given, records: [], setter: true, from: workspace.snapshot().dir };
      return call;
    }
    // With a file open in the current workspace, the log's place is already decided.
    const live = liveFile();
    if (live) {
      begin(call, live, given);
      return call;
    }
    // Otherwise the call waits until it uses the workspace (touch(), a bridge command), if it ever does.
    call.deferred = { input: given, records: [] };
    return call;
  }, (tool) => ({ seq: ++seq, tool, t0: now(), sink: null }));

  // run(call, fn): fn runs as `call`, so the bridge records it causes carry its seq.
  const run = (call, fn) => als.run(call, fn);

  const endCall = safe((call, result, error) => {
    if (call?.deferred) {
      const t1 = now();
      const { input, records, setter, from } = call.deferred;
      call.deferred = null;
      const start = { ts: call.t0, fields: { seq: call.seq, tool: call.tool, input, ...(setter ? { previousWorkspace: from } : {}), deferred: true } };
      const end = { ts: t1, fields: { seq: call.seq, tool: call.tool, ms: t1 - call.t0, result: result ?? null, ...(error !== undefined ? { error: errorFields(error) } : {}), deferred: true } };
      // A set_workspace that succeeded decides where the log goes: its file opens now (after any
      // waiting calls), with this call in it. One that failed is written where the log already is.
      const ok = setter && error === undefined && !result?.isError;
      const sink = ok && workspace.snapshot().usable ? sinkForCall() : liveFile();
      if (sink) {
        flushUnlogged(sink);
        writeDeferred(sink, { start, records, end });
        return;
      }
      unlogged.push({ start, records, end });
      if (unlogged.length > UNLOGGED_MAX) { unlogged.shift(); unloggedDropped++; }
      return;
    }
    if (!call?.sink) return;
    inflight.delete(call.seq);
    write(call.sink, 'call_end', {
      seq: call.seq,
      tool: call.tool,
      ms: now() - call.t0,
      result: result ?? null,
      ...(error !== undefined ? { error: errorFields(error) } : {}),
    });
    release(call.sink);
    call.sink = null;
  });

  // bridge(trace): what createBridge's opts.trace reports -- { kind: 'sent' | 'done' | 'failed' | 'event', ... }.
  const bridge = safe((t) => {
    if (!enabled || !t) return;
    const call = als.getStore();
    promote(call); // the bridge lives in the workspace: using it is using the workspace
    if (t.kind === 'event') {
      const { kind: _k, ...fields } = t;
      emit(call, 'event', { ...(call ? { seq: call.seq } : {}), ...fields });
      return;
    }
    if (t.kind === 'sent') {
      const sentWith = { ...t, seq: call?.seq ?? null, sink: activeSink(), call };
      pending.set(t.cmdId, sentWith);
      emit(call, 'bridge_sent', {
        seq: sentWith.seq,
        cmdId: t.cmdId ?? null,
        tool: t.tool,
        ...payload(t),
        dir: t.dir ?? null,
        sentAt: Number.isFinite(t.sentAt) ? iso(t.sentAt) : null,
      });
      return;
    }
    const sentWith = pending.get(t.cmdId);
    pending.delete(t.cmdId);
    const owner = sentWith ? sentWith.call : call;
    const fields = {
      seq: sentWith ? sentWith.seq : call?.seq ?? null,
      cmdId: t.cmdId ?? null,
      tool: t.tool,
      ...payload(t),
      dir: t.dir ?? null,
      sentAt: Number.isFinite(t.sentAt) ? iso(t.sentAt) : null,
      ms: t.ms ?? null,
      ...(t.kind === 'done' ? { result: t.result } : { failure: t.failure }),
    };
    if (owner?.deferred) emit(owner, 'bridge', fields);
    else write(sentWith ? sentWith.sink : activeSink(), 'bridge', fields);
  });

  // event(name, fields): a server-level event (bridge reset, ...), in the current call's file or the
  // open one; raised by a waiting call, it waits with that call (it does not decide where the log goes).
  const event = safe((name, fields = {}) => {
    if (!enabled) return;
    const call = als.getStore();
    emit(call, 'event', { ...(call ? { seq: call.seq } : {}), event: name, ...fields });
  });

  // touch(): the running call uses the workspace (the server calls it on each read of api.workspace
  // and each use of the bridge). A waiting call's log place is decided now; otherwise nothing happens.
  const touch = safe(() => {
    if (enabled) promote(als.getStore());
  });

  // startupEvent(name, fields): something that happened before any call (PixInsight not found, no
  // usable workspace); written after the first file's session record, with the time it happened.
  const startupEvent = safe((name, fields = {}) => {
    if (enabled) startup.push({ ts: now(), fields: { event: name, ...fields } });
  });

  // status() -> what workspace_info reports: { state: 'on' | 'off' | 'skipped' | 'failed', ... }
  const status = safe(() => {
    if (!enabled) return { state: 'off', reason: 'PIXINSIGHT_CONNECTOR_LOG=0' };
    const snap = workspace.snapshot();
    if (!snap.usable) return { state: 'skipped', reason: 'no usable workspace: calls are not logged until set_workspace names one' };
    if (current && current.workspaceDir === snap.dir) {
      if (current.dead) return { state: 'failed', ...(current.file ? { file: current.file } : { dir: current.dir }), reason: current.reason };
      return { state: 'on', file: current.file };
    }
    return { state: 'on', file: null, dir: snap.logsDir };
  }, () => ({ state: 'failed', reason: 'status unavailable' }));

  return Object.freeze({ startCall, run, endCall, bridge, event, touch, startupEvent, status });
}

// The call log a server built without one uses: records nothing.
export const NO_CALL_LOG = Object.freeze({
  startCall: (tool) => ({ seq: 0, tool, sink: null }),
  run: (_call, fn) => fn(),
  endCall: () => {},
  bridge: () => {},
  event: () => {},
  touch: () => {},
  startupEvent: () => {},
  status: () => ({ state: 'off', reason: 'no call log' }),
});
