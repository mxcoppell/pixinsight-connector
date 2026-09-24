// A fake node:net for the launch mutex (src/runtime.mjs createLaunchMutex): servers created from one
// fake share a table of bound ports, and connect() reaches the server bound there. A server with a
// 'connection' listener (a connector's mutex) gets a socket whose end(data) delivers data to the
// client; a port held by holdForeign() behaves like another program: silent (accepts, never
// answers), reset (drops the connection) or garbage (answers something else).
import { EventEmitter } from 'node:events';

export function fakeNet({ failWith = null } = {}) {
  const bound = new Map(); // port -> server
  const binds = [];
  const connects = [];
  const net = {
    bound, binds, connects,
    createServer() {
      const s = new EventEmitter();
      let port = null;
      s.listen = (opts, cb) => {
        binds.push(opts);
        queueMicrotask(() => {
          const code = failWith ?? (bound.has(opts.port) ? 'EADDRINUSE' : null);
          if (code) { s.emit('error', Object.assign(new Error(code), { code })); return; }
          port = opts.port;
          bound.set(port, s);
          cb?.();
        });
        return s;
      };
      s.close = (cb) => { if (bound.get(port) === s) bound.delete(port); port = null; cb?.(); return s; };
      s.unref = () => s;
      return s;
    },
    connect(opts) {
      connects.push(opts);
      const c = new EventEmitter();
      c.destroyed = false;
      c.destroy = () => { c.destroyed = true; return c; };
      c.setEncoding = () => c;
      queueMicrotask(() => {
        const s = bound.get(opts.port);
        if (!s) { c.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })); return; }
        if (s.foreign === 'silent') return;
        if (s.foreign === 'reset') { c.emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' })); return; }
        if (s.foreign === 'garbage') { c.emit('data', Buffer.from('SSH-2.0-OpenSSH\r\n')); return; }
        const peer = new EventEmitter();
        peer.end = (data) => {
          queueMicrotask(() => {
            if (c.destroyed) return;
            if (data != null) c.emit('data', Buffer.from(String(data)));
            c.emit('end');
            c.emit('close');
          });
        };
        peer.destroy = () => peer;
        s.emit('connection', peer);
      });
      return c;
    },
  };
  return net;
}

// Binds `port` in `net` as another program would: mode 'silent', 'reset' or 'garbage'.
export async function holdForeign(net, port, mode = 'silent') {
  const s = net.createServer();
  s.foreign = mode;
  await new Promise((r) => s.listen({ host: '127.0.0.1', port }, r));
  return s;
}
