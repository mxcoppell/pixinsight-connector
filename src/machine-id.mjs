// ============================================================================
// This machine's id: the name of its subdir of a target's bridge dir,
// `<state>/bridge/<machine-id>/`.
//
// A target folder can sit on network storage and be used from two machines at
// once, each with its own PixInsight and watcher. Each machine therefore keeps
// its commands, results, heartbeat, launch lock and linger tickets in its own
// subdir, and its watcher, which serves only that subdir, never sees the other
// machine's commands.
//
// Derived from the hostname every time: no file, nothing outside the target.
// The id is a readable prefix (the full hostname lowercased, every run of
// characters other than a-z/0-9 turned into "-", at most 20 characters, "host"
// when nothing is left) followed by "-" and the first 8 hex digits of the
// sha256 of the raw hostname. The hash keeps apart hostnames the prefix alone
// would merge: rig.north / rig.south, two long names cut to one prefix, any
// two all-non-ASCII names, "Rig" / "rig". Only two machines with identical
// hostnames working in one target at once would share a subdir; that is not
// supported. The suffix also means no id is ever a Windows reserved name (CON).
// ============================================================================
import os from 'node:os';
import { createHash } from 'node:crypto';

export const MACHINE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PREFIX_MAX = 20;

// machineId({ hostname? }) -> this machine's id. Pure: reads nothing, writes nothing.
export function machineId({ hostname = os.hostname } = {}) {
  let h = '';
  try { h = String(hostname() ?? ''); } catch {}
  const prefix = h.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '')
    .slice(0, PREFIX_MAX).replace(/-+$/, '') || 'host';
  const hash = createHash('sha256').update(h, 'utf8').digest('hex').slice(0, 8);
  return `${prefix}-${hash}`;
}
