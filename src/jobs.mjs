// ============================================================================
// Jobs and the one-command gate.
//
// PixInsight runs one script at a time. A tool call waits for its own command, and overlapping calls
// queue in the watcher as before. A job (run_pjsr / run_pjsr_file with `async`) is different: its
// call returns at once, so a later call would otherwise sit behind it, unanswered, for as long as the
// job runs. While a job runs, every call that tries to send a PixInsight command is therefore refused
// with PixInsightBusyError naming the job; job_status and cancel_job read and steer it.
// enter()/leave() also record which calls have sent a command and are still running (for the
// server's hidden-dialog hint).
// Server state, not part of the Pack API: src/server.mjs builds one per server.
// ============================================================================
import crypto from 'node:crypto';

export class PixInsightBusyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PixInsightBusyError';
  }
}

// Finished jobs kept for job_status after they end.
const KEEP_FINISHED = 20;

/**
 * @param {object} [opts]
 * @param {() => number} [opts.now] - clock (ms since epoch).
 */
export function createJobs({ now = Date.now } = {}) {
  const jobs = new Map(); // id -> job, in start order
  let active = null;
  const using = new Map(); // scope key -> { tool, since }: calls that have sent a command and not returned
  let seq = 0;
  const secs = (ms) => Math.max(0, Math.round(ms / 1000));

  const busyWithJob = (j) => new PixInsightBusyError(
    `PixInsight is busy with job ${j.id} (${j.tool}, started ${secs(now() - j.startedAt)} s ago), so this call was not sent. ` +
    'Calls that use PixInsight are refused until the job ends; job_status reports on it and cancel_job stops it.');

  // A tool call is about to send a PixInsight command. `scope` is the server's call scope
  // ({ key, tool }), undefined outside any tool call. Refused while a job runs.
  function enter(scope) {
    if (active) throw busyWithJob(active);
    if (scope && !using.has(scope.key)) using.set(scope.key, { tool: scope.tool, since: now() });
  }

  // The tool call returned.
  function leave(scope) {
    if (scope) using.delete(scope.key);
  }

  function prune() {
    const finished = [...jobs.values()].filter((j) => j.finishedAt !== null);
    for (const j of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) jobs.delete(j.id);
  }

  function settleResult(job, r) {
    const lines = r?.outputs?.consoleErrors;
    if (Array.isArray(lines)) job.consoleErrors = lines;
    if (r?.status === 'error') {
      const m = r.error?.message ?? JSON.stringify(r.error);
      job.error = m;
      job.state = /MCP_CANCELLED/.test(m) ? 'cancelled' : /MCP_ABORTED/.test(m) ? 'stopped' : 'failed';
    } else {
      job.state = 'done';
      job.result = String(r?.result ?? '');
    }
  }

  function settleError(job, e) {
    const m = e?.message ?? String(e);
    job.error = m;
    if (e?.name === 'JobCancelledError' || /MCP_CANCELLED/.test(m)) job.state = 'cancelled';
    else if (e?.name === 'BridgeAbortError' || /MCP_ABORTED/.test(m)) job.state = 'stopped';
    else job.state = 'failed';
  }

  // Starts `run(hooks)` as a job and returns it at once. `run` sends the one PixInsight command and
  // resolves to its bridge result; it must call hooks.onSent(commandId) once the command is written.
  // `onCancel(commandId)` is how a cancel requested before that point reaches the bridge.
  function start({ tool, run, onCancel = () => {} }) {
    if (active) throw busyWithJob(active);
    const job = {
      id: `job-${++seq}-${crypto.randomUUID().slice(0, 8)}`,
      tool,
      startedAt: now(),
      finishedAt: null,
      state: 'active',
      cmdId: null,
      cancelRequested: false,
      result: null,
      error: null,
      consoleErrors: [],
    };
    jobs.set(job.id, job);
    active = job;
    const hooks = {
      onSent: (cmdId) => {
        job.cmdId = cmdId;
        if (job.cancelRequested) { try { onCancel(cmdId); } catch {} }
      },
    };
    Promise.resolve()
      .then(() => run(hooks))
      .then((r) => settleResult(job, r), (e) => settleError(job, e))
      .finally(() => {
        job.finishedAt = now();
        if (active === job) active = null;
        prune();
      });
    return job;
  }

  return {
    enter,
    leave,
    start,
    get: (id) => jobs.get(id) ?? null,
    active: () => active,
    latest: () => [...jobs.values()].at(-1) ?? null,
    usesPixInsight: (scope) => !!scope && using.has(scope.key),
  };
}
