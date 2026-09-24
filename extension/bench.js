// Main-thread benchmark of the WASM engine. AudioWorkletGlobalScope has no
// high-resolution timer, so per-block cost is measured here on an identical
// instance of the module. Also a functional sanity check: broadband noise
// (what RNNoise is trained to remove) should be strongly attenuated, a
// voice-like AM buzz should pass nearly unchanged, bypass should be exact.
//
// Classic script (not a module) so both the popup and the test page can use it.
(function () {
  const BLOCK = 128;
  const SR = 48000;

  function makeSignals(blocks) {
    const n = blocks * BLOCK;
    const chord = new Float32Array(n);
    const buzz = new Float32Array(n);
    const noise = new Float32Array(n);
    let seed = 0x9e3779b9;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      noise[i] = ((seed >>> 8) / 16777216 - 0.5) * 0.2;
      chord[i] =
        0.08 *
        (Math.sin(2 * Math.PI * 261.63 * t) +
          Math.sin(2 * Math.PI * 329.63 * t) +
          Math.sin(2 * Math.PI * 392.0 * t) +
          0.5 * Math.sin(2 * Math.PI * 523.25 * t));
      // 120 Hz pulse train (voice-like harmonics) with 3.5 Hz syllabic AM.
      const ph = (t * 120) % 1;
      const pulse = Math.exp(-ph * 30) * 2 - 0.2;
      const am = 0.55 + 0.45 * Math.sin(2 * Math.PI * 3.5 * t);
      buzz[i] = 0.2 * pulse * am;
    }
    return { chord, buzz, noise };
  }

  function energyDb(ex, eng, inPtr, outPtr, signal, skip) {
    let mem = ex.memory.buffer;
    let inV = new Float32Array(mem, inPtr, BLOCK);
    let outV = new Float32Array(mem, outPtr, BLOCK);
    let eIn = 0;
    let eOut = 0;
    const blocks = signal.length / BLOCK;
    for (let b = 0; b < blocks; b++) {
      if (ex.memory.buffer !== mem) {
        mem = ex.memory.buffer;
        inV = new Float32Array(mem, inPtr, BLOCK);
        outV = new Float32Array(mem, outPtr, BLOCK);
      }
      inV.set(signal.subarray(b * BLOCK, (b + 1) * BLOCK));
      ex.nomus_process(eng, 0, inPtr, outPtr, BLOCK);
      if (b >= skip) {
        for (let i = 0; i < BLOCK; i++) {
          eIn += inV[i] * inV[i];
          eOut += outV[i] * outV[i];
        }
      }
    }
    return eIn > 0 ? 10 * Math.log10(eOut / eIn) : 0;
  }

  /**
   * @param {WebAssembly.Module} module compiled nomus module
   * @param {{seconds?: number, channels?: number}} opts
   */
  async function benchEngine(module, opts = {}) {
    const seconds = opts.seconds ?? 5;
    const channels = opts.channels ?? 2;
    const inst = new WebAssembly.Instance(module, {});
    const ex = inst.exports;
    const blocks = Math.floor((seconds * SR) / BLOCK);
    const inPtr = ex.nomus_alloc(BLOCK);
    const outPtr = ex.nomus_alloc(BLOCK);
    const { chord, buzz, noise } = makeSignals(blocks);

    // Timing: rnnoise mode, `channels` channels, same signal on each.
    const eng = ex.nomus_create(channels);
    ex.nomus_set_mode(eng, 1);
    let mem = ex.memory.buffer;
    let inV = new Float32Array(mem, inPtr, BLOCK);
    const t0 = performance.now();
    for (let b = 0; b < blocks; b++) {
      if (ex.memory.buffer !== mem) {
        mem = ex.memory.buffer;
        inV = new Float32Array(mem, inPtr, BLOCK);
      }
      inV.set(chord.subarray(b * BLOCK, (b + 1) * BLOCK));
      for (let c = 0; c < channels; c++) ex.nomus_process(eng, c, inPtr, outPtr, BLOCK);
    }
    const ms = performance.now() - t0;
    ex.nomus_destroy(eng);

    // Optional: the trained model (mode 2).
    let msModel = null;
    if (opts.modelBytes) {
      const u8 = new Uint8Array(opts.modelBytes);
      const mp = ex.nomus_alloc_bytes(u8.length);
      new Uint8Array(ex.memory.buffer, mp, u8.length).set(u8);
      const eng2 = ex.nomus_create(channels);
      const ok = ex.nomus_load_model(eng2, mp, u8.length);
      ex.nomus_free_bytes(mp, u8.length);
      if (ok === 1) {
        ex.nomus_set_mode(eng2, 2);
        mem = ex.memory.buffer;
        inV = new Float32Array(mem, inPtr, BLOCK);
        const t1 = performance.now();
        for (let b = 0; b < blocks; b++) {
          if (ex.memory.buffer !== mem) {
            mem = ex.memory.buffer;
            inV = new Float32Array(mem, inPtr, BLOCK);
          }
          inV.set(chord.subarray(b * BLOCK, (b + 1) * BLOCK));
          for (let c = 0; c < channels; c++) ex.nomus_process(eng2, c, inPtr, outPtr, BLOCK);
        }
        msModel = performance.now() - t1;
      }
      ex.nomus_destroy(eng2);
    }

    // Functional check on channel 0, skipping the first second of warm-up.
    const skip = Math.floor(SR / BLOCK);
    const e1 = ex.nomus_create(1);
    ex.nomus_set_mode(e1, 1);
    const noiseDb = energyDb(ex, e1, inPtr, outPtr, noise, skip);
    ex.nomus_reset(e1);
    const buzzDb = energyDb(ex, e1, inPtr, outPtr, buzz, skip);
    ex.nomus_set_mode(e1, 0);
    const bypassDb = energyDb(ex, e1, inPtr, outPtr, noise, skip);
    ex.nomus_destroy(e1);
    ex.nomus_free(inPtr, BLOCK);
    ex.nomus_free(outPtr, BLOCK);

    const budgetUs = (BLOCK / SR) * 1e6;
    return {
      seconds,
      channels,
      blocks,
      ms,
      usPerBlock: (ms * 1000) / blocks,
      budgetUsPerBlock: budgetUs,
      loadPct: ((ms * 1000) / blocks / budgetUs) * 100,
      rtf: ms / 1000 / seconds,
      modelUsPerBlock: msModel == null ? null : (msModel * 1000) / blocks,
      modelLoadPct: msModel == null ? null : ((msModel * 1000) / blocks / budgetUs) * 100,
      noiseAttenuationDb: noiseDb,
      buzzAttenuationDb: buzzDb,
      bypassAttenuationDb: bypassDb,
      simd: WebAssembly.validate(
        new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])
      ),
    };
  }

  function formatBench(r) {
    const model = r.modelUsPerBlock == null ? "" : `nomus-v1: ${r.modelUsPerBlock.toFixed(1)} µs per block (${r.modelLoadPct.toFixed(2)}%). `;
    return (
      `rnnoise: ${r.usPerBlock.toFixed(1)} µs per 128-sample block for ${r.channels} ch ` +
      `(${r.loadPct.toFixed(2)}% of the ${r.budgetUsPerBlock.toFixed(0)} µs budget, RTF ${r.rtf.toFixed(4)}). ` + model +
      `Noise ${r.noiseAttenuationDb.toFixed(1)} dB, voice-like buzz ${r.buzzAttenuationDb.toFixed(1)} dB, bypass ${r.bypassAttenuationDb.toFixed(2)} dB. ` +
      `SIMD ${r.simd ? "available" : "unavailable"}.`
    );
  }

  const api = { benchEngine, formatBench };
  if (typeof window !== "undefined") window.nomusBench = api;
  if (typeof self !== "undefined") self.nomusBench = api;
})();
