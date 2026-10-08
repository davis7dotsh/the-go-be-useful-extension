import { buildNavigationRules, classifyUrl, destinationForUrl, normalizeProfileHandle, PROFILE_KEY, RULE_IDS } from '../shared/policy';
import { STORAGE_KEY, type FocusState } from '../shared/state';
import { parseGuardAck, type FocusBroadcast } from '../shared/messages';
import type { SessionPlatform } from './session';
import { settleWithin } from '../shared/deadline';

export const GUARD_RESPONSE_TIMEOUT_MS = 750;
export const GUARD_RESPONSE_TIMEOUT = 'timeout' as const;

export const EXPIRATION_ALARM = 'focus-expiration';
export const MAINTENANCE_ALARM = 'focus-maintenance';
const extensionOrigin = () => chrome.runtime.getURL('/');

export async function relevantTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.filter(tab => typeof tab.id === 'number' && typeof tab.url === 'string' && classifyUrl(tab.url).kind !== 'unrestricted');
}

export async function readProfileHandle() {
  const values = await chrome.storage.local.get(PROFILE_KEY);
  return normalizeProfileHandle(values[PROFILE_KEY]);
}

export async function sendStateToTab(tabId: number, state: FocusState, profileHandle?: string | null) {
  try {
    const message: FocusBroadcast = { type: 'focus:state', state, profileHandle: profileHandle === undefined ? await readProfileHandle() : profileHandle };
    const response = await settleWithin(chrome.tabs.sendMessage<FocusBroadcast, unknown>(tabId, message, { frameId: 0 }), GUARD_RESPONSE_TIMEOUT_MS);
    if (response.status === 'timeout') return GUARD_RESPONSE_TIMEOUT;
    return response.status === 'resolved' ? parseGuardAck(response.value) : null;
  } catch {
    // Newly opened tabs and tabs predating installation may not have a receiver yet.
    return null;
  }
}

export async function injectExistingGuards() {
  for (const tab of await relevantTabs()) {
    const kind = classifyUrl(tab.url ?? '').kind;
    if (tab.id === undefined || kind === 'youtube-studio' || kind === 'youtube-music') continue;
    try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/guard.js'] }); }
    catch { /* Restricted browser pages or a tab closing during injection are recoverable. */ }
  }
}

export function createChromiumPlatform(): SessionPlatform {
  return {
    now: Date.now,
    async readState() {
      const values = await chrome.storage.local.get(STORAGE_KEY);
      return values[STORAGE_KEY];
    },
    readProfile: readProfileHandle,
    async writeProfile(handle) { await chrome.storage.local.set({ [PROFILE_KEY]: handle }); },
    async writeState(state) { await chrome.storage.local.set({ [STORAGE_KEY]: state }); },
    async installRules(enabled) {
      const expected = enabled ? buildNavigationRules(extensionOrigin(), await readProfileHandle()) : [];
      const installed = (await chrome.declarativeNetRequest.getDynamicRules()).filter(rule => RULE_IDS.includes(rule.id));
      const signature = (rule: chrome.declarativeNetRequest.Rule) => JSON.stringify([
        rule.id, rule.priority ?? 1, rule.action.type, rule.action.redirect?.url ?? null,
        rule.condition.regexFilter, rule.condition.resourceTypes,
      ]);
      if (installed.length === expected.length && expected.every(rule => installed.some(current => signature(current) === signature(rule)))) return;
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: RULE_IDS, addRules: expected });
    },
    async reconcileAlarm(endsAt, enabled) {
      if (endsAt === null) await chrome.alarms.clear(EXPIRATION_ALARM);
      else {
        const alarm = await chrome.alarms.get(EXPIRATION_ALARM);
        if (!alarm || alarm.scheduledTime !== endsAt) await chrome.alarms.create(EXPIRATION_ALARM, { when: endsAt });
      }
      // A periodic wake-up also repairs a removed expiration alarm after browser restart/sleep.
      if (!enabled) {
        await chrome.alarms.clear(MAINTENANCE_ALARM);
        return;
      }
      const maintenance = await chrome.alarms.get(MAINTENANCE_ALARM);
      if (!maintenance) await chrome.alarms.create(MAINTENANCE_ALARM, { periodInMinutes: 1 });
    },
    async notifyTabs(state) {
      const profileHandle = await readProfileHandle();
      await Promise.all((await relevantTabs()).map(tab => tab.id === undefined ? undefined : sendStateToTab(tab.id, state, profileHandle)));
    },
    async reconcileTabs(state, activate) {
      if (!state.enabled) return;
      const profileHandle = await readProfileHandle();
      const results = await Promise.allSettled((await relevantTabs()).map(async tab => {
        if (tab.id === undefined || !tab.url) return;
        const kind = classifyUrl(tab.url, profileHandle).kind;
        if (kind === 'x-restricted') {
          const receiver = await sendStateToTab(tab.id, state, profileHandle);
          // A busy/frozen tab may contain a draft. Retry later rather than navigating it away.
          if (receiver === GUARD_RESPONSE_TIMEOUT || (receiver && (!activate || receiver.hasComposer))) return;
        }
        const destination = destinationForUrl(tab.url, extensionOrigin(), profileHandle);
        if (destination) {
          try { await chrome.tabs.update(tab.id, { url: destination }); }
          catch (error) {
            // A closed tab needs no enforcement; other failures must reach the controller.
            try { await chrome.tabs.get(tab.id); } catch { return; }
            throw error;
          }
        }
      }));
      // Finish every tab update before permitting the next serialized session change.
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    },
    async updateBadge(state) {
      await chrome.action.setBadgeText({ text: state.enabled ? 'ON' : '' });
      await chrome.action.setBadgeBackgroundColor({ color: '#4DABF7' });
      await chrome.action.setTitle({ title: state.enabled ? 'Focus is on' : 'Focus' });
    },
  };
}
