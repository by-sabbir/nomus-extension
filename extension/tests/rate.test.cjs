const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function load() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../rate.js'), 'utf8'), sandbox);
  return sandbox.nomusRate;
}

// Minimal chrome.storage.local stand-in.
function storage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) { return Object.fromEntries(keys.filter(k => k in data).map(k => [k, data[k]])); },
    async set(obj) { Object.assign(data, obj); },
  };
}

test('prompt appears only from the tenth session', async () => {
  const rate = load(), st = storage();
  for (let i = 1; i < rate.RATE_AFTER; i++) {
    assert.equal(await rate.recordSession(st), i);
    assert.equal(await rate.shouldPrompt(st), false);
  }
  await rate.recordSession(st);
  assert.equal(await rate.shouldPrompt(st), true);
});

test('dismissing or clicking hides it for good and stops counting', async () => {
  const rate = load(), st = storage({ rateSessions: 12 });
  assert.equal(await rate.shouldPrompt(st), true);
  await rate.markDone(st);
  assert.equal(await rate.shouldPrompt(st), false);
  assert.equal(await rate.recordSession(st), 12);
  assert.equal(st.data.rateSessions, 12);
  assert.equal(await rate.shouldPrompt(st), false);
});

test('a bad stored count starts again from zero', async () => {
  const rate = load(), st = storage({ rateSessions: 'x' });
  assert.equal(await rate.recordSession(st), 1);
});

test('reviews link is the store listing, no other host', () => {
  const url = new URL(load().REVIEWS_URL);
  assert.equal(url.host, 'chromewebstore.google.com');
  assert.match(url.pathname, /enmkngmoakghoclllgkmoehngicaoafn\/reviews$/);
});
