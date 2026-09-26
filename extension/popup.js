// Popup: obtains the tab capture stream id (must happen in a user-gesture
// context, which the popup is), asks the background to start the offscreen
// host, and polls it for stats while open.

const $ = (id) => document.getElementById(id);
const els = {
  pill: $("pill"),
  tabTitle: $("tabTitle"),
  start: $("start"),
  stop: $("stop"),
  status: $("status"),
  modeOn: $("modeOn"),
  modeOff: $("modeOff"),
  modeV1: $("modeV1"),
  strength: $("strength"),
  strengthVal: $("strengthVal"),
  voiceBar: $("voiceBar"),
  voiceVal: $("voiceVal"),
  loadBar: $("loadBar"),
  loadVal: $("loadVal"),
  blockVal: $("blockVal"),
  latencyVal: $("latencyVal"),
};

let currentTab = null;
let lastBench = null; // main-thread benchmark result; the worklet cannot time itself
let prefs = { mode: 2, strength: 1.0 }; // default: trained nomus-v1

function setStatus(text, kind = "") {
  els.status.textContent = text || "";
  els.status.className = `status ${kind}`;
}

function bg(msg) {
  return chrome.runtime.sendMessage({ target: "background", ...msg });
}

function offscreen(msg) {
  return chrome.runtime.sendMessage({ target: "offscreen", ...msg }).catch(() => null);
}

function renderMode(mode) {
  els.modeV1.classList.toggle("on", mode === 2);
  els.modeOn.classList.toggle("on", mode === 1);
  els.modeOff.classList.toggle("on", mode === 0);
}

// ANCHOR: render_state
function renderState(s) {
  const active = !!(s && s.active);
  els.pill.textContent = active ? (s.tabId === currentTab?.id ? "filtering this tab" : `filtering tab ${s.tabId}`) : "idle";
  els.pill.classList.toggle("on", active);
  els.start.disabled = !!s?.starting || (active && s.tabId === currentTab?.id);
  els.start.textContent = els.start.disabled ? "Filtering" : "Filter this tab";
  els.stop.disabled = !active && !s?.starting;

  if (s && typeof s.mode === "number") {
    prefs.mode = s.mode;
    renderMode(s.mode);
  }
  if (s && typeof s.strength === "number") {
    prefs.strength = s.strength;
    els.strength.value = Math.round(s.strength * 100);
    els.strengthVal.textContent = `${Math.round(s.strength * 100)}%`;
  }

  if (s && s.error) setStatus(s.error, "err");
  else if (s && s.warning) setStatus(s.warning, "warn");
  else if (active && s.mode === 2 && !s.hasModel) setStatus("No model file (pkg/model.nmv): nomus-v1 mode is passthrough.", "warn");
  else if (active) setStatus("Tab audio is routed through the engine. Toggle Bypass to A/B.");
  els.modeV1.disabled = !!(s && active && !s.hasModel);

  const st = s && s.stats;
  if (active && st) {
    const vp = Math.max(0, Math.min(1, st.voiceProb || 0));
    els.voiceBar.style.width = `${(vp * 100).toFixed(0)}%`;
    els.voiceVal.textContent = st.mode === 0 ? "off" : `${(vp * 100).toFixed(0)}%`;
    // nomus-v1 reports the mean of its mask (how much of the spectrum it lets
    // through), not a voice probability; label it for what it is.
    $("voiceLabel").textContent = st.mode === 2 ? "Passing" : "Voice";
    $("engineVal").textContent = st.mode === 2 ? "nomus-v1 · wasm" : st.mode === 1 ? "rnnoise · wasm" : "bypass";
    if (st.load == null) {
      $("blockRow").classList.add("hidden");
      renderCpu(st.mode);
    } else {
      $("blockRow").classList.remove("hidden");
      const load = Math.max(0, Math.min(1, st.load));
      els.loadBar.style.width = `${(load * 100).toFixed(0)}%`;
      els.loadVal.textContent = `${(load * 100).toFixed(1)}%`;
      els.blockVal.textContent = `${st.avgBlockMs.toFixed(3)} ms avg · ${st.maxBlockMs.toFixed(2)} ms max / ${st.budgetMs.toFixed(2)} ms`;
    }
  } else {
    els.voiceBar.style.width = "0%";
    els.voiceVal.textContent = "–";
    renderCpu(prefs.mode);
    els.blockVal.textContent = "–";
  }
  els.latencyVal.textContent =
    active && s.latencyMs != null
      ? `${s.latencyMs.toFixed(0)} ms total (engine ${s.engineLatencyMs.toFixed(0)} ms)`
      : "–";
}
// ANCHOR_END: render_state

// CPU share for the active mode, from the last main-thread benchmark.
function renderCpu(mode) {
  let pct = null;
  if (lastBench) pct = mode === 2 ? lastBench.modelLoadPct : mode === 1 ? lastBench.loadPct : 0;
  if (pct == null) {
    els.loadBar.style.width = "0%";
    els.loadVal.textContent = "–";
    return;
  }
  els.loadBar.style.width = `${Math.min(100, Math.max(2, pct)).toFixed(0)}%`;
  els.loadVal.textContent = `${pct.toFixed(1)}%`;
}

async function refresh() {
  try {
    const s = await bg({ type: "state" });
    renderState(s);
  } catch (err) {
    renderState({ active: false, error: String(err && err.message ? err.message : err) });
  }
}

// ANCHOR: start
async function start() {
  if (!currentTab) return;
  els.start.disabled = true;
  setStatus("Starting capture…");
  try {
    // Must be called from the popup (user gesture) for the active tab.
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: currentTab.id });
    const res = await bg({ type: "start", streamId, tabId: currentTab.id, mode: prefs.mode, strength: prefs.strength });
    if (!res || !res.ok) throw new Error((res && res.error) || "start failed");
    renderState(res);
    maybeShowRate();
  } catch (err) {
    setStatus(String(err && err.message ? err.message : err), "err");
    els.start.disabled = false;
  }
}
// ANCHOR_END: start

// ANCHOR: stop
async function stop() {
  els.stop.disabled = true;
  await bg({ type: "stop" });
  await refresh();
}
// ANCHOR_END: stop

els.start.addEventListener("click", start);
$("bench").addEventListener("click", async () => {
  const btn = $("bench");
  btn.disabled = true;
  $("benchVal").textContent = "measuring…";
  try {
    const bytes = await fetch(chrome.runtime.getURL("pkg/nomus_wasm.wasm")).then((r) => r.arrayBuffer());
    const module = await WebAssembly.compile(bytes);
    const modelBytes = await fetch(chrome.runtime.getURL("pkg/model.nmv")).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
    const r = await window.nomusBench.benchEngine(module, { seconds: 5, channels: 2, modelBytes });
    lastBench = r;
    const v1 = r.modelLoadPct == null ? "" : `nomus-v1 ${r.modelLoadPct.toFixed(1)}% · `;
    $("benchVal").textContent = `${v1}rnnoise ${r.loadPct.toFixed(1)}% of budget`;
    $("benchVal").title = window.nomusBench.formatBench(r);
    renderCpu(prefs.mode);
  } catch (err) {
    $("benchVal").textContent = `bench failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});
els.stop.addEventListener("click", stop);
els.modeV1.addEventListener("click", () => setMode(2));
els.modeOn.addEventListener("click", () => setMode(1));
els.modeOff.addEventListener("click", () => setMode(0));
els.strength.addEventListener("input", () => {
  const v = Number(els.strength.value) / 100;
  prefs.strength = v;
  els.strengthVal.textContent = `${Math.round(v * 100)}%`;
  chrome.storage.local.set({ strength: v });
  offscreen({ type: "set-strength", strength: v });
});

// ANCHOR: rate
// Local-only "Rate nomus" prompt (rate.js): shown after the tenth started
// session, hidden for good once clicked or dismissed.
async function maybeShowRate() {
  try {
    $("rate").classList.toggle("hidden", !(await window.nomusRate.shouldPrompt(chrome.storage.local)));
  } catch {
    // Storage unavailable: no prompt.
  }
}

async function closeRate(open) {
  $("rate").classList.add("hidden");
  await window.nomusRate.markDone(chrome.storage.local);
  if (open) chrome.tabs.create({ url: window.nomusRate.REVIEWS_URL });
}

$("rateGo").addEventListener("click", () => closeRate(true));
$("rateClose").addEventListener("click", () => closeRate(false));
// ANCHOR_END: rate

function setMode(mode) {
  prefs.mode = mode;
  renderMode(mode);
  chrome.storage.local.set({ mode });
  offscreen({ type: "set-mode", mode });
}

(async function init() {
  const stored = await chrome.storage.local.get(["mode", "strength"]);
  if (typeof stored.mode === "number") prefs.mode = stored.mode;
  if (typeof stored.strength === "number") prefs.strength = stored.strength;
  renderMode(prefs.mode);
  els.strength.value = Math.round(prefs.strength * 100);
  els.strengthVal.textContent = `${Math.round(prefs.strength * 100)}%`;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab || null;
  els.tabTitle.textContent = tab ? tab.title || tab.url : "no active tab";
  if (tab && /^(chrome|edge|about|devtools):/.test(tab.url || "")) {
    setStatus("Browser-internal pages cannot be captured. Open a normal web page.", "warn");
    els.start.disabled = true;
  }
  await refresh();
  maybeShowRate();
  setInterval(refresh, 300);
})();
