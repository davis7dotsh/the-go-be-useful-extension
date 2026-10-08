"use strict";
(() => {
  // src/shared/policy.ts
  var COMPOSER_URL = "https://x.com/compose/post";
  var AUTH_PATHS = ["/login", "/i/flow/login", "/i/flow/verify", "/i/flow/two-factor-authentication", "/account/access"];
  var PROFILE_KEY = "profileHandle";
  var RULE_IDS = [1, 2, 3, 4, 5, 6, 7, 8];
  var RESERVED_HANDLES = /* @__PURE__ */ new Set(["home", "explore", "search", "notifications", "messages", "i", "settings", "compose", "login", "logout", "signup", "account", "accounts", "intent", "share", "hashtag", "tos", "privacy", "about", "download", "help", "jobs", "statuses", "profile", "topics", "communities", "bookmarks", "lists", "followers", "following", "status", "likes", "media", "premium"]);
  function normalizeProfileHandle(value) {
    if (typeof value !== "string") return null;
    const handle = value.trim().toLowerCase();
    return /^[a-z0-9_]{1,15}$/.test(handle) && !RESERVED_HANDLES.has(handle) ? handle : null;
  }
  function profileDestination(profileHandle) {
    const handle = normalizeProfileHandle(profileHandle);
    return handle ? `https://x.com/${handle}` : COMPOSER_URL;
  }
  function hostMatches(hostname, domain) {
    return hostname === domain || hostname.endsWith(`.${domain}`);
  }
  function classifyUrl(value, profileHandle) {
    let url;
    try {
      url = new URL(value);
    } catch {
      return { kind: "unrestricted" };
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return { kind: "unrestricted" };
    const hostname = url.hostname.toLowerCase();
    if (hostname === "music.youtube.com") return { kind: "youtube-music" };
    if (hostname === "studio.youtube.com") return { kind: "youtube-studio" };
    if (hostMatches(hostname, "youtube.com")) return { kind: "youtube" };
    if (hostMatches(hostname, "instagram.com")) return { kind: "instagram" };
    if (hostMatches(hostname, "twitter.com")) return { kind: "twitter" };
    if (!hostMatches(hostname, "x.com")) return { kind: "unrestricted" };
    const pathname = url.pathname.replace(/\/$/, "");
    if (hostname === "x.com" || hostname === "www.x.com") {
      if (/^\/compose\/post(?:\/(?:media|tags|alt))?$/.test(pathname)) return { kind: "x-compose" };
      const handle = normalizeProfileHandle(profileHandle);
      if (handle && new RegExp(`^/${handle}(/status/[0-9]+)?$`, "i").test(pathname)) return { kind: "x-profile" };
      if (AUTH_PATHS.some((path) => pathname === path)) return { kind: "x-auth" };
    }
    return { kind: "x-restricted" };
  }
  function destinationForUrl(url, extensionOrigin2, profileHandle) {
    const { kind } = classifyUrl(url, profileHandle);
    if (kind === "youtube" || kind === "instagram") return new URL(`/blocked/index.html?site=${kind}`, extensionOrigin2).href;
    if (kind === "x-restricted" || kind === "twitter") return profileDestination(profileHandle);
    return null;
  }
  function buildNavigationRules(extensionOrigin2, profileHandle) {
    const condition = (regexFilter) => ({ regexFilter, resourceTypes: ["main_frame"] });
    const site = (domain) => `^https?://([^./]+\\.)*${domain.replaceAll(".", "\\.")}(:[0-9]+)?(/|$)`;
    const redirect = (id, domain, url) => ({ id, priority: 10, action: { type: "redirect", redirect: { url } }, condition: condition(site(domain)) });
    const allow = (id, regex) => ({ id, priority: 20, action: { type: "allow" }, condition: condition(regex) });
    const canonicalX = "^https?://(www\\.)?x\\.com(:[0-9]+)?";
    const handle = normalizeProfileHandle(profileHandle);
    return [
      redirect(1, "youtube.com", new URL("/blocked/index.html?site=youtube", extensionOrigin2).href),
      redirect(2, "instagram.com", new URL("/blocked/index.html?site=instagram", extensionOrigin2).href),
      redirect(3, "x.com", profileDestination(handle)),
      redirect(4, "twitter.com", profileDestination(handle)),
      allow(5, "^https?://(studio|music)\\.youtube\\.com(:[0-9]+)?(/|$)"),
      allow(6, `${canonicalX}/compose/post(/(media|tags|alt))?/?([?#]|$)`),
      allow(7, `${canonicalX}(${AUTH_PATHS.join("|")})/?([?#]|$)`),
      ...handle ? [allow(8, `${canonicalX}/${handle}(/status/[0-9]+)?/?([?#]|$)`)] : []
    ];
  }

  // src/shared/state.ts
  var STORAGE_KEY = "focusState";
  var DEFAULT_STATE = { version: 1, enabled: false, endsAt: null };
  function isDuration(value) {
    return value === null || value === 25 || value === 50 || value === 90;
  }
  function isActive(state, now = Date.now()) {
    return state.enabled && (state.endsAt === null || state.endsAt > now);
  }
  function normalizeState(value, now = Date.now()) {
    if (typeof value !== "object" || value === null) return { ...DEFAULT_STATE };
    const record = value;
    if (record.version !== 1 || typeof record.enabled !== "boolean") return { ...DEFAULT_STATE };
    if (record.endsAt !== null && (typeof record.endsAt !== "number" || !Number.isSafeInteger(record.endsAt) || record.endsAt <= 0)) return { ...DEFAULT_STATE };
    const state = { version: 1, enabled: record.enabled, endsAt: record.endsAt };
    return isActive(state, now) ? state : { ...DEFAULT_STATE };
  }
  function createSession(duration, now = Date.now()) {
    return { version: 1, enabled: true, endsAt: duration === null ? null : now + duration * 6e4 };
  }

  // src/shared/messages.ts
  function parseMessage(value) {
    if (typeof value !== "object" || value === null) return null;
    const message = value;
    if (message.type === "focus:get" || message.type === "focus:stop") return { type: message.type };
    if (message.type === "focus:profile") {
      if (message.handle === null) return { type: "focus:profile", handle: null };
      const handle = normalizeProfileHandle(message.handle);
      return handle ? { type: "focus:profile", handle } : null;
    }
    if (message.type === "focus:start" && isDuration(message.duration)) return { type: message.type, duration: message.duration };
    return null;
  }
  function parseGuardAck(value) {
    if (typeof value !== "object" || value === null) return null;
    const response = value;
    if (response.ok !== true || response.guarded !== true || typeof response.hasComposer !== "boolean") return null;
    return { ok: true, guarded: true, hasComposer: response.hasComposer };
  }

  // src/shared/deadline.ts
  function settleWithin(operation, milliseconds) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ status: "timeout" }), milliseconds);
      operation.then((value) => {
        clearTimeout(timer);
        resolve({ status: "resolved", value });
      }, (error) => {
        clearTimeout(timer);
        resolve({ status: "rejected", error });
      });
    });
  }

  // src/platform/chromium.ts
  var GUARD_RESPONSE_TIMEOUT_MS = 750;
  var GUARD_RESPONSE_TIMEOUT = "timeout";
  var EXPIRATION_ALARM = "focus-expiration";
  var MAINTENANCE_ALARM = "focus-maintenance";
  var extensionOrigin = () => chrome.runtime.getURL("/");
  async function relevantTabs() {
    const tabs = await chrome.tabs.query({});
    return tabs.filter((tab) => typeof tab.id === "number" && typeof tab.url === "string" && classifyUrl(tab.url).kind !== "unrestricted");
  }
  async function readProfileHandle() {
    const values = await chrome.storage.local.get(PROFILE_KEY);
    return normalizeProfileHandle(values[PROFILE_KEY]);
  }
  async function sendStateToTab(tabId, state, profileHandle) {
    try {
      const message = { type: "focus:state", state, profileHandle: profileHandle === void 0 ? await readProfileHandle() : profileHandle };
      const response = await settleWithin(chrome.tabs.sendMessage(tabId, message, { frameId: 0 }), GUARD_RESPONSE_TIMEOUT_MS);
      if (response.status === "timeout") return GUARD_RESPONSE_TIMEOUT;
      return response.status === "resolved" ? parseGuardAck(response.value) : null;
    } catch {
      return null;
    }
  }
  async function injectExistingGuards() {
    for (const tab of await relevantTabs()) {
      const kind = classifyUrl(tab.url ?? "").kind;
      if (tab.id === void 0 || kind === "youtube-studio" || kind === "youtube-music") continue;
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/guard.js"] });
      } catch {
      }
    }
  }
  function createChromiumPlatform() {
    return {
      now: Date.now,
      async readState() {
        const values = await chrome.storage.local.get(STORAGE_KEY);
        return values[STORAGE_KEY];
      },
      readProfile: readProfileHandle,
      async writeProfile(handle) {
        await chrome.storage.local.set({ [PROFILE_KEY]: handle });
      },
      async writeState(state) {
        await chrome.storage.local.set({ [STORAGE_KEY]: state });
      },
      async installRules(enabled) {
        const expected = enabled ? buildNavigationRules(extensionOrigin(), await readProfileHandle()) : [];
        const installed = (await chrome.declarativeNetRequest.getDynamicRules()).filter((rule) => RULE_IDS.includes(rule.id));
        const signature = (rule) => JSON.stringify([
          rule.id,
          rule.priority ?? 1,
          rule.action.type,
          rule.action.redirect?.url ?? null,
          rule.condition.regexFilter,
          rule.condition.resourceTypes
        ]);
        if (installed.length === expected.length && expected.every((rule) => installed.some((current) => signature(current) === signature(rule)))) return;
        await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: RULE_IDS, addRules: expected });
      },
      async reconcileAlarm(endsAt, enabled) {
        if (endsAt === null) await chrome.alarms.clear(EXPIRATION_ALARM);
        else {
          const alarm = await chrome.alarms.get(EXPIRATION_ALARM);
          if (!alarm || alarm.scheduledTime !== endsAt) await chrome.alarms.create(EXPIRATION_ALARM, { when: endsAt });
        }
        if (!enabled) {
          await chrome.alarms.clear(MAINTENANCE_ALARM);
          return;
        }
        const maintenance = await chrome.alarms.get(MAINTENANCE_ALARM);
        if (!maintenance) await chrome.alarms.create(MAINTENANCE_ALARM, { periodInMinutes: 1 });
      },
      async notifyTabs(state) {
        const profileHandle = await readProfileHandle();
        await Promise.all((await relevantTabs()).map((tab) => tab.id === void 0 ? void 0 : sendStateToTab(tab.id, state, profileHandle)));
      },
      async reconcileTabs(state, activate) {
        if (!state.enabled) return;
        const profileHandle = await readProfileHandle();
        const results = await Promise.allSettled((await relevantTabs()).map(async (tab) => {
          if (tab.id === void 0 || !tab.url) return;
          const kind = classifyUrl(tab.url, profileHandle).kind;
          if (kind === "x-restricted") {
            const receiver = await sendStateToTab(tab.id, state, profileHandle);
            if (receiver === GUARD_RESPONSE_TIMEOUT || receiver && (!activate || receiver.hasComposer)) return;
          }
          const destination = destinationForUrl(tab.url, extensionOrigin(), profileHandle);
          if (destination) {
            try {
              await chrome.tabs.update(tab.id, { url: destination });
            } catch (error) {
              try {
                await chrome.tabs.get(tab.id);
              } catch {
                return;
              }
              throw error;
            }
          }
        }));
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      },
      async updateBadge(state) {
        await chrome.action.setBadgeText({ text: state.enabled ? "ON" : "" });
        await chrome.action.setBadgeBackgroundColor({ color: "#4DABF7" });
        await chrome.action.setTitle({ title: state.enabled ? "Focus is on" : "Focus" });
      }
    };
  }

  // src/platform/session.ts
  var errorMessage = (error) => error instanceof Error ? error.message : String(error);
  function createSessionController(platform) {
    let state = { ...DEFAULT_STATE };
    let queue = Promise.resolve();
    const serialize = (operation) => {
      const result = queue.then(operation);
      queue = result.catch(() => void 0);
      return result;
    };
    async function apply(next, activate = false, persist = true) {
      await platform.installRules(next.enabled);
      if (persist) await platform.writeState(next);
      await platform.reconcileAlarm(next.enabled ? next.endsAt : null, next.enabled);
      state = next;
      await platform.notifyTabs(next);
      await platform.reconcileTabs(next, activate);
      await platform.updateBadge(next);
    }
    async function reconcile2(refreshTabs = true) {
      try {
        const stored = await platform.readState();
        const next = normalizeState(stored, platform.now());
        const storedRecord = typeof stored === "object" && stored !== null ? stored : {};
        const unchanged = Object.keys(storedRecord).length === 3 && storedRecord.version === next.version && storedRecord.enabled === next.enabled && storedRecord.endsAt === next.endsAt;
        if (refreshTabs || !unchanged) await apply(next, false, !unchanged);
        else {
          await platform.installRules(next.enabled);
          await platform.reconcileAlarm(next.enabled ? next.endsAt : null, next.enabled);
          state = next;
          await platform.updateBadge(next);
        }
        return { ok: true, state: { ...state } };
      } catch (error) {
        return { ok: false, error: `Could not restore Focus: ${errorMessage(error)}. Open Focus and try again.` };
      }
    }
    async function change(next) {
      const previous = normalizeState(await platform.readState(), platform.now());
      try {
        await apply(next, next.enabled);
        return { ok: true, state: { ...state } };
      } catch (error) {
        try {
          await apply(previous);
        } catch (rollbackError) {
          return { ok: false, error: `Focus could not be updated (${errorMessage(error)}); restoration also failed (${errorMessage(rollbackError)}). Retry Stop Focus to clear restrictions.` };
        }
        return { ok: false, error: `Focus could not be updated: ${errorMessage(error)}. The previous session was restored.` };
      }
    }
    async function updateProfile(handle) {
      if (handle !== null && normalizeProfileHandle(handle) !== handle) return { ok: false, error: "Invalid X profile handle." };
      const previous = normalizeProfileHandle(await platform.readProfile());
      const current = normalizeState(await platform.readState(), platform.now());
      if (previous === handle) {
        const result = await reconcile2();
        return result.ok ? { ...result, profileHandle: handle } : result;
      }
      try {
        await platform.writeProfile(handle);
        await apply(current, current.enabled);
        return { ok: true, state: { ...state }, profileHandle: handle };
      } catch (error) {
        try {
          await platform.writeProfile(previous);
          await apply(current);
        } catch (rollbackError) {
          return { ok: false, error: `Could not update your X profile (${errorMessage(error)}); restoration also failed (${errorMessage(rollbackError)}). Open Focus and try again.` };
        }
        return { ok: false, error: `Could not update your X profile: ${errorMessage(error)}. The previous policy was restored.` };
      }
    }
    return {
      updateProfile: (handle) => serialize(async () => {
        try {
          return await updateProfile(handle);
        } catch (error) {
          return { ok: false, error: `Could not discover your X profile: ${errorMessage(error)}` };
        }
      }),
      withState: (operation) => serialize(async () => {
        const current = normalizeState(await platform.readState(), platform.now());
        if (!current.enabled) await apply(current);
        await operation(current);
      }),
      reconcile: () => serialize(() => reconcile2()),
      getState: () => serialize(() => reconcile2(false)),
      start: (duration) => serialize(async () => {
        if (!isDuration(duration)) return { ok: false, error: "Choose Until stopped, 25, 50, or 90 minutes." };
        try {
          return await change(createSession(duration, platform.now()));
        } catch (error) {
          return { ok: false, error: `Could not start Focus: ${errorMessage(error)}` };
        }
      }),
      stop: () => serialize(async () => {
        try {
          return await change({ ...DEFAULT_STATE });
        } catch (error) {
          return { ok: false, error: `Could not stop Focus: ${errorMessage(error)}` };
        }
      })
    };
  }

  // src/background.ts
  var sessions = createSessionController(createChromiumPlatform());
  var reconcile = () => sessions.reconcile().then((result) => {
    if (!result.ok) console.error(result.error);
  });
  chrome.runtime.onMessage.addListener((value, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    const message = parseMessage(value);
    if (!message) {
      if (typeof value === "object" && value !== null && "type" in value && String(value.type).startsWith("focus:")) sendResponse({ ok: false, error: "Invalid Focus request." });
      return false;
    }
    if (message.type === "focus:profile") {
      let trustedXPage = false;
      try {
        const source = new URL(sender.url ?? "");
        trustedXPage = (source.origin === "https://x.com" || source.origin === "https://www.x.com") && sender.tab !== void 0 && (sender.frameId === 0 || sender.frameId === void 0);
      } catch {
      }
      if (!trustedXPage) {
        sendResponse({ ok: false, error: "Only the signed-in X page may report your profile." });
        return false;
      }
      void sessions.updateProfile(message.handle).then(sendResponse);
      return true;
    }
    if (message.type !== "focus:get" && (!sender.url || !sender.url.startsWith(chrome.runtime.getURL("")))) {
      sendResponse({ ok: false, error: "Open the Focus popup to change the session." });
      return false;
    }
    const response = message.type === "focus:get" ? sessions.getState() : message.type === "focus:start" ? sessions.start(message.duration) : sessions.stop();
    void response.then(async (result) => sendResponse(result.ok ? { ...result, profileHandle: await readProfileHandle() } : result)).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "Focus could not process the request." }));
    return true;
  });
  chrome.runtime.onInstalled.addListener(() => {
    void injectExistingGuards().then(reconcile).catch((error) => console.error("Focus installation reconciliation failed", error));
  });
  chrome.runtime.onStartup.addListener(() => {
    void reconcile();
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === EXPIRATION_ALARM || alarm.name === MAINTENANCE_ALARM) void reconcile();
  });
  async function enforceNavigation(details, history) {
    if (details.frameId !== 0 || classifyUrl(details.url).kind === "unrestricted") return;
    await sessions.withState(async (state) => {
      if (!state.enabled) return;
      const profileHandle = await readProfileHandle();
      const kind = classifyUrl(details.url, profileHandle).kind;
      const receiver = await sendStateToTab(details.tabId, state, profileHandle);
      if (receiver === GUARD_RESPONSE_TIMEOUT && kind.startsWith("x-")) return;
      if (receiver && receiver !== GUARD_RESPONSE_TIMEOUT && (kind === "x-compose" || kind === "x-auth" || kind === "x-profile" || kind === "x-restricted") && (history || receiver.hasComposer)) return;
      const destination = destinationForUrl(details.url, chrome.runtime.getURL("/"), profileHandle);
      if (destination) await chrome.tabs.update(details.tabId, { url: destination });
    });
  }
  chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    void enforceNavigation(details, true).catch((error) => console.error("Focus history enforcement failed", error));
  });
  chrome.webNavigation.onCommitted.addListener((details) => {
    void enforceNavigation(details, false).catch((error) => console.error("Focus navigation enforcement failed", error));
  });
  void reconcile();
})();
