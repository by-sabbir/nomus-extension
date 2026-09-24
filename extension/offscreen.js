// Offscreen document: the only extension context that may run getUserMedia
// and an AudioContext. Builds the graph
//   tab capture -> AudioWorklet(nomus) -> speakers
// and answers state/control messages from the popup (via background).

const ENGINE_RATE = 48000;

const state = {
  active: false,
  starting: false,
  tabId: null,
  mode: 2, // trained nomus-v1 by default; falls back to passthrough if no model file
  strength: 1.0,
  latencyMs: null,
  engineLatencyMs: null,
  error: null,
  warning: null,
  stats: null,
  startedAt: null,
  hasModel: false,
};

let session = null;
let generation = 0;
let modulePromise = null;
let modelPromise = null;

// Optional trained weights shipped inside the extension. Missing file = no
// voice-mask mode (rnnoise still works).
function loadModelBytes() {
  if (!modelPromise) {
    modelPromise = fetch(chrome.runtime.getURL("pkg/model.nmv"))
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .catch(() => null);
  }
  return modelPromise;
}

function loadModule() {
  if (!modulePromise) {
    modulePromise = fetch(chrome.runtime.getURL("pkg/nomus_wasm.wasm"))
      .then((r) => {
        if (!r.ok) throw new Error(`wasm fetch failed: ${r.status}`);
        return r.arrayBuffer();
      })
      .then((bytes) => WebAssembly.compile(bytes))
      .catch((err) => { modulePromise = null; throw err; });
  }
  return modulePromise;
}

// Each attempt owns its resources. Cancellation invalidates the attempt even
// when getUserMedia/addModule/resume has not settled yet.
function checkCurrent(s) {
  if (session !== s || s.generation !== generation) throw new Error("capture start cancelled");
}

async function dispose(s) {
  if (!s) return;
  if (s.cancelReady) s.cancelReady();
  if (s.node) {
    s.node.port.onmessage = null;
    try { s.node.disconnect(); } catch (_) {}
    s.node = null;
  }
  if (s.source) {
    try { s.source.disconnect(); } catch (_) {}
    s.source = null;
  }
  if (s.stream) {
    for (const track of s.stream.getTracks()) {
      track.onended = null;
      try { track.stop(); } catch (_) {}
    }
    s.stream = null;
  }
  const ctx = s.ctx;
  s.ctx = null;
  if (ctx) { try { await ctx.close(); } catch (_) {} }
}

function clearCaptureState() {
  state.active = false;
  state.starting = false;
  state.tabId = null;
  state.stats = null;
  state.startedAt = null;
  state.latencyMs = state.engineLatencyMs = null;
  state.hasModel = false;
}

// ANCHOR: start
async function start(streamId, tabId, mode, strength) {
  const previous = session;
  const s = { generation: ++generation };
  session = s;
  clearCaptureState();
  state.starting = true;
  state.tabId = tabId;
  state.error = state.warning = null;
  if (typeof mode === "number") state.mode = mode;
  if (typeof strength === "number") state.strength = strength;

  try {
    await dispose(previous);
    checkCurrent(s);
    s.stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
      video: false,
    });
    checkCurrent(s);
    const track = s.stream.getAudioTracks()[0];
    if (track) {
      track.onended = () => { if (session === s) stop(); };
      if (track.readyState === "ended") throw new Error("capture track ended during startup");
    }
    s.ctx = new AudioContext({ sampleRate: ENGINE_RATE, latencyHint: "interactive" });
    await s.ctx.audioWorklet.addModule(chrome.runtime.getURL("worklet.js"));
    checkCurrent(s);
    const module = await loadModule();
    checkCurrent(s);
    const modelBytes = await loadModelBytes();
    checkCurrent(s);
    state.hasModel = !!modelBytes;
    s.source = s.ctx.createMediaStreamSource(s.stream);
    s.node = new AudioWorkletNode(s.ctx, "nomus-processor", {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      processorOptions: { channels: 2, mode: state.mode, strength: state.strength, module, modelBytes },
    });
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        s.cancelReady = null;
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => finish(new Error("engine did not become ready")), 5000);
      s.cancelReady = () => finish(new Error("capture start cancelled"));
      s.node.port.onmessage = (e) => {
        if (session !== s) return;
        const m = e.data;
        switch (m.type) {
          case "ready": state.engineLatencyMs = m.latencyMs; finish(); break;
          case "stats": state.stats = m; break;
          case "warning": state.warning = m.warning; break;
          case "model":
            state.hasModel = m.ok;
            if (!m.ok) state.warning = "model file present but failed to load";
            break;
          case "error": state.error = m.error; finish(new Error(m.error)); break;
        }
      };
    });
    checkCurrent(s);
    // Apply controls that may have changed while the worklet was initializing.
    s.node.port.postMessage({ type: "set-mode", mode: state.mode });
    s.node.port.postMessage({ type: "set-strength", strength: state.strength });
    s.source.connect(s.node);
    s.node.connect(s.ctx.destination);
    if (s.ctx.state !== "running") await s.ctx.resume();
    checkCurrent(s);
    state.active = true;
    state.starting = false;
    state.startedAt = Date.now();
    state.latencyMs = state.engineLatencyMs + ((s.ctx.baseLatency || 0) + (s.ctx.outputLatency || 0)) * 1000;
    return snapshot();
  } catch (err) {
    const error = String(err && err.message ? err.message : err);
    if (session === s) {
      session = null;
      clearCaptureState();
      state.error = error;
    }
    await dispose(s);
    return { ok: false, error };
  }
// ANCHOR_END: start
}

async function stop() {
  ++generation;
  const previous = session;
  session = null;
  clearCaptureState();
  await dispose(previous);
  return snapshot();
}

function snapshot() {
  return { ok: true, ...state };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return false;
  switch (msg.type) {
    case "start":
      start(msg.streamId, msg.tabId, msg.mode, msg.strength).then(sendResponse);
      return true;
    case "stop":
      stop().then((s) => sendResponse(s));
      return true;
    case "set-mode":
      state.mode = msg.mode | 0;
      if (session?.node) session.node.port.postMessage({ type: "set-mode", mode: state.mode });
      sendResponse(snapshot());
      return false;
    case "set-strength":
      state.strength = Math.max(0, Math.min(1, Number(msg.strength)));
      if (session?.node) session.node.port.postMessage({ type: "set-strength", strength: state.strength });
      sendResponse(snapshot());
      return false;
    case "get-state":
      sendResponse(snapshot());
      return false;
    default:
      return false;
  }
});
