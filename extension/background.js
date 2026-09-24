// Service worker: owns the offscreen document (the only context allowed to
// create it) and relays start/stop requests from the popup to it.
//
// Message routing convention: every runtime message carries `target`
// ("background" | "offscreen" | "popup"). Contexts ignore messages not
// addressed to them so only one responder ever calls sendResponse.

const OFFSCREEN_URL = "offscreen.html";

// ANCHOR: offscreen
async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

let creating = null;
async function syncBadge() {
  // A completed start response may belong to an already cancelled attempt.
  // Read current state instead of allowing that old response to change the badge.
  const current = (await hasOffscreenDocument())
    ? await chrome.runtime.sendMessage({ target: "offscreen", type: "get-state" })
    : null;
  const active = !!current?.active;
  const error = !!current?.error;
  await chrome.action.setBadgeText({ text: active ? "ON" : error ? "!" : "" });
  await chrome.action.setBadgeBackgroundColor({ color: error && !active ? "#dc2626" : "#1f9d55" });
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
        justification: "Process captured tab audio through the nomus engine and play it back.",
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
// ANCHOR_END: offscreen
}

// ANCHOR: command
// Keyboard command (Cmd/Ctrl+Shift+Y): toggle filtering on the active tab.
// A command invocation grants activeTab, so getMediaStreamId is allowed here.
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "toggle-filter") return;
  try {
    const target = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!target || /^(chrome|edge|about|devtools):/.test(target.url || "")) return;
    const running = (await hasOffscreenDocument())
      ? await chrome.runtime.sendMessage({ target: "offscreen", type: "get-state" })
      : { active: false };
    if (running && (running.active || running.starting)) {
      await chrome.runtime.sendMessage({ target: "offscreen", type: "stop" });
      await syncBadge();
      return;
    }
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: target.id });
    const prefs = await chrome.storage.local.get(["mode", "strength"]);
    await ensureOffscreenDocument();
    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "start",
      streamId,
      tabId: target.id,
      mode: typeof prefs.mode === "number" ? prefs.mode : 2,
      strength: typeof prefs.strength === "number" ? prefs.strength : 1,
    });
    await syncBadge();
  } catch (err) {
    console.error("toggle-filter failed", err);
    chrome.action.setBadgeText({ text: "!" });
// ANCHOR_END: command
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "background") return false;
  (async () => {
    try {
      switch (msg.type) {
        case "start": {
          await ensureOffscreenDocument();
          const res = await chrome.runtime.sendMessage({
            target: "offscreen",
            type: "start",
            streamId: msg.streamId,
            tabId: msg.tabId,
            mode: msg.mode,
            strength: msg.strength,
          });
          await syncBadge();
          sendResponse(res ?? { ok: false, error: "offscreen did not respond" });
          break;
        }
        case "stop": {
          chrome.action.setBadgeText({ text: "" });
          if (await hasOffscreenDocument()) {
            const res = await chrome.runtime.sendMessage({ target: "offscreen", type: "stop" });
            sendResponse(res ?? { ok: true });
          } else {
            sendResponse({ ok: true, note: "not running" });
          }
          break;
        }
        case "state": {
          if (!(await hasOffscreenDocument())) {
            sendResponse({ ok: true, active: false });
            break;
          }
          const res = await chrome.runtime.sendMessage({ target: "offscreen", type: "get-state" });
          sendResponse(res ?? { ok: true, active: false });
          break;
        }
        default:
          sendResponse({ ok: false, error: `unknown message ${msg.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  })();
  return true; // async response
});
