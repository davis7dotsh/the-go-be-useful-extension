import { classifyUrl, isXHost, normalizeProfileHandle, PROFILE_KEY } from '../shared/policy';
import { isActive, normalizeState, STORAGE_KEY, type FocusState } from '../shared/state';
import { PageShield, XGuard } from './x';

interface GuardSingleton { refresh(): void }
const scope = globalThis as typeof globalThis & { __focusGuardV1?: GuardSingleton };

function install() {
  if (scope.__focusGuardV1) {
    scope.__focusGuardV1.refresh();
    return;
  }
  const kind = classifyUrl(location.href).kind;
  if (kind === 'unrestricted' || kind === 'youtube-studio') return;
  const shield = new PageShield();
  let x: XGuard | null = null;
  let state: FocusState | null = null;
  let revision = 0;
  let profileHandle: string | null = null;
  let reportedProfile: string | null = null;
  let expiry: ReturnType<typeof setTimeout> | null = null;
  let observer: MutationObserver | null = null;
  let mediaBlocked = false;
  const pauseMedia = () => {
    if (!mediaBlocked) return;
    for (const media of document.querySelectorAll('video, audio')) if (media instanceof HTMLMediaElement) media.pause();
  };
  const onPlay = (event: Event) => {
    if (mediaBlocked && event.target instanceof HTMLMediaElement) event.target.pause();
  };
  const cleanupMedia = () => {
    mediaBlocked = false;
    observer?.disconnect();
    observer = null;
    document.removeEventListener('play', onPlay, true);
  };
  const apply = (value: unknown) => {
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
      shield.show('restricted');
      if (!mediaBlocked) {
        mediaBlocked = true;
        document.addEventListener('play', onPlay, true);
        observer = new MutationObserver(records => {
          if (!records.some(record => !(record.target instanceof Element && record.target.closest('#focus-cover')))) return;
          shield.allow([]);
          pauseMedia();
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
      }
      pauseMedia();
    }
    if (state.endsAt !== null) {
      const delay = Math.min(2_147_483_647, Math.max(1, state.endsAt - Date.now()));
      expiry = setTimeout(() => {
        if (state) apply(state);
        void readWorker();
      }, delay);
    }
  };
  const readWorker = async () => {
    const readRevision = revision;
    try {
      const result: unknown = await chrome.runtime.sendMessage({ type: 'focus:get' });
      if (readRevision !== revision || typeof result !== 'object' || result === null || !('ok' in result) || result.ok !== true || !('state' in result)) return;
      if ('profileHandle' in result) profileHandle = normalizeProfileHandle(result.profileHandle);
      apply(result.state);
    } catch {
      // A sleeping/replaced worker cannot uncover a page whose stored session is active.
    }
  };
  const reportProfile = (handle: string) => {
    if (handle === reportedProfile) return;
    reportedProfile = handle;
    void chrome.runtime.sendMessage({ type: 'focus:profile', handle }).then((result: unknown) => {
      if (typeof result !== 'object' || result === null || !('ok' in result) || result.ok !== true) return;
      if ('profileHandle' in result) profileHandle = normalizeProfileHandle(result.profileHandle);
      if (state) apply(state);
    }).catch(() => { reportedProfile = null; });
  };
  const discoverProfile = () => {
    const link = document.querySelector<HTMLAnchorElement>('[data-testid="AppTabBar_Profile_Link"]');
    const handle = link ? normalizeProfileHandle(new URL(link.href).pathname.slice(1)) : null;
    if (handle) reportProfile(handle);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', discoverProfile, { once: true });
  else discoverProfile();
  scope.__focusGuardV1 = {
    refresh() {
      if (state) apply(state);
      void readWorker();
    },
  };
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'focus:state' || !('state' in message)) return false;
    if ('profileHandle' in message) profileHandle = normalizeProfileHandle(message.profileHandle);
    apply(message.state);
    sendResponse({ ok: true, guarded: true, hasComposer: x?.hasComposer() ?? false });
    return false;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (PROFILE_KEY in changes) profileHandle = normalizeProfileHandle(changes[PROFILE_KEY]?.newValue);
    if (STORAGE_KEY in changes) apply(changes[STORAGE_KEY]?.newValue);
    else if (PROFILE_KEY in changes && state) apply(state);
  });
  window.addEventListener('pageshow', () => {
    discoverProfile();
    if (state && isActive(state)) {
      apply(state);
      void readWorker();
    }
  });
  const initialRevision = revision;
  void chrome.storage.local.get([STORAGE_KEY, PROFILE_KEY]).then(values => {
    if (revision === initialRevision) {
      profileHandle = normalizeProfileHandle(values[PROFILE_KEY]);
      apply(values[STORAGE_KEY]);
    }
    void readWorker();
  }).catch(() => {
    // Keep the synchronous cover until the authoritative worker can answer.
    void readWorker();
  });
}

install();
