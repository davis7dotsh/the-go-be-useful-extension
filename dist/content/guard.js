"use strict";
(() => {
  // src/shared/policy.ts
  var COMPOSER_URL = "https://x.com/compose/post";
  var AUTH_PATHS = ["/login", "/i/flow/login", "/i/flow/verify", "/i/flow/two-factor-authentication", "/account/access"];
  var PROFILE_KEY = "profileHandle";
  var RESERVED_HANDLES = /* @__PURE__ */ new Set(["home", "explore", "search", "notifications", "messages", "i", "settings", "compose", "login", "logout", "signup", "account", "accounts", "intent", "share", "hashtag", "tos", "privacy", "about", "download", "help", "jobs", "statuses", "profile", "topics", "communities", "bookmarks", "lists", "followers", "following", "status", "likes", "media", "premium"]);
  function normalizeProfileHandle(value) {
    if (typeof value !== "string") return null;
    const handle = value.trim().toLowerCase();
    return /^[a-z0-9_]{1,15}$/.test(handle) && !RESERVED_HANDLES.has(handle) ? handle : null;
  }
  function hostMatches(hostname, domain) {
    return hostname === domain || hostname.endsWith(`.${domain}`);
  }
  function isXHost(hostname) {
    return hostMatches(hostname.toLowerCase(), "x.com") || hostMatches(hostname.toLowerCase(), "twitter.com");
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

  // src/shared/state.ts
  var STORAGE_KEY = "focusState";
  var DEFAULT_STATE = { version: 1, enabled: false, endsAt: null };
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

  // src/content/x.css
  var x_default = '@font-face { font-family: "Focus Geist"; src: url("__FOCUS_FONT_URL__") format("woff2"); font-weight: 100 900; font-style: normal; font-display: swap; }\nhtml[data-focus-active] body { visibility: hidden !important; background: transparent !important; position: relative !important; z-index: 2147483645 !important; }\nhtml[data-focus-active] body * { visibility: hidden !important; pointer-events: none !important; }\nhtml[data-focus-active] body [data-focus-allowed],\nhtml[data-focus-active] body [data-focus-allowed] * { visibility: visible !important; pointer-events: auto !important; }\nhtml[data-focus-active] body [data-focus-denied],\nhtml[data-focus-active] body [data-focus-denied] * { visibility: hidden !important; pointer-events: none !important; }\n#focus-cover { all: initial; display: flex !important; position: fixed !important; inset: 0 !important; z-index: 2147483644 !important; align-items: center !important; justify-content: center !important; background: #111113 !important; color: #ededed !important; font: 16px/1.5 "Focus Geist", system-ui, sans-serif !important; }\n#focus-cover * { box-sizing: border-box; }\n#focus-cover [hidden] { display: none !important; }\n#focus-cover .focus-panel { width: min(420px, calc(100vw - 48px)); text-align: center; }\n#focus-cover h1 { color: #ededed; font: 600 26px/1.25 "Focus Geist", system-ui, sans-serif; margin: 0 0 16px; }\n#focus-cover p { color: #939398; font: 400 16px/1.5 "Focus Geist", system-ui, sans-serif; margin: 0 0 24px; }\n#focus-cover button { border: 0; background: #4DABF7; color: #111; border-radius: 8px; padding: 12px 20px; font: 600 15px/1.2 "Focus Geist", system-ui, sans-serif; cursor: pointer; }\n#focus-cover button:focus-visible { outline: 2px solid #4DABF7; outline-offset: 4px; }\n#focus-cover button:disabled { opacity: .6; cursor: default; }\n\n#focus-compose-control { position: fixed !important; bottom: 24px !important; right: 24px !important; z-index: 2147483647 !important; padding: 12px 20px !important; border: 0 !important; border-radius: 8px !important; background: #4DABF7 !important; color: #111 !important; font: 600 15px/1.2 "Focus Geist", system-ui, sans-serif !important; cursor: pointer !important; }\n#focus-compose-control[hidden] { display: none !important; }\n';

  // src/content/x.ts
  var PageShield = class {
    style = document.createElement("style");
    cover = document.createElement("div");
    composeControl = document.createElement("button");
    composeAction = null;
    panel = document.createElement("div");
    title = document.createElement("h1");
    message = document.createElement("p");
    action = document.createElement("button");
    marked = /* @__PURE__ */ new Set();
    inert = /* @__PURE__ */ new Map();
    roots = [];
    enabled = false;
    profileHandle = null;
    nativeCompose = null;
    onAction = null;
    onKey = (event) => {
      const target = event.target;
      if (!(target instanceof Node) || this.cover.contains(target) || this.composeControl.contains(target)) return;
      if (!this.roots.some((root) => root.contains(target))) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.key === "Tab") this.action.focus();
        return;
      }
      const editable = target instanceof Element && target.closest('input, textarea, [contenteditable="true"], [role="textbox"]');
      if (!editable && event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    onPointer = (event) => {
      const target = event.target;
      if (!(target instanceof Node) || this.cover.contains(target) || this.composeControl.contains(target)) return;
      if (event.type === "click" && target instanceof Element && target === this.nativeCompose) return;
      if (!this.roots.some((root) => root.contains(target))) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (event.type !== "click" || !(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const kind = classifyUrl(anchor.href).kind;
      const composerTool = anchor.origin === location.origin && /^\/compose\/post\/(?:media|tags)\/?$/.test(anchor.pathname);
      const ownProfile = this.profileHandle && classifyUrl(anchor.href, this.profileHandle).kind === "x-profile";
      if (kind !== "x-auth" && kind !== "x-compose" && !composerTool && !ownProfile) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    constructor() {
      this.style.textContent = x_default.replace("__FOCUS_FONT_URL__", chrome.runtime.getURL("assets/Geist.woff2"));
      this.cover.id = "focus-cover";
      this.composeControl.id = "focus-compose-control";
      this.composeControl.textContent = "Compose";
      this.composeControl.type = "button";
      this.composeControl.hidden = true;
      this.composeControl.addEventListener("click", () => this.composeAction?.());
      this.cover.setAttribute("role", "region");
      this.cover.setAttribute("aria-label", "Focus");
      this.panel.className = "focus-panel";
      this.action.type = "button";
      this.action.addEventListener("click", () => this.onAction?.());
      this.panel.append(this.title, this.message, this.action);
      this.cover.append(this.panel);
      this.enable();
      this.show("loading");
    }
    enable() {
      if (this.enabled) return;
      this.enabled = true;
      document.documentElement.setAttribute("data-focus-active", "");
      document.documentElement.append(this.style, this.cover, this.composeControl);
      document.addEventListener("keydown", this.onKey, true);
      for (const type of ["pointerdown", "mousedown", "click", "touchstart"]) document.addEventListener(type, this.onPointer, true);
    }
    clickNativeCompose(anchor) {
      this.nativeCompose = anchor;
      try {
        anchor.click();
      } finally {
        this.nativeCompose = null;
      }
    }
    setProfile(handle, action) {
      this.profileHandle = handle;
      this.composeControl.hidden = !action;
      this.composeAction = action ?? null;
    }
    restoreIsolation() {
      for (const node of this.marked) {
        node.removeAttribute("data-focus-allowed");
        node.removeAttribute("data-focus-path");
        node.removeAttribute("data-focus-denied");
      }
      this.marked.clear();
      for (const [node, prior] of this.inert) node.inert = prior;
      this.inert.clear();
      this.roots = [];
    }
    allow(roots, denied = []) {
      this.enable();
      this.restoreIsolation();
      this.roots = roots.filter((root) => root.isConnected);
      const paths = /* @__PURE__ */ new Set();
      for (const root of this.roots) {
        root.setAttribute("data-focus-allowed", "");
        this.marked.add(root);
        let ancestor = root.parentElement;
        while (ancestor && ancestor !== document.documentElement) {
          paths.add(ancestor);
          ancestor.setAttribute("data-focus-path", "");
          this.marked.add(ancestor);
          ancestor = ancestor.parentElement;
        }
      }
      const isolate = (node) => {
        if (this.roots.includes(node)) return;
        if (paths.has(node)) {
          for (const child of Array.from(node.children)) if (child instanceof HTMLElement) isolate(child);
        } else {
          this.inert.set(node, node.inert);
          node.inert = true;
        }
      };
      if (document.body) isolate(document.body);
      for (const node of denied) {
        this.inert.set(node, node.inert);
        node.inert = true;
        node.setAttribute("data-focus-denied", "");
        this.marked.add(node);
      }
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && !this.roots.some((root) => root.contains(focused)) && !this.cover.contains(focused)) focused.blur();
    }
    show(phase, onAction, retryAllowed = true) {
      this.cover.dataset.phase = phase;
      const safe = phase === "composing" || phase === "authentication";
      this.panel.hidden = safe || phase === "inactive";
      this.title.textContent = phase === "loading" ? "Loading Focus\u2026" : phase === "error" ? "Composer unavailable" : "Focus is on.";
      this.message.textContent = phase === "error" ? "X\u2019s composer could not be recognized. The page stays covered." : phase === "restricted" ? "Ready when you have something to post." : "Your page is protected while Focus checks its state.";
      this.action.hidden = !onAction;
      this.action.disabled = false;
      this.action.textContent = phase === "error" ? retryAllowed ? "Retry composer" : "Reload to retry" : "Compose another";
      this.onAction = onAction ?? null;
    }
    disable() {
      if (!this.enabled) return;
      this.enabled = false;
      this.restoreIsolation();
      document.documentElement.removeAttribute("data-focus-active");
      this.style.remove();
      this.cover.remove();
      this.composeControl.remove();
      document.removeEventListener("keydown", this.onKey, true);
      for (const type of ["pointerdown", "mousedown", "click", "touchstart"]) document.removeEventListener(type, this.onPointer, true);
    }
  };
  function visible(element) {
    return !element.hidden && element.getAttribute("aria-hidden") !== "true" && !element.closest('[hidden], [aria-hidden="true"]');
  }
  function findComposer() {
    const editors = document.querySelectorAll('[data-testid="tweetTextarea_0"][contenteditable="true"], [data-testid="tweetTextarea_0"][role="textbox"]');
    for (const editor of editors) {
      const dialog = editor.closest('[role="dialog"]');
      if (dialog && visible(dialog) && dialog.querySelector('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]') && dialog.querySelector('input[data-testid="fileInput"]')) return dialog;
      if (dialog || !visible(editor)) continue;
      let candidate = editor.parentElement;
      while (candidate && candidate !== document.body) {
        if (candidate.matches('main, [data-testid="primaryColumn"]')) break;
        if (candidate.querySelector('[data-testid="tweet"], nav, aside, [role="navigation"]')) break;
        if (candidate.querySelector('[data-testid="tweetButtonInline"]') && candidate.querySelector('input[data-testid="fileInput"]')) return candidate;
        candidate = candidate.parentElement;
      }
    }
    return null;
  }
  function authenticationRoots() {
    if (classifyUrl(location.href).kind !== "x-auth") return [];
    const credentials = document.querySelectorAll('input[autocomplete="username"], input[type="password"], input[autocomplete="one-time-code"], input[name="verification_code"], input[name="challenge_response"]');
    const roots = /* @__PURE__ */ new Set();
    for (const input of credentials) {
      const root = input.closest('[role="dialog"], form') ?? input.closest("main");
      if (root && visible(root) && !root.querySelector('[data-testid="tweet"]')) roots.add(root);
    }
    return [...roots];
  }
  function composerSubdialogs(composer) {
    const allowed = [];
    for (const dialog of document.querySelectorAll('[role="dialog"], [role="menu"], [data-testid="emojiPicker"]')) {
      if (dialog === composer || composer?.contains(dialog) || !visible(dialog)) continue;
      const label = dialog.getAttribute("aria-label") ?? "";
      const text = dialog.textContent ?? "";
      const buttons = Array.from(dialog.querySelectorAll('button, [role="button"]'));
      const hasButton = (pattern) => buttons.some((button) => pattern.test(button.getAttribute("aria-label") ?? button.textContent ?? ""));
      const inspectedMedia = /^\/compose\/post\/media\/?$/.test(location.pathname) && !!dialog.querySelector('[data-testid="endEditingButton"]') && /Crop media/i.test(text) && !!dialog.querySelector('[role="slider"], [role="tablist"]');
      const inspectedTags = /^\/compose\/post\/tags\/?$/.test(location.pathname) && /Tag people/i.test(text) && !!dialog.querySelector("input") && hasButton(/^(?:done|save)$/i);
      const mediaEdit = /(?:edit|crop) (?:image|media|photo)|image editor/i.test(label) && !!dialog.querySelector("img, canvas, video") && hasButton(/^(?:save|apply|done)$/i);
      const audience = /(?:choose audience|who can reply|post audience|everyone can reply)/i.test(`${label} ${text}`) && !!dialog.querySelector('[role="radio"], [role="option"], input[type="radio"]');
      const discard = /(?:discard (?:post|draft)|save (?:post|draft))/i.test(text) && hasButton(/^discard$/i) && hasButton(/^(?:save|cancel|keep editing)$/i);
      const schedule = /schedule/i.test(label) && !!dialog.querySelector('input, select, [role="combobox"]') && hasButton(/^(?:confirm|schedule|done)$/i);
      const emoji = dialog.matches('[data-testid="emojiPicker"]') && !!dialog.querySelector('button, [role="button"]') && !!dialog.querySelector('input[type="search"], input[placeholder*="Search"], [role="tablist"]');
      const gif = /(?:choose a gif|search gifs|gif search)/i.test(label) && !!dialog.querySelector("input") && !!dialog.querySelector('img, [role="listbox"]');
      if (inspectedMedia || inspectedTags || mediaEdit || audience || discard || schedule || emoji || gif) allowed.push(dialog);
    }
    if (composer) {
      for (const item of document.querySelectorAll('button, [role="button"], [role="menuitem"]')) {
        if (composer.contains(item) || !visible(item) || (item.textContent ?? "").trim() !== "Upload") continue;
        let parent = item.parentElement;
        for (let depth = 0; parent && depth < 5; depth++, parent = parent.parentElement) {
          if (parent === document.body || parent === document.documentElement || parent.contains(composer)) break;
          const text = (parent.textContent ?? "").trim();
          const choices = Array.from(parent.querySelectorAll('button, [role="button"], [role="menuitem"]'));
          const labels = choices.map((choice) => (choice.textContent ?? "").trim());
          if (text.length < 120 && choices.length === 2 && labels.includes("Upload") && labels.includes("Generate with Grok")) {
            allowed.push(item);
            break;
          }
          if (parent.matches('[role="menu"], [role="dialog"], [data-testid="Dropdown"]')) break;
        }
      }
    }
    return allowed.filter((root) => !allowed.some((other) => other !== root && root.contains(other)));
  }
  var XGuard = class {
    constructor(shield, profile = () => null, onProfile = () => {
    }) {
      this.shield = shield;
      this.profile = profile;
      this.onProfile = onProfile;
      this.observer = new MutationObserver((records) => {
        if (records.some((record) => !(record.target instanceof Element && (record.target.closest("#focus-cover") || record.target.closest("#focus-compose-control"))))) this.schedule();
      });
      this.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["role", "data-testid", "aria-label", "aria-hidden", "hidden"] });
      window.addEventListener("popstate", this.onPage);
      window.addEventListener("hashchange", this.onPage);
      window.addEventListener("pageshow", this.onPage);
      this.refresh();
    }
    shield;
    profile;
    onProfile;
    observer;
    timer = null;
    queued = false;
    active = true;
    seenComposer = false;
    phase = "loading";
    retries = 0;
    loadingSince = Date.now();
    reportedProfile = null;
    onPage = () => this.refresh();
    hasComposer() {
      return !!findComposer() || /^\/compose\/post(?:\/(?:media|tags))?\/?$/.test(location.pathname) && composerSubdialogs(null).length > 0;
    }
    schedule() {
      if (this.queued || !this.active) return;
      this.queued = true;
      queueMicrotask(() => {
        this.queued = false;
        if (this.active) this.refresh();
      });
    }
    compose = () => {
      location.assign(COMPOSER_URL);
    };
    retry = () => {
      if (this.retries >= 3) return;
      this.retries++;
      this.loadingSince = Date.now();
      this.phase = "loading";
      this.refresh();
      if (!this.hasComposer() && classifyUrl(location.href).kind !== "x-compose") this.compose();
    };
    refresh() {
      if (!this.active) return;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      const profileLink = document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
      const handle = profileLink ? normalizeProfileHandle(new URL(profileLink.href).pathname.slice(1)) : null;
      if (handle && handle !== this.reportedProfile) {
        this.reportedProfile = handle;
        this.onProfile(handle);
      }
      this.shield.setProfile(this.profile());
      const composer = findComposer();
      const subdialogs = composerSubdialogs(composer);
      const auth = authenticationRoots();
      if (composer) {
        this.seenComposer = true;
        this.phase = "composing";
        this.shield.allow([composer, ...subdialogs]);
        this.shield.show(this.phase);
        return;
      }
      if ((this.seenComposer || /^\/compose\/post(?:\/(?:media|tags))?\/?$/.test(location.pathname)) && subdialogs.length) {
        this.phase = "composing";
        this.shield.allow(subdialogs);
        this.shield.show(this.phase);
        return;
      }
      if (auth.length) {
        this.phase = "authentication";
        this.shield.allow(auth);
        this.shield.show(this.phase);
        return;
      }
      const kind = classifyUrl(location.href, this.profile()).kind;
      if (kind === "x-profile" && this.profile()) {
        const primary = document.querySelector('[data-testid="primaryColumn"]');
        const ownHandle = new RegExp(`@${this.profile()}(?![a-z0-9_])`, "i");
        const statusPath = new RegExp(`^/${this.profile()}/status/[0-9]+/?$`, "i").test(location.pathname);
        const names = primary?.querySelectorAll('[data-testid="UserName"], [data-testid="User-Name"]');
        const identified = names && [...names].some((name) => ownHandle.test(name.textContent ?? "") && (statusPath ? !!name.closest('[data-testid="tweet"]')?.querySelector(`a[href="${location.pathname.replace(/\/$/, "")}"]`) : !name.closest('[data-testid="tweet"]')));
        if (primary && visible(primary) && identified) {
          const denied = new Set(Array.from(primary.querySelectorAll('aside, [role="tab"]')).filter((node) => node.getAttribute("role") !== "tab" || (node.textContent ?? "").trim() !== "Posts"));
          for (const user of primary.querySelectorAll('[data-testid="UserCell"]')) denied.add(user.closest('[data-testid="cellInnerDiv"]') ?? user);
          for (const heading of primary.querySelectorAll('h1, h2, h3, [role="heading"]')) {
            if ((heading.textContent ?? "").trim() === "Who to follow") denied.add(heading.closest('[data-testid="cellInnerDiv"]') ?? heading);
          }
          this.shield.allow([primary], [...denied]);
          this.shield.show("composing");
          this.shield.setProfile(this.profile(), () => {
            const native = document.querySelector('a[href="/compose/post"]');
            if (native) {
              this.shield.clickNativeCompose(native);
            } else this.compose();
          });
          return;
        }
      }
      this.shield.allow([]);
      if (this.seenComposer || kind !== "x-compose" && kind !== "x-auth") {
        this.phase = "restricted";
        this.shield.show(this.phase, this.compose);
        return;
      }
      if (Date.now() - this.loadingSince >= 12e3) {
        this.phase = "error";
        this.shield.show(this.phase, this.retries < 3 ? this.retry : () => location.reload(), this.retries < 3);
        return;
      }
      this.phase = "loading";
      this.shield.show(this.phase);
      this.timer = setTimeout(() => this.refresh(), Math.max(1, 12e3 - (Date.now() - this.loadingSince)));
    }
    stop() {
      this.active = false;
      this.observer.disconnect();
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      window.removeEventListener("popstate", this.onPage);
      window.removeEventListener("hashchange", this.onPage);
      window.removeEventListener("pageshow", this.onPage);
      this.shield.disable();
    }
  };

  // src/content/guard.ts
  var scope = globalThis;
  function install() {
    if (scope.__focusGuardV1) {
      scope.__focusGuardV1.refresh();
      return;
    }
    const kind = classifyUrl(location.href).kind;
    if (kind === "unrestricted" || kind === "youtube-studio") return;
    const shield = new PageShield();
    let x = null;
    let state = null;
    let revision = 0;
    let profileHandle = null;
    let reportedProfile = null;
    let expiry = null;
    let observer = null;
    let mediaBlocked = false;
    const pauseMedia = () => {
      if (!mediaBlocked) return;
      for (const media of document.querySelectorAll("video, audio")) if (media instanceof HTMLMediaElement) media.pause();
    };
    const onPlay = (event) => {
      if (mediaBlocked && event.target instanceof HTMLMediaElement) event.target.pause();
    };
    const cleanupMedia = () => {
      mediaBlocked = false;
      observer?.disconnect();
      observer = null;
      document.removeEventListener("play", onPlay, true);
    };
    const apply = (value) => {
      state = normalizeState(value);
      revision++;
      if (expiry) clearTimeout(expiry);
      expiry = null;
      if (!isActive(state)) {
        x?.stop();
        x = null;
        cleanupMedia();
        shield.disable();
        return;
      }
      shield.enable();
      if (isXHost(location.hostname)) {
        if (!x) x = new XGuard(shield, () => profileHandle, reportProfile);
        else x.refresh();
      } else {
        shield.allow([]);
        shield.show("restricted");
        if (!mediaBlocked) {
          mediaBlocked = true;
          document.addEventListener("play", onPlay, true);
          observer = new MutationObserver((records) => {
            if (!records.some((record) => !(record.target instanceof Element && record.target.closest("#focus-cover")))) return;
            shield.allow([]);
            pauseMedia();
          });
          observer.observe(document.documentElement, { childList: true, subtree: true });
        }
        pauseMedia();
      }
      if (state.endsAt !== null) {
        const delay = Math.min(2147483647, Math.max(1, state.endsAt - Date.now()));
        expiry = setTimeout(() => {
          if (state) apply(state);
          void readWorker();
        }, delay);
      }
    };
    const readWorker = async () => {
      const readRevision = revision;
      try {
        const result = await chrome.runtime.sendMessage({ type: "focus:get" });
        if (readRevision !== revision || typeof result !== "object" || result === null || !("ok" in result) || result.ok !== true || !("state" in result)) return;
        if ("profileHandle" in result) profileHandle = normalizeProfileHandle(result.profileHandle);
        apply(result.state);
      } catch {
      }
    };
    const reportProfile = (handle) => {
      if (handle === reportedProfile) return;
      reportedProfile = handle;
      void chrome.runtime.sendMessage({ type: "focus:profile", handle }).then((result) => {
        if (typeof result !== "object" || result === null || !("ok" in result) || result.ok !== true) return;
        if ("profileHandle" in result) profileHandle = normalizeProfileHandle(result.profileHandle);
        if (state) apply(state);
      }).catch(() => {
        reportedProfile = null;
      });
    };
    const discoverProfile = () => {
      const link = document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
      const handle = link ? normalizeProfileHandle(new URL(link.href).pathname.slice(1)) : null;
      if (handle) reportProfile(handle);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", discoverProfile, { once: true });
    else discoverProfile();
    scope.__focusGuardV1 = {
      refresh() {
        if (state) apply(state);
        void readWorker();
      }
    };
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (sender.id !== chrome.runtime.id || typeof message !== "object" || message === null || !("type" in message) || message.type !== "focus:state" || !("state" in message)) return false;
      if ("profileHandle" in message) profileHandle = normalizeProfileHandle(message.profileHandle);
      apply(message.state);
      sendResponse({ ok: true, guarded: true, hasComposer: x?.hasComposer() ?? false });
      return false;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (PROFILE_KEY in changes) profileHandle = normalizeProfileHandle(changes[PROFILE_KEY]?.newValue);
      if (STORAGE_KEY in changes) apply(changes[STORAGE_KEY]?.newValue);
      else if (PROFILE_KEY in changes && state) apply(state);
    });
    window.addEventListener("pageshow", () => {
      discoverProfile();
      if (state && isActive(state)) {
        apply(state);
        void readWorker();
      }
    });
    const initialRevision = revision;
    void chrome.storage.local.get([STORAGE_KEY, PROFILE_KEY]).then((values) => {
      if (revision === initialRevision) {
        profileHandle = normalizeProfileHandle(values[PROFILE_KEY]);
        apply(values[STORAGE_KEY]);
      }
      void readWorker();
    }).catch(() => {
      void readWorker();
    });
  }
  install();
})();
