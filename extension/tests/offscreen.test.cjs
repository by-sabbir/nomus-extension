const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const tick = () => new Promise(resolve => setImmediate(resolve));
function harness({ autoReady = true, failDisconnect = false } = {}) {
  const pending = [], tracks = [], contexts = [], nodes = [];
  const sandbox = {
    console, setTimeout, clearTimeout, Date,
    chrome: { runtime: { getURL: x => x, onMessage: { addListener() {} } } },
    navigator: { mediaDevices: { getUserMedia: () => new Promise(resolve => pending.push(resolve)) } },
    fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }),
    WebAssembly: { compile: async () => ({}) },
    AudioContext: class {
      constructor() { this.state = 'running'; this.audioWorklet = { addModule: async () => {} }; contexts.push(this); }
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      async close() { this.closed = true; }
    },
    AudioWorkletNode: class {
      constructor() {
        this.port = { postMessage() {} }; nodes.push(this);
        if (autoReady) queueMicrotask(() => this.port.onmessage?.({ data: { type: 'ready', latencyMs: 20 } }));
      }
      connect() {}
      disconnect() { if (failDisconnect) throw new Error('disconnect failed'); }
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../offscreen.js'), 'utf8'), sandbox);
  return {
    run: code => vm.runInContext(code, sandbox), pending, tracks, contexts, nodes,
    grant(index) {
      const track = { readyState: 'live', stop() { this.stopped = true; } };
      tracks.push(track);
      pending[index]({ getAudioTracks: () => [track], getTracks: () => [track] });
      return track;
    },
  };
}

test('stop cancels pending getUserMedia and cleans its late stream', async () => {
  const h = harness(), start = h.run('start("a", 1, 2, 1)');
  await tick(); await h.run('stop()');
  const track = h.grant(0);
  assert.equal((await start).ok, false);
  assert.equal(track.stopped, true);
  assert.equal(h.run('snapshot().active'), false);
  assert.equal(h.contexts.length, 0);
});

test('late earlier start cannot replace or stop a newer session', async () => {
  const h = harness(), a = h.run('start("a", 1, 2, 1)');
  await tick();
  const b = h.run('start("b", 2, 2, 1)');
  await tick();
  const tb = h.grant(1); assert.equal((await b).ok, true);
  const ta = h.grant(0); assert.equal((await a).ok, false);
  assert.equal(ta.stopped, true); assert.equal(tb.stopped, undefined);
  assert.equal(h.run('snapshot().tabId'), 2);
  await h.run('stop()'); assert.equal(tb.stopped, true);
  assert.ok(h.contexts.every(c => c.closed));
});

test('stop while waiting for worklet readiness settles immediately and releases all resources', async () => {
  const h = harness({ autoReady: false, failDisconnect: true });
  const start = h.run('start("a", 1, 2, 1)');
  await tick(); const track = h.grant(0); await tick();
  assert.equal(h.nodes.length, 1);
  await h.run('stop()'); assert.equal((await start).ok, false);
  assert.equal(track.stopped, true); assert.ok(h.contexts[0].closed);
});

test('replacing an active session releases its resources', async () => {
  const h = harness(), a = h.run('start("a", 1, 2, 1)');
  await tick(); const ta = h.grant(0); await a;
  const b = h.run('start("b", 2, 2, 1)');
  await tick(); const tb = h.grant(1); await b;
  assert.equal(ta.stopped, true); assert.equal(tb.stopped, undefined);
  assert.equal(h.contexts[0].closed, true);
  await h.run('stop()');
});
