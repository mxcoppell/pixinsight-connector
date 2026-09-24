// The machine id (src/machine-id.mjs): this machine's name for its subdir of a target's bridge dir,
// `<state>/bridge/<machine-id>/`, so two machines using one target on network storage never share
// commands, heartbeats or launch tickets. Derived from the hostname every time; no file anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { machineId, MACHINE_ID_PATTERN } from '../src/machine-id.mjs';

const hash8 = (h) => createHash('sha256').update(h, 'utf8').digest('hex').slice(0, 8);

test('the id is the sanitized full hostname, then 8 hex digits of sha256 of the raw hostname', () => {
  assert.equal(machineId({ hostname: () => 'ASTRO-PC' }), `astro-pc-${hash8('ASTRO-PC')}`);
  assert.equal(machineId({ hostname: () => 'nas-client.example.org' }), `nas-client-example-o-${hash8('nas-client.example.org')}`); // prefix: 20 chars
  assert.match(machineId({ hostname: () => 'Min’s MacBook Pro.local' }), /^min-s-macbook-pro-lo-[0-9a-f]{8}$/);
});

test('it is stable: the same hostname always gives the same id', () => {
  assert.equal(machineId({ hostname: () => 'rig' }), machineId({ hostname: () => 'rig' }));
  assert.equal(machineId({ hostname: () => 'rig' }), `rig-${hash8('rig')}`);
});

test('hostnames that sanitize alike never share an id: same first label, same truncated prefix, all non-ASCII', () => {
  const pairs = [
    ['rig.north.example.com', 'rig.south.example.com'],
    ['astro-imaging-rig-observatory-north', 'astro-imaging-rig-observatory-south'],
    ['天文台', '星空'],
    ['Rig', 'rig'],
    ['rig_1', 'rig-1'],
  ];
  for (const [a, b] of pairs) {
    const ia = machineId({ hostname: () => a });
    const ib = machineId({ hostname: () => b });
    assert.notEqual(ia, ib, `${a} vs ${b}`);
    assert.match(ia, MACHINE_ID_PATTERN, ia);
    assert.match(ib, MACHINE_ID_PATTERN, ib);
  }
  assert.match(machineId({ hostname: () => '天文台' }), /^host-[0-9a-f]{8}$/);
});

test('an empty, odd or failing hostname still gives a filesystem-safe id', () => {
  for (const h of ['', '...', '日本語', 'a'.repeat(200), 'CON', '-x-', null]) {
    const id = machineId({ hostname: () => h });
    assert.match(id, MACHINE_ID_PATTERN, `hostname ${JSON.stringify(h)} -> ${id}`);
    assert.ok(id.length <= 32, id);
  }
  assert.match(machineId({ hostname: () => { throw new Error('no hostname'); } }), /^host-[0-9a-f]{8}$/);
});

test('a Windows reserved device name is never the whole id (a folder named CON cannot be created there)', () => {
  for (const h of ['CON', 'prn', 'Aux', 'NUL', 'com1', 'LPT9']) {
    assert.equal(machineId({ hostname: () => h }), `${h.toLowerCase()}-${hash8(h)}`);
  }
});

test('nothing is read or written: the id needs no file', () => {
  const spy = ['writeFileSync', 'mkdirSync', 'readFileSync', 'linkSync'].map((m) => [m, fs[m]]);
  let touched = 0;
  for (const [m] of spy) fs[m] = () => { touched++; throw new Error(`unexpected ${m}`); };
  try {
    machineId({ hostname: () => 'rig' });
  } finally {
    for (const [m, f] of spy) fs[m] = f;
  }
  assert.equal(touched, 0);
});
