import { createSession, DEFAULT_STATE, isDuration, normalizeState, type FocusDuration, type FocusState } from '../shared/state';
import { normalizeProfileHandle } from '../shared/policy';
import type { FocusResponse } from '../shared/messages';

export interface SessionPlatform {
  now(): number;
  readState(): Promise<unknown>;
  writeState(state: FocusState): Promise<void>;
  readProfile(): Promise<unknown>;
  writeProfile(handle: string | null): Promise<void>;
  installRules(enabled: boolean): Promise<void>;
  reconcileAlarm(endsAt: number | null, enabled: boolean): Promise<void>;
  notifyTabs(state: FocusState): Promise<void>;
  reconcileTabs(state: FocusState, activate: boolean): Promise<void>;
  updateBadge(state: FocusState): Promise<void>;
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export function createSessionController(platform: SessionPlatform) {
  let state: FocusState = { ...DEFAULT_STATE };
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>) => {
    const result = queue.then(operation);
    queue = result.catch(() => undefined);
    return result;
  };

  async function apply(next: FocusState, activate = false, persist = true) {
    await platform.installRules(next.enabled);
    if (persist) await platform.writeState(next);
    await platform.reconcileAlarm(next.enabled ? next.endsAt : null, next.enabled);
    state = next;
    await platform.notifyTabs(next);
    await platform.reconcileTabs(next, activate);
    await platform.updateBadge(next);
  }

  async function reconcile(refreshTabs = true): Promise<FocusResponse> {
    try {
      const stored = await platform.readState();
      const next = normalizeState(stored, platform.now());
      const storedRecord = typeof stored === 'object' && stored !== null ? stored as Record<string, unknown> : {};
      const unchanged = Object.keys(storedRecord).length === 3 && storedRecord.version === next.version && storedRecord.enabled === next.enabled && storedRecord.endsAt === next.endsAt;
      if (refreshTabs || !unchanged) await apply(next, false, !unchanged);
      else {
        // Popup reads repair browser policy without waiting for every page renderer.
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

  async function change(next: FocusState): Promise<FocusResponse> {
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

  async function updateProfile(handle: string | null): Promise<FocusResponse> {
    if (handle !== null && normalizeProfileHandle(handle) !== handle) return { ok: false, error: 'Invalid X profile handle.' };
    const previous = normalizeProfileHandle(await platform.readProfile());
    const current = normalizeState(await platform.readState(), platform.now());
    if (previous === handle) {
      const result = await reconcile();
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
    updateProfile: (handle: string | null) => serialize(async (): Promise<FocusResponse> => {
      try { return await updateProfile(handle); }
      catch (error) { return { ok: false, error: `Could not discover your X profile: ${errorMessage(error)}` }; }
    }),
    withState: (operation: (current: FocusState) => Promise<void>) => serialize(async () => {
      const current = normalizeState(await platform.readState(), platform.now());
      if (!current.enabled) await apply(current);
      await operation(current);
    }),
    reconcile: () => serialize(() => reconcile()),
    getState: () => serialize(() => reconcile(false)),
    start: (duration: FocusDuration) => serialize(async (): Promise<FocusResponse> => {
      if (!isDuration(duration)) return { ok: false, error: 'Choose Until stopped, 25, 50, or 90 minutes.' };
      try { return await change(createSession(duration, platform.now())); }
      catch (error) { return { ok: false, error: `Could not start Focus: ${errorMessage(error)}` }; }
    }),
    stop: () => serialize(async (): Promise<FocusResponse> => {
      try { return await change({ ...DEFAULT_STATE }); }
      catch (error) { return { ok: false, error: `Could not stop Focus: ${errorMessage(error)}` }; }
    }),
  };
}
