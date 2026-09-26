// "Rate nomus" prompt: local only. The service worker counts started filter
// sessions in chrome.storage.local; the popup shows a small prompt once the
// count reaches RATE_AFTER and hides it for good when the user clicks or
// dismisses it. Nothing is sent anywhere: the link opens a normal tab.
//
// Loaded by background.js (importScripts) and popup.html (<script>).

(function (root) {
  const RATE_AFTER = 10;
  const KEY_COUNT = "rateSessions";
  const KEY_DONE = "rateDone";
  const REVIEWS_URL = "https://chromewebstore.google.com/detail/enmkngmoakghoclllgkmoehngicaoafn/reviews";

  // Called once per successful start. Stops counting after the prompt is done.
  async function recordSession(storage) {
    const s = await storage.get([KEY_COUNT, KEY_DONE]);
    if (s[KEY_DONE]) return s[KEY_COUNT] || 0;
    const count = (Number.isFinite(s[KEY_COUNT]) ? s[KEY_COUNT] : 0) + 1;
    await storage.set({ [KEY_COUNT]: count });
    return count;
  }

  async function shouldPrompt(storage) {
    const s = await storage.get([KEY_COUNT, KEY_DONE]);
    return !s[KEY_DONE] && (s[KEY_COUNT] || 0) >= RATE_AFTER;
  }

  // Clicked or dismissed: never show again.
  function markDone(storage) {
    return storage.set({ [KEY_DONE]: true });
  }

  root.nomusRate = { RATE_AFTER, REVIEWS_URL, recordSession, shouldPrompt, markDone };
})(globalThis);
