import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionController, type SessionPlatform } from '../src/platform/session';
import { DEFAULT_STATE, type FocusState } from '../src/shared/state';

function fixture(initial: unknown = DEFAULT_STATE) {
  const data = {
    profile: null as string | null, now: 100_000, stored: structuredClone(initial), rules: false,
    alarm: null as number | null, badge: false, notifications: [] as FocusState[],
    activations: [] as boolean[], steps: [] as string[], failRules: 0, failStorage: 0, failAlarm: 0,
  };
  const platform: SessionPlatform = {
    now: () => data.now,
    async readState() { data.steps.push('read'); return data.stored; },
    async readProfile() { return data.profile; },
    async writeProfile(handle) { data.profile = handle; },
    async writeState(state) {
      data.steps.push('storage');
      if (data.failStorage-- > 0) throw new Error('storage unavailable');
      data.stored = structuredClone(state);
    },
    async installRules(enabled) {
      data.steps.push(`rules:${enabled}`);
      if (data.failRules-- > 0) throw new Error('rule update rejected');
      data.rules = enabled;
    },
    async reconcileAlarm(endsAt) {
      data.steps.push('alarm');
      if (data.failAlarm-- > 0) throw new Error('alarm unavailable');
      data.alarm = endsAt;
    },
    async notifyTabs(state) { data.notifications.push(structuredClone(state)); data.steps.push('notify'); },
    async reconcileTabs(_state, activate) { data.activations.push(activate); data.steps.push('tabs'); },
    async updateBadge(state) { data.badge = state.enabled; data.steps.push('badge'); },
  };
  return { data, platform, controller: createSessionController(platform) };
}

test('first installation defaults off and removes stale restrictions', async () => {
  const { data, controller } = fixture(undefined);
  data.rules = true;
  assert.deepEqual(await controller.reconcile(), { ok: true, state: DEFAULT_STATE });
  assert.equal(data.rules, false);
  assert.equal(data.badge, false);
});
test('restart resumes unexpired state and recreates missing alarm', async () => {
  const saved = { version: 1, enabled: true, endsAt: 200_000 };
  const { data, controller } = fixture(saved);
  assert.deepEqual(await controller.reconcile(), { ok: true, state: saved });
  assert.equal(data.rules, true);
  assert.equal(data.alarm, saved.endsAt);
  assert.equal(data.badge, true);
  assert.deepEqual(data.activations, [false]);
});
test('popup reconciliation clears an expired session even without an alarm', async () => {
  const { data, controller } = fixture({ version: 1, enabled: true, endsAt: 100_000 });
  data.rules = true;
  assert.deepEqual(await controller.getState(), { ok: true, state: DEFAULT_STATE });
  assert.deepEqual(data.stored, DEFAULT_STATE);
  assert.equal(data.rules, false);
  assert.equal(data.alarm, null);
});
test('start installs restrictions before persisting then notifies and reconciles tabs', async () => {
  const { data, controller } = fixture();
  const response = await controller.start(25);
  assert.equal(response.ok, true);
  assert.equal(data.alarm, data.now + 25 * 60_000);
  assert.deepEqual(data.steps, ['read', 'rules:true', 'storage', 'alarm', 'notify', 'tabs', 'badge']);
  assert.deepEqual(data.activations, [true]);
});
test('indefinite session has no expiration and stop removes rules', async () => {
  const { data, controller } = fixture();
  await controller.start(null);
  assert.equal(data.rules, true);
  assert.equal(data.alarm, null);
  await controller.stop();
  assert.deepEqual(data.stored, DEFAULT_STATE);
  assert.equal(data.rules, false);
  assert.equal(data.badge, false);
});
test('rapid start/stop/start operations commit in order', async () => {
  const { data, controller } = fixture();
  const responses = await Promise.all([controller.start(25), controller.stop(), controller.start(90)]);
  assert.ok(responses.every(response => response.ok));
  assert.deepEqual(data.notifications.map(state => state.enabled), [true, false, true]);
  assert.deepEqual(data.stored, { version: 1, enabled: true, endsAt: data.now + 90 * 60_000 });
  assert.equal(data.rules, true);
});
test('failed rule update returns an error and restores off state', async () => {
  const { data, controller } = fixture();
  data.failRules = 1;
  const response = await controller.start(25);
  assert.equal(response.ok, false);
  assert.equal(data.rules, false);
  assert.deepEqual(data.stored, DEFAULT_STATE);
  assert.equal(data.badge, false);
  assert.ok(data.notifications.every(state => !state.enabled));
  assert.equal((await controller.start(50)).ok, true, 'failed request must not poison the queue');
});
test('persistence or alarm failure rolls restrictions back', async () => {
  for (const failure of ['failStorage', 'failAlarm'] as const) {
    const { data, controller } = fixture();
    data[failure] = 1;
    assert.equal((await controller.start(25)).ok, false);
    assert.equal(data.rules, false);
    assert.deepEqual(data.stored, DEFAULT_STATE);
    assert.equal(data.alarm, null);
  }
});
test('failed stop restores the active session and reports failure', async () => {
  const saved = { version: 1, enabled: true, endsAt: 200_000 };
  const { data, controller } = fixture(saved);
  data.failRules = 1;
  assert.equal((await controller.stop()).ok, false);
  assert.deepEqual(data.stored, saved);
  assert.equal(data.rules, true);
  assert.equal(data.alarm, saved.endsAt);
});

test('navigation enforcement shares the mutation queue so stopped sessions stay stopped', async () => {
  const { controller } = fixture();
  await controller.start(null);
  const observations: boolean[] = [];
  await Promise.all([
    controller.withState(async state => { observations.push(state.enabled); }),
    controller.stop(),
    controller.withState(async state => { observations.push(state.enabled); }),
  ]);
  assert.deepEqual(observations, [true, false]);
});

// Exercise the Chromium adapter itself: URL classification alone cannot detect a modal draft.
import { createChromiumPlatform, GUARD_RESPONSE_TIMEOUT, GUARD_RESPONSE_TIMEOUT_MS, sendStateToTab } from '../src/platform/chromium';
import { parseGuardAck } from '../src/shared/messages';

async function reconcileXTab(activate: boolean, acknowledgement: unknown) {
  const previousChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const navigations: string[] = [];
  const mockChrome = {
    runtime: { getURL: (path: string) => `chrome-extension://focus/${path.replace(/^\//, '')}` },
    storage: { local: { get: async () => ({ profileHandle: null }) } },
    tabs: {
      query: async () => [{ id: 1, url: 'https://x.com/home' }],
      sendMessage: async () => acknowledgement,
      update: async (_tabId: number, changes: { url?: string }) => { if (changes.url) navigations.push(changes.url); },
    },
  };
  Object.defineProperty(globalThis, 'chrome', { value: mockChrome, configurable: true });
  try { await createChromiumPlatform().reconcileTabs({ version: 1, enabled: true, endsAt: null }, activate); }
  finally {
    if (previousChrome) Object.defineProperty(globalThis, 'chrome', previousChrome);
    else Reflect.deleteProperty(globalThis, 'chrome');
  }
  return navigations;
}

test('guard acknowledgements require explicit current guard and composer data', () => {
  for (const value of [undefined, true, {}, { ok: true }, { ok: true, guarded: true }, { ok: true, guarded: true, hasComposer: 'yes' }]) assert.equal(parseGuardAck(value), null);
  assert.deepEqual(parseGuardAck({ ok: true, guarded: true, hasComposer: false }), { ok: true, guarded: true, hasComposer: false });
});
test('starting Focus preserves a recognized draft modal even on X home', async () => {
  assert.deepEqual(await reconcileXTab(true, { ok: true, guarded: true, hasComposer: true }), []);
  assert.deepEqual(await reconcileXTab(true, { ok: true, guarded: true, hasComposer: false }), ['https://x.com/compose/post']);
});
test('maintenance preserves covered X pages but redirects unacknowledged guards', async () => {
  assert.deepEqual(await reconcileXTab(false, { ok: true, guarded: true, hasComposer: false }), []);
  assert.deepEqual(await reconcileXTab(false, undefined), ['https://x.com/compose/post']);
});


test('profile discovery is serialized with session changes and does not enable Focus', async () => {
  const { data, controller } = fixture();
  const response = await controller.updateProfile('creator_42');
  assert.equal(response.ok, true);
  assert.equal(data.profile, 'creator_42');
  assert.equal(data.rules, false);
  assert.deepEqual(data.stored, DEFAULT_STATE);
  await Promise.all([controller.start(null), controller.updateProfile('second_account'), controller.stop()]);
  assert.equal(data.profile, 'second_account');
  assert.equal(data.rules, false);
  assert.deepEqual(data.stored, DEFAULT_STATE);
});
test('failed profile rule update restores previous account policy', async () => {
  const { data, controller } = fixture();
  await controller.updateProfile('creator_42');
  await controller.start(null);
  data.failRules = 1;
  assert.equal((await controller.updateProfile('second_account')).ok, false);
  assert.equal(data.profile, 'creator_42');
  assert.equal(data.rules, true);
  assert.equal((await controller.updateProfile('second_account')).ok, true);
  assert.equal(data.profile, 'second_account');
});

test('unchanged profile rediscovery still repairs an expired session', async () => {
  const { data, controller } = fixture({ version: 1, enabled: true, endsAt: 100_000 });
  data.profile = 'creator_42';
  data.rules = true;
  const result = await controller.updateProfile('creator_42');
  assert.equal(result.ok, true);
  assert.equal(data.rules, false);
  assert.deepEqual(data.stored, DEFAULT_STATE);
});


test('reopening the popup reads current state without repeatedly refreshing guarded tabs', async () => {
  const { data, controller } = fixture();
  await controller.start(null);
  const notifications = data.notifications.length;
  const activations = data.activations.length;
  const responses = await Promise.all(Array.from({ length: 6 }, () => controller.getState()));
  assert.ok(responses.every(response => response.ok && response.state.enabled));
  assert.equal(data.notifications.length, notifications);
  assert.equal(data.activations.length, activations);
});

test('a lightweight popup read still removes expired restrictions and updates guarded tabs', async () => {
  const { data, controller } = fixture({ version: 1, enabled: true, endsAt: 100_000 });
  data.rules = true;
  assert.deepEqual(await controller.getState(), { ok: true, state: DEFAULT_STATE });
  assert.deepEqual(data.stored, DEFAULT_STATE);
  assert.equal(data.rules, false);
  assert.equal(data.alarm, null);
  assert.equal(data.badge, false);
  assert.deepEqual(data.notifications, [DEFAULT_STATE]);
  assert.deepEqual(data.activations, [false]);
});

test('explicit maintenance still refreshes guarded tabs when stored state is unchanged', async () => {
  const saved = { version: 1 as const, enabled: true, endsAt: null };
  const { data, controller } = fixture(saved);
  assert.deepEqual(await controller.reconcile(), { ok: true, state: saved });
  assert.deepEqual(data.notifications, [saved]);
  assert.deepEqual(data.activations, [false]);
});

test('a frozen tab receiver is bounded and targets only the top frame', { timeout: 6_000 }, async () => {
  const previousChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const deliveries: unknown[][] = [];
  const mockChrome = {
    runtime: { getURL: (path: string) => `chrome-extension://focus/${path.replace(/^\//, '')}` },
    storage: { local: { get: async () => ({ profileHandle: null }) } },
    tabs: {
      sendMessage: (...args: unknown[]) => { deliveries.push(args); return new Promise<unknown>(() => {}); },
    },
  };
  Object.defineProperty(globalThis, 'chrome', { value: mockChrome, configurable: true });
  const started = Date.now();
  try {
    assert.equal(await sendStateToTab(42, DEFAULT_STATE, null), GUARD_RESPONSE_TIMEOUT);
    assert.deepEqual(deliveries.map(args => [args[0], args[2]]), [[42, { frameId: 0 }]]);
    assert.ok(Date.now() - started < GUARD_RESPONSE_TIMEOUT_MS + 1_000, 'an absent acknowledgement must not hang a state request');
  } finally {
    if (previousChrome) Object.defineProperty(globalThis, 'chrome', previousChrome);
    else Reflect.deleteProperty(globalThis, 'chrome');
  }
});

test('a frozen broadcast receiver cannot strand later stop and popup reads', { timeout: 6_000 }, async () => {
  const previousChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const mockChrome = {
    runtime: { getURL: (path: string) => `chrome-extension://focus/${path.replace(/^\//, '')}` },
    storage: { local: { get: async () => ({ profileHandle: null }) } },
    tabs: {
      query: async () => [{ id: 42, url: 'https://x.com/compose/post' }],
      sendMessage: () => new Promise<unknown>(() => {}),
    },
  };
  Object.defineProperty(globalThis, 'chrome', { value: mockChrome, configurable: true });
  try {
    const { data, platform, controller } = fixture();
    platform.notifyTabs = createChromiumPlatform().notifyTabs;
    const responses = await Promise.all([controller.start(null), controller.stop(), controller.getState()]);
    assert.ok(responses.every(response => response.ok));
    assert.deepEqual(responses[2], { ok: true, state: DEFAULT_STATE });
    assert.deepEqual(data.stored, DEFAULT_STATE);
    assert.equal(data.rules, false);
  } finally {
    if (previousChrome) Object.defineProperty(globalThis, 'chrome', previousChrome);
    else Reflect.deleteProperty(globalThis, 'chrome');
  }
});


test('a timed-out guard never reloads an X draft during activation or maintenance', { timeout: 6_000 }, async () => {
  const previousChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const navigations: string[] = [];
  const mockChrome = {
    runtime: { getURL: (path: string) => `chrome-extension://focus/${path.replace(/^\//, '')}` },
    storage: { local: { get: async () => ({ profileHandle: null }) } },
    tabs: {
      query: async () => [{ id: 42, url: 'https://x.com/home' }],
      sendMessage: () => new Promise<unknown>(() => {}),
      update: async (_tabId: number, changes: { url?: string }) => { if (changes.url) navigations.push(changes.url); },
    },
  };
  Object.defineProperty(globalThis, 'chrome', { value: mockChrome, configurable: true });
  try {
    const platform = createChromiumPlatform();
    const active = { version: 1 as const, enabled: true, endsAt: null };
    await platform.reconcileTabs(active, true);
    await platform.reconcileTabs(active, false);
    assert.deepEqual(navigations, [], 'a timeout cannot establish that no native composer exists');
  } finally {
    if (previousChrome) Object.defineProperty(globalThis, 'chrome', previousChrome);
    else Reflect.deleteProperty(globalThis, 'chrome');
  }
});
