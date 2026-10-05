import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const bundle = await build({ entryPoints: ['src/popup/index.ts'], bundle: true, write: false, format: 'iife', platform: 'browser' });
const script = bundle.outputFiles[0]!.text;
const html = await readFile('src/popup/index.html', 'utf8');
const active = { version: 1, enabled: true, endsAt: null };
const inactive = { version: 1, enabled: false, endsAt: null };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function fixture(saved: unknown = active) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const requests: { message: { type: string }; respond: (value: unknown) => void; reject: (error: unknown) => void }[] = [];
  let storageListener: ((changes: Record<string, { newValue: unknown }>, area: string) => void) | undefined;
  // Accelerate only request deadlines; keep browser intervals untouched.
  const timeout = dom.window.setTimeout.bind(dom.window);
  dom.window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => timeout(handler, Math.min(delay ?? 0, 40), ...args)) as typeof dom.window.setTimeout;
  Object.defineProperty(dom.window, 'chrome', { value: {
    runtime: {
      sendMessage: (message: { type: string }) => new Promise((respond, reject) => requests.push({ message, respond, reject })),
      onMessage: { addListener() {} },
    },
    storage: {
      local: { get: () => Promise.resolve({ focusState: saved }) },
      onChanged: { addListener(listener: typeof storageListener) { storageListener = listener; } },
    },
  } });
  dom.window.eval(script);
  return {
    document: dom.window.document,
    requests,
    toggle: dom.window.document.querySelector<HTMLButtonElement>('#toggle')!,
    retry: dom.window.document.querySelector<HTMLButtonElement>('#retry')!,
    text: () => dom.window.document.querySelector('#session')!.textContent,
    storageChange: (key: string, value: unknown) => storageListener?.({ [key]: { newValue: value } }, 'local'),
    cleanup: () => dom.window.close(),
  };
}

test('reopening a popup with an unresponsive worker still shows the saved session and allows Stop', async () => {
  for (let i = 0; i < 6; i++) {
    const f = fixture();
    try {
      await tick();
      assert.equal(f.text(), 'On');
      assert.equal(f.toggle.disabled, false);
      f.toggle.click();
      assert.equal(f.requests[1]?.message.type, 'focus:stop');
      f.requests[1]!.respond({ ok: true, state: inactive });
      await tick();
      assert.equal(f.text(), 'Off');
      assert.equal(f.toggle.disabled, false);
    } finally { f.cleanup(); }
  }
});

test('late startup read cannot overwrite the result of a Stop request', async () => {
  const f = fixture();
  try {
    await tick();
    f.toggle.click();
    f.requests[1]!.respond({ ok: true, state: inactive });
    await tick();
    f.requests[0]!.respond({ ok: true, state: active });
    await tick();
    assert.equal(f.text(), 'Off');
    assert.equal(f.toggle.getAttribute('aria-checked'), 'false');
  } finally { f.cleanup(); }
});

test('a worker timeout exits Loading and Retry can recover without reopening', async () => {
  const missing = fixture(null);
  try {
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.equal(missing.text(), 'Focus unavailable');
    assert.equal(missing.document.querySelector<HTMLDivElement>('#problem')!.hidden, false);
    assert.equal(missing.retry.disabled, false);
    missing.retry.click();
    missing.requests[1]!.respond({ ok: true, state: active });
    await tick();
    assert.equal(missing.text(), 'On');
    assert.equal(missing.toggle.disabled, false);
    assert.equal(missing.document.querySelector<HTMLDivElement>('#problem')!.hidden, true);
  } finally { missing.cleanup(); }
});

test('only session storage changes update the popup, without requesting tab reconciliation', async () => {
  const f = fixture();
  try {
    f.requests[0]!.respond({ ok: true, state: active });
    await tick();
    f.storageChange('profileHandle', 'other');
    assert.equal(f.requests.length, 1);
    f.storageChange('focusState', inactive);
    assert.equal(f.text(), 'Off');
    assert.equal(f.requests.length, 1);
  } finally { f.cleanup(); }
});

test('mutation timeout unlocks the toggle and late worker rejection is handled', async () => {
  const f = fixture();
  try {
    f.requests[0]!.respond({ ok: true, state: active });
    await tick();
    f.toggle.click();
    assert.equal(f.toggle.disabled, true);
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.equal(f.toggle.disabled, false);
    assert.equal(f.text(), 'On');
    assert.equal(f.document.querySelector<HTMLDivElement>('#problem')!.hidden, false);
    f.requests[1]!.reject(new Error('Popup connection closed'));
    await tick();
    f.toggle.click();
    assert.equal(f.requests[2]?.message.type, 'focus:stop');
    f.requests[2]!.respond({ ok: true, state: inactive });
    await tick();
    assert.equal(f.text(), 'Off');
  } finally { f.cleanup(); }
});
