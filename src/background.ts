import { parseMessage, type FocusResponse } from './shared/messages';
import { classifyUrl, destinationForUrl } from './shared/policy';
import { createChromiumPlatform, EXPIRATION_ALARM, GUARD_RESPONSE_TIMEOUT, injectExistingGuards, MAINTENANCE_ALARM, readProfileHandle, sendStateToTab } from './platform/chromium';
import { createSessionController } from './platform/session';

const sessions = createSessionController(createChromiumPlatform());
const reconcile = () => sessions.reconcile().then(result => {
  if (!result.ok) console.error(result.error);
});

chrome.runtime.onMessage.addListener((value: unknown, sender, sendResponse: (response: FocusResponse) => void) => {
  if (sender.id !== chrome.runtime.id) return false;
  const message = parseMessage(value);
  if (!message) {
    if (typeof value === 'object' && value !== null && 'type' in value && String(value.type).startsWith('focus:')) sendResponse({ ok: false, error: 'Invalid Focus request.' });
    return false;
  }
  if (message.type === 'focus:profile') {
    let trustedXPage = false;
    try {
      const source = new URL(sender.url ?? '');
      trustedXPage = (source.origin === 'https://x.com' || source.origin === 'https://www.x.com') && sender.tab !== undefined && (sender.frameId === 0 || sender.frameId === undefined);
    } catch { /* Invalid or absent origins cannot report profile information. */ }
    if (!trustedXPage) {
      sendResponse({ ok: false, error: 'Only the signed-in X page may report your profile.' });
      return false;
    }
    void sessions.updateProfile(message.handle).then(sendResponse);
    return true;
  }
  // Page content can read state but only extension-owned controls may change it.
  if (message.type !== 'focus:get' && (!sender.url || !sender.url.startsWith(chrome.runtime.getURL('')))) {
    sendResponse({ ok: false, error: 'Open the Focus popup to change the session.' });
    return false;
  }
  const response = message.type === 'focus:get' ? sessions.getState() : message.type === 'focus:start' ? sessions.start(message.duration) : sessions.stop();
  void response.then(async result => sendResponse(result.ok ? { ...result, profileHandle: await readProfileHandle() } : result)).catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : 'Focus could not process the request.' }));
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  void injectExistingGuards().then(reconcile).catch(error => console.error('Focus installation reconciliation failed', error));
});
chrome.runtime.onStartup.addListener(() => { void reconcile(); });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === EXPIRATION_ALARM || alarm.name === MAINTENANCE_ALARM) void reconcile();
});

async function enforceNavigation(details: chrome.webNavigation.WebNavigationTransitionCallbackDetails, history: boolean) {
  if (details.frameId !== 0 || classifyUrl(details.url).kind === 'unrestricted') return;
  await sessions.withState(async state => {
    if (!state.enabled) return;
    const profileHandle = await readProfileHandle();
    const kind = classifyUrl(details.url, profileHandle).kind;
    const receiver = await sendStateToTab(details.tabId, state, profileHandle);
    if (receiver === GUARD_RESPONSE_TIMEOUT && kind.startsWith('x-')) return;
    // X SPA dismissals stay covered in place, so closing a composer never reloads a draft.
    if (receiver && receiver !== GUARD_RESPONSE_TIMEOUT && (kind === 'x-compose' || kind === 'x-auth' || kind === 'x-profile' || kind === 'x-restricted') && (history || receiver.hasComposer)) return;
    const destination = destinationForUrl(details.url, chrome.runtime.getURL('/'), profileHandle);
    if (destination) await chrome.tabs.update(details.tabId, { url: destination });
  });
}
chrome.webNavigation.onHistoryStateUpdated.addListener(details => {
  void enforceNavigation(details, true).catch(error => console.error('Focus history enforcement failed', error));
});
chrome.webNavigation.onCommitted.addListener(details => {
  void enforceNavigation(details, false).catch(error => console.error('Focus navigation enforcement failed', error));
});

// Every worker activation repairs rules and alarms against the authoritative timestamp.
void reconcile();
