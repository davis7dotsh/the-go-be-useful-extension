import styles from './x.css';
import { classifyUrl, COMPOSER_URL, normalizeProfileHandle } from '../shared/policy';

export type GuardPhase = 'inactive' | 'loading' | 'authentication' | 'composing' | 'restricted' | 'error';

// The cover is synchronous: no storage or worker round trip can reveal an active feed.
export class PageShield {
  private style = document.createElement('style');
  private cover = document.createElement('div');
  private composeControl = document.createElement('button');
  private composeAction: (() => void) | null = null;
  private panel = document.createElement('div');
  private title = document.createElement('h1');
  private message = document.createElement('p');
  private action = document.createElement('button');
  private marked = new Set<HTMLElement>();
  private inert = new Map<HTMLElement, boolean>();
  private roots: HTMLElement[] = [];
  private enabled = false;
  private profileHandle: string | null = null;
  private nativeCompose: HTMLAnchorElement | null = null;
  private onAction: (() => void) | null = null;
  private onKey = (event: KeyboardEvent) => {
    const target = event.target;
    if (!(target instanceof Node) || this.cover.contains(target) || this.composeControl.contains(target)) return;
    if (!this.roots.some(root => root.contains(target))) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Tab') this.action.focus();
      return;
    }
    const editable = target instanceof Element && target.closest('input, textarea, [contenteditable="true"], [role="textbox"]');
    // X's global letter shortcuts must not navigate from buttons or dialog chrome.
    if (!editable && event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  private onPointer = (event: Event) => {
    const target = event.target;
    if (!(target instanceof Node) || this.cover.contains(target) || this.composeControl.contains(target)) return;
    if (event.type === 'click' && target instanceof Element && target === this.nativeCompose) return;
    if (!this.roots.some(root => root.contains(target))) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (event.type !== 'click' || !(target instanceof Element)) return;
    const anchor = target.closest('a[href]');
    if (!(anchor instanceof HTMLAnchorElement)) return;
    const kind = classifyUrl(anchor.href).kind;
    const composerTool = anchor.origin === location.origin && /^\/compose\/post\/(?:media|tags)\/?$/.test(anchor.pathname);
    const ownProfile = this.profileHandle && classifyUrl(anchor.href, this.profileHandle).kind === 'x-profile';
    if (kind !== 'x-auth' && kind !== 'x-compose' && !composerTool && !ownProfile) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  constructor() {
    this.style.textContent = styles.replace('__FOCUS_FONT_URL__', chrome.runtime.getURL('assets/Geist.woff2'));
    this.cover.id = 'focus-cover';
    this.composeControl.id = 'focus-compose-control';
    this.composeControl.textContent = 'Compose';
    this.composeControl.type = 'button';
    this.composeControl.hidden = true;
    this.composeControl.addEventListener('click', () => this.composeAction?.());
    this.cover.setAttribute('role', 'region');
    this.cover.setAttribute('aria-label', 'Focus');
    this.panel.className = 'focus-panel';
    this.action.type = 'button';
    this.action.addEventListener('click', () => this.onAction?.());
    this.panel.append(this.title, this.message, this.action);
    this.cover.append(this.panel);
    this.enable();
    this.show('loading');
  }
  enable() {
    if (this.enabled) return;
    this.enabled = true;
    document.documentElement.setAttribute('data-focus-active', '');
    document.documentElement.append(this.style, this.cover, this.composeControl);
    document.addEventListener('keydown', this.onKey, true);
    for (const type of ['pointerdown', 'mousedown', 'click', 'touchstart']) document.addEventListener(type, this.onPointer, true);
  }
  clickNativeCompose(anchor: HTMLAnchorElement) {
    this.nativeCompose = anchor;
    try { anchor.click(); } finally { this.nativeCompose = null; }
  }
  setProfile(handle: string | null, action?: () => void) {
    this.profileHandle = handle;
    this.composeControl.hidden = !action;
    this.composeAction = action ?? null;
  }
  private restoreIsolation() {
    for (const node of this.marked) {
      node.removeAttribute('data-focus-allowed');
      node.removeAttribute('data-focus-path');
      node.removeAttribute('data-focus-denied');
    }
    this.marked.clear();
    for (const [node, prior] of this.inert) node.inert = prior;
    this.inert.clear();
    this.roots = [];
  }
  allow(roots: HTMLElement[], denied: HTMLElement[] = []) {
    this.enable();
    this.restoreIsolation();
    this.roots = roots.filter(root => root.isConnected);
    const paths = new Set<HTMLElement>();
    for (const root of this.roots) {
      root.setAttribute('data-focus-allowed', '');
      this.marked.add(root);
      let ancestor = root.parentElement;
      while (ancestor && ancestor !== document.documentElement) {
        paths.add(ancestor);
        ancestor.setAttribute('data-focus-path', '');
        this.marked.add(ancestor);
        ancestor = ancestor.parentElement;
      }
    }
    const isolate = (node: HTMLElement) => {
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
      node.setAttribute('data-focus-denied', '');
      this.marked.add(node);
    }
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && !this.roots.some(root => root.contains(focused)) && !this.cover.contains(focused)) focused.blur();
  }
  show(phase: GuardPhase, onAction?: () => void, retryAllowed = true) {
    this.cover.dataset.phase = phase;
    const safe = phase === 'composing' || phase === 'authentication';
    this.panel.hidden = safe || phase === 'inactive';
    this.title.textContent = phase === 'loading' ? 'Loading Focus…' : phase === 'error' ? 'Composer unavailable' : 'Focus is on.';
    this.message.textContent = phase === 'error' ? 'X’s composer could not be recognized. The page stays covered.' : phase === 'restricted' ? 'Ready when you have something to post.' : 'Your page is protected while Focus checks its state.';
    this.action.hidden = !onAction;
    this.action.disabled = false;
    this.action.textContent = phase === 'error' ? retryAllowed ? 'Retry composer' : 'Reload to retry' : 'Compose another';
    this.onAction = onAction ?? null;
  }
  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    this.restoreIsolation();
    document.documentElement.removeAttribute('data-focus-active');
    this.style.remove();
    this.cover.remove();
    this.composeControl.remove();
    document.removeEventListener('keydown', this.onKey, true);
    for (const type of ['pointerdown', 'mousedown', 'click', 'touchstart']) document.removeEventListener(type, this.onPointer, true);
  }
}

function visible(element: HTMLElement) {
  // The extension hides the DOM itself, so computed visibility is intentionally ignored.
  return !element.hidden && element.getAttribute('aria-hidden') !== 'true' && !element.closest('[hidden], [aria-hidden="true"]');
}
export function findComposer() {
  const editors = document.querySelectorAll<HTMLElement>('[data-testid="tweetTextarea_0"][contenteditable="true"], [data-testid="tweetTextarea_0"][role="textbox"]');
  for (const editor of editors) {
    const dialog = editor.closest<HTMLElement>('[role="dialog"]');
    if (dialog && visible(dialog) && dialog.querySelector('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]') && dialog.querySelector('input[data-testid="fileInput"]')) return dialog;
    if (dialog || !visible(editor)) continue;
    // Preserve X's inline editor too, but reveal only its smallest complete compose subtree.
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
  if (classifyUrl(location.href).kind !== 'x-auth') return [];
  const credentials = document.querySelectorAll<HTMLElement>('input[autocomplete="username"], input[type="password"], input[autocomplete="one-time-code"], input[name="verification_code"], input[name="challenge_response"]');
  const roots = new Set<HTMLElement>();
  for (const input of credentials) {
    const root = input.closest<HTMLElement>('[role="dialog"], form') ?? input.closest<HTMLElement>('main');
    if (root && visible(root) && !root.querySelector('[data-testid="tweet"]')) roots.add(root);
  }
  return [...roots];
}

// Allow purpose-specific X subdialogs; arbitrary modals remain hidden and inert.
function composerSubdialogs(composer: HTMLElement | null) {
  const allowed: HTMLElement[] = [];
  for (const dialog of document.querySelectorAll<HTMLElement>('[role="dialog"], [role="menu"], [data-testid="emojiPicker"]')) {
    if (dialog === composer || composer?.contains(dialog) || !visible(dialog)) continue;
    const label = dialog.getAttribute('aria-label') ?? '';
    const text = dialog.textContent ?? '';
    const buttons = Array.from(dialog.querySelectorAll<HTMLElement>('button, [role="button"]'));
    const hasButton = (pattern: RegExp) => buttons.some(button => pattern.test(button.getAttribute('aria-label') ?? button.textContent ?? ''));
    const inspectedMedia = /^\/compose\/post\/media\/?$/.test(location.pathname) && !!dialog.querySelector('[data-testid="endEditingButton"]') && /Crop media/i.test(text) && !!dialog.querySelector('[role="slider"], [role="tablist"]');
    const inspectedTags = /^\/compose\/post\/tags\/?$/.test(location.pathname) && /Tag people/i.test(text) && !!dialog.querySelector('input') && hasButton(/^(?:done|save)$/i);
    const mediaEdit = /(?:edit|crop) (?:image|media|photo)|image editor/i.test(label) && !!dialog.querySelector('img, canvas, video') && hasButton(/^(?:save|apply|done)$/i);
    const audience = /(?:choose audience|who can reply|post audience|everyone can reply)/i.test(`${label} ${text}`) && !!dialog.querySelector('[role="radio"], [role="option"], input[type="radio"]');
    const discard = /(?:discard (?:post|draft)|save (?:post|draft))/i.test(text) && hasButton(/^discard$/i) && hasButton(/^(?:save|cancel|keep editing)$/i);
    const schedule = /schedule/i.test(label) && !!dialog.querySelector('input, select, [role="combobox"]') && hasButton(/^(?:confirm|schedule|done)$/i);
    const emoji = dialog.matches('[data-testid="emojiPicker"]') && !!dialog.querySelector('button, [role="button"]') && !!dialog.querySelector('input[type="search"], input[placeholder*="Search"], [role="tablist"]');
    const gif = /(?:choose a gif|search gifs|gif search)/i.test(label) && !!dialog.querySelector('input') && !!dialog.querySelector('img, [role="listbox"]');
    if (inspectedMedia || inspectedTags || mediaEdit || audience || discard || schedule || emoji || gif) allowed.push(dialog);
  }
  if (composer) {
    for (const item of document.querySelectorAll<HTMLElement>('button, [role="button"], [role="menuitem"]')) {
      if (composer.contains(item) || !visible(item) || (item.textContent ?? '').trim() !== 'Upload') continue;
      let parent = item.parentElement;
      for (let depth = 0; parent && depth < 5; depth++, parent = parent.parentElement) {
        if (parent === document.body || parent === document.documentElement || parent.contains(composer)) break;
        const text = (parent.textContent ?? '').trim();
        const choices = Array.from(parent.querySelectorAll<HTMLElement>('button, [role="button"], [role="menuitem"]'));
        const labels = choices.map(choice => (choice.textContent ?? '').trim());
        if (text.length < 120 && choices.length === 2 && labels.includes('Upload') && labels.includes('Generate with Grok')) {
          // Live Helium exposes an Upload / Generate with Grok choice. Only Upload is in scope.
          allowed.push(item);
          break;
        }
        // Never borrow purpose evidence from another popup higher in the tree.
        if (parent.matches('[role="menu"], [role="dialog"], [data-testid="Dropdown"]')) break;
      }
    }
  }
  return allowed.filter(root => !allowed.some(other => other !== root && root.contains(other)));
}

// X renders own-post actions in a portal outside primaryColumn.
function postManagementMenus() {
  return [...document.querySelectorAll<HTMLElement>('[role="menu"]')].filter(menu => {
    if (!visible(menu) || menu.querySelector('[data-testid="tweet"], nav, aside')) return false;
    const pin = menu.querySelector<HTMLElement>('[role="menuitem"][data-testid="pin"], [role="menuitem"][data-testid="unpin"]');
    const ownPost = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].some(item => item.textContent?.trim() === 'Delete');
    return !!pin && /^(?:Pin to your profile|Unpin from profile)$/i.test(pin.textContent?.trim() ?? '') && ownPost;
  });
}

function postPinConfirmations() {
  return [...document.querySelectorAll<HTMLElement>('[data-testid="confirmationSheetDialog"]')].filter(sheet => {
    if (!visible(sheet) || sheet.querySelector('[data-testid="tweet"], nav, aside')) return false;
    const heading = sheet.querySelector('[data-testid="confirmationSheetTitle"], h1[role="heading"]')?.textContent?.trim() ?? '';
    const confirm = sheet.querySelector('[data-testid="confirmationSheetConfirm"]')?.textContent?.trim() ?? '';
    const cancel = sheet.querySelector('[data-testid="confirmationSheetCancel"]');
    return !!cancel && ((/^Pin (?:this )?post(?: to (?:your )?profile)?\?$/i.test(heading) && confirm === 'Pin') ||
      (/^Unpin (?:this )?post(?: from (?:your )?profile)?\?$/i.test(heading) && confirm === 'Unpin'));
  });
}

export class XGuard {
  private observer: MutationObserver;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queued = false;
  private active = true;
  private seenComposer = false;
  private phase: GuardPhase = 'loading';
  private retries = 0;
  private loadingSince = Date.now();
  private reportedProfile: string | null = null;
  private onPage = () => this.refresh();
  constructor(private shield: PageShield, private profile: () => string | null = () => null, private onProfile: (handle: string) => void = () => {}) {
    this.observer = new MutationObserver(records => {
      if (records.some(record => !(record.target instanceof Element && (record.target.closest('#focus-cover') || record.target.closest('#focus-compose-control'))))) this.schedule();
    });
    this.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['role', 'data-testid', 'aria-label', 'aria-hidden', 'hidden'] });
    window.addEventListener('popstate', this.onPage);
    window.addEventListener('hashchange', this.onPage);
    window.addEventListener('pageshow', this.onPage);
    this.refresh();
  }
  hasComposer() { return !!findComposer() || (/^\/compose\/post(?:\/(?:media|tags))?\/?$/.test(location.pathname) && composerSubdialogs(null).length > 0); }
  private schedule() {
    if (this.queued || !this.active) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (this.active) this.refresh();
    });
  }
  private compose = () => {
    // Only a deliberate button action navigates. Observers never reload drafts.
    location.assign(COMPOSER_URL);
  };
  private retry = () => {
    if (this.retries >= 3) return;
    this.retries++;
    this.loadingSince = Date.now();
    this.phase = 'loading';
    this.refresh();
    if (!this.hasComposer() && classifyUrl(location.href).kind !== 'x-compose') this.compose();
  };
  refresh() {
    if (!this.active) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const profileLink = document.querySelector<HTMLAnchorElement>('[data-testid="AppTabBar_Profile_Link"]');
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
      this.phase = 'composing';
      this.shield.allow([composer, ...subdialogs]);
      this.shield.show(this.phase);
      return;
    }
    if ((this.seenComposer || /^\/compose\/post(?:\/(?:media|tags))?\/?$/.test(location.pathname)) && subdialogs.length) {
      this.phase = 'composing';
      this.shield.allow(subdialogs);
      this.shield.show(this.phase);
      return;
    }
    if (auth.length) {
      this.phase = 'authentication';
      this.shield.allow(auth);
      this.shield.show(this.phase);
      return;
    }
    const kind = classifyUrl(location.href, this.profile()).kind;
    if (kind === 'x-profile' && this.profile()) {
      const primary = document.querySelector<HTMLElement>('[data-testid="primaryColumn"]');
      const ownHandle = new RegExp(`@${this.profile()}(?![a-z0-9_])`, 'i');
      const statusPath = new RegExp(`^/${this.profile()}/status/[0-9]+/?$`, 'i').test(location.pathname);
      const names = primary?.querySelectorAll<HTMLElement>('[data-testid="UserName"], [data-testid="User-Name"]');
      const identified = names && [...names].some(name => ownHandle.test(name.textContent ?? '') && (statusPath ? !!name.closest('[data-testid="tweet"]')?.querySelector(`a[href="${location.pathname.replace(/\/$/, '')}"]`) : !name.closest('[data-testid="tweet"]')));
      if (primary && identified) {
        const confirmations = postPinConfirmations();
        if (confirmations.length) {
          // X may aria-hide the profile behind its native confirmation sheet.
          this.shield.allow(confirmations);
          this.shield.show('composing');
          return;
        }
      }
      if (primary && visible(primary) && identified) {
        const denied = new Set(Array.from(primary.querySelectorAll<HTMLElement>('aside, [role="tab"]')).filter(node => node.getAttribute('role') !== 'tab' || (node.textContent ?? '').trim() !== 'Posts'));
        for (const user of primary.querySelectorAll<HTMLElement>('[data-testid="UserCell"]')) denied.add(user.closest<HTMLElement>('[data-testid="cellInnerDiv"]') ?? user);
        for (const heading of primary.querySelectorAll<HTMLElement>('h1, h2, h3, [role="heading"]')) {
          if ((heading.textContent ?? '').trim() === 'Who to follow') denied.add(heading.closest<HTMLElement>('[data-testid="cellInnerDiv"]') ?? heading);
        }
        const menus = postManagementMenus();
        // Only offer actions whose native confirmation remains available in Focus.
        for (const menu of menus) {
          for (const item of menu.querySelectorAll<HTMLElement>('[role="menuitem"]')) {
            if (!item.matches('[data-testid="pin"], [data-testid="unpin"]')) denied.add(item);
          }
        }
        this.shield.allow([primary, ...menus], [...denied]);
        this.shield.show('composing');
        this.shield.setProfile(this.profile(), () => {
          const native = document.querySelector<HTMLAnchorElement>('a[href="/compose/post"]');
          if (native) {
            this.shield.clickNativeCompose(native);
          }
          else this.compose();
        });
        return;
      }
    }
    this.shield.allow([]);
    if (this.seenComposer || (kind !== 'x-compose' && kind !== 'x-auth')) {
      this.phase = 'restricted';
      this.shield.show(this.phase, this.compose);
      return;
    }
    if (Date.now() - this.loadingSince >= 12_000) {
      this.phase = 'error';
      this.shield.show(this.phase, this.retries < 3 ? this.retry : () => location.reload(), this.retries < 3);
      return;
    }
    this.phase = 'loading';
    this.shield.show(this.phase);
    this.timer = setTimeout(() => this.refresh(), Math.max(1, 12_000 - (Date.now() - this.loadingSince)));
  }
  stop() {
    this.active = false;
    this.observer.disconnect();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    window.removeEventListener('popstate', this.onPage);
    window.removeEventListener('hashchange', this.onPage);
    window.removeEventListener('pageshow', this.onPage);
    this.shield.disable();
  }
}
