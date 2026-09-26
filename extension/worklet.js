// nomus AudioWorkletProcessor: hosts the Rust/WASM engine on the audio thread.
//
// The worklet global scope has no fetch/TextDecoder, so the host compiles the
// WebAssembly.Module on the main thread and hands it over in
// `processorOptions.module`; instantiation is synchronous. (Posting a
// WebAssembly.Module through the MessagePort is silently dropped by some
// Chromium builds, so processorOptions is the primary path and an `init`
// message carrying raw bytes is the fallback.) The module has zero imports
// and a flat C ABI, so the hot path per 128-sample block is: copy in, one
// exported call, copy out.

const ABI_VERSION = 2;
const BLOCK = 128;

const now =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now()
    : () => Date.now();
const timerIsCoarse = !(typeof performance !== "undefined" && typeof performance.now === "function");

class NomusProcessor extends AudioWorkletProcessor {
  // ANCHOR: constructor
  constructor(options) {
    super();
    this.channels = Math.max(1, Math.min(8, options?.processorOptions?.channels ?? 2));
    this.mode = options?.processorOptions?.mode ?? 2;
    this.strength = options?.processorOptions?.strength ?? 1.0;
    this.ready = false;
    this.exports = null;
    this.engine = 0;
    this.memBuf = null;
    this.stats = { blocks: 0, busyMs: 0, maxBlockMs: 0, since: now(), underruns: 0 };
    this.processCalls = 0;
    this.lastInputChannels = -1;
    this.lastError = null;
    this.port.onmessage = (e) => this.onMessage(e.data);
    const po = options?.processorOptions || {};
    this.pendingModel = po.modelBytes || null;
    if (po.module) this.init(po.module);
    else if (po.bytes) this.initFromBytes(po.bytes);
  }
  // ANCHOR_END: constructor

  // Copy an NMV1 blob into wasm memory and hand it to the engine.
  loadModel(bytes) {
    if (!this.ready) {
      this.pendingModel = bytes;
      return;
    }
    try {
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const ex = this.exports;
      const ptr = ex.nomus_alloc_bytes(u8.length);
      new Uint8Array(ex.memory.buffer, ptr, u8.length).set(u8);
      const ok = ex.nomus_load_model(this.engine, ptr, u8.length);
      ex.nomus_free_bytes(ptr, u8.length);
      this.refreshViews();
      this.port.postMessage({ type: "model", ok: ok === 1, bytes: u8.length });
    } catch (err) {
      this.port.postMessage({ type: "error", error: `load model: ${String(err && err.message ? err.message : err)}` });
    }
  }

  initFromBytes(bytes) {
    try {
      // Synchronous compile is permitted off the main thread.
      this.init(new WebAssembly.Module(bytes));
    } catch (err) {
      this.port.postMessage({ type: "error", error: `compile failed: ${String(err && err.message ? err.message : err)}` });
    }
  }

  // ANCHOR: on_message
  onMessage(msg) {
    switch (msg?.type) {
      case "init":
        if (this.ready) break;
        if (msg.module) this.init(msg.module);
        else if (msg.bytes) this.initFromBytes(msg.bytes);
        else this.port.postMessage({ type: "error", error: "init without module or bytes" });
        break;
      case "set-mode":
        this.mode = msg.mode | 0;
        if (this.ready) this.exports.nomus_set_mode(this.engine, this.mode);
        break;
      case "set-strength": {
        // NaN would pass through the clamps (and Rust's f32::clamp) into the mix.
        const strength = Number(msg.strength);
        if (!Number.isFinite(strength)) break;
        this.strength = Math.max(0, Math.min(1, strength));
        if (this.ready) this.exports.nomus_set_strength(this.engine, this.strength);
        break;
      }
      case "reset":
        if (this.ready) this.exports.nomus_reset(this.engine);
        break;
      case "load-model":
        this.loadModel(msg.bytes);
        break;
      case "ping":
        this.port.postMessage({
          type: "pong",
          ready: this.ready,
          processCalls: this.processCalls,
          lastInputChannels: this.lastInputChannels,
          lastError: this.lastError || null,
          hasModel: this.ready ? this.exports.nomus_has_model(this.engine) === 1 : false,
        });
        break;
      default:
        break;
    }
  }
  // ANCHOR_END: on_message

  // ANCHOR: init
  init(module) {
    try {
      const instance = new WebAssembly.Instance(module, {});
      const ex = instance.exports;
      const abi = ex.nomus_abi_version();
      if (abi !== ABI_VERSION) {
        this.port.postMessage({ type: "error", error: `ABI mismatch: wasm ${abi}, host ${ABI_VERSION}` });
        return;
      }
      const wantRate = ex.nomus_sample_rate();
      if (sampleRate !== wantRate) {
        // Chrome resamples tab audio to the AudioContext rate; if the host did
        // not request 48 kHz the model will run at the wrong pitch scale.
        this.port.postMessage({
          type: "warning",
          warning: `AudioContext is ${sampleRate} Hz; engine expects ${wantRate} Hz`,
        });
      }
      this.exports = ex;
      this.engine = ex.nomus_create(this.channels);
      this.inPtr = ex.nomus_alloc(BLOCK);
      this.outPtr = ex.nomus_alloc(BLOCK);
      ex.nomus_set_mode(this.engine, this.mode);
      ex.nomus_set_strength(this.engine, this.strength);
      this.refreshViews();
      this.ready = true;
      if (this.pendingModel) {
        const m = this.pendingModel;
        this.pendingModel = null;
        this.loadModel(m);
      }
      const latencySamples = ex.nomus_latency_samples(this.engine);
      this.port.postMessage({
        type: "ready",
        latencySamples,
        latencyMs: (latencySamples / sampleRate) * 1000,
        channels: this.channels,
        sampleRate,
        timerIsCoarse,
      });
    } catch (err) {
      this.port.postMessage({ type: "error", error: String(err && err.message ? err.message : err) });
    }
  }
  // ANCHOR_END: init

  // ANCHOR: refresh
  // WebAssembly.Memory may grow (detaching old views); re-create on change.
  refreshViews() {
    const buf = this.exports.memory.buffer;
    if (buf !== this.memBuf) {
      this.memBuf = buf;
      this.inView = new Float32Array(buf, this.inPtr, BLOCK);
      this.outView = new Float32Array(buf, this.outPtr, BLOCK);
    }
  }
  // ANCHOR_END: refresh

  // ANCHOR: guard
  // An uncaught exception in process() would permanently silence the node,
  // so the real work is wrapped and falls back to passthrough on error.
  process(inputs, outputs) {
    this.processCalls++;
    try {
      return this.render(inputs, outputs);
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      if (this.lastError !== msg) {
        this.lastError = msg;
        this.port.postMessage({ type: "error", error: `process(): ${msg}` });
      }
      const input = inputs[0];
      const output = outputs[0];
      if (input && input.length && output) {
        for (let c = 0; c < output.length; c++) output[c].set(input[Math.min(c, input.length - 1)]);
      }
      return true;
    }
  }
  // ANCHOR_END: guard

  // ANCHOR: render
  render(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    this.lastInputChannels = input ? input.length : 0;

    // No engine yet, or the source produced no audio this quantum: pass
    // through (or emit silence) rather than drop the graph.
    if (!this.ready || !input || input.length === 0) {
      if (input && input.length) {
        for (let c = 0; c < output.length; c++) output[c].set(input[Math.min(c, input.length - 1)]);
      } else {
        this.stats.underruns++;
      }
      return true;
    }

    const t0 = now();
    this.refreshViews();
    const ex = this.exports;
    const engineCh = this.channels;
    for (let c = 0; c < output.length; c++) {
      const src = input[Math.min(c, input.length - 1)];
      const n = src.length;
      if (c < engineCh) {
        if (n === BLOCK) this.inView.set(src);
        else this.inView.set(src.subarray(0, Math.min(n, BLOCK)));
        ex.nomus_process(this.engine, c, this.inPtr, this.outPtr, Math.min(n, BLOCK));
        // The engine may grow linear memory inside the call (first-frame
        // allocations), which detaches the views created above.
        this.refreshViews();
        output[c].set(this.outView.subarray(0, n));
      } else {
        // More output channels than engine channels: mirror the last one.
        output[c].set(output[engineCh - 1]);
      }
    }
    const dt = now() - t0;

    // ANCHOR: stats
    const s = this.stats;
    s.blocks++;
    s.busyMs += dt;
    if (dt > s.maxBlockMs) s.maxBlockMs = dt;
    const elapsed = now() - s.since;
    if (elapsed >= 250) {
      const blockMs = (BLOCK / sampleRate) * 1000;
      this.port.postMessage({
        type: "stats",
        voiceProb: ex.nomus_voice_probability(this.engine),
        framesProcessed: ex.nomus_frames_processed(this.engine),
        // Fraction of the real-time budget spent in the engine. Null when the
        // worklet only has a millisecond clock (use bench.js instead).
        load: timerIsCoarse ? null : s.blocks ? s.busyMs / (s.blocks * blockMs) : 0,
        avgBlockMs: timerIsCoarse ? null : s.blocks ? s.busyMs / s.blocks : 0,
        maxBlockMs: timerIsCoarse ? null : s.maxBlockMs,
        budgetMs: blockMs,
        underruns: s.underruns,
        mode: this.mode,
        strength: this.strength,
        timerIsCoarse,
      });
      s.blocks = 0;
      s.busyMs = 0;
      s.maxBlockMs = 0;
      s.underruns = 0;
      s.since = now();
    }
    // ANCHOR_END: stats
    return true;
  }
  // ANCHOR_END: render
}

registerProcessor("nomus-processor", NomusProcessor);
