export type FocusState = {
  version: 1;
  enabled: boolean;
  endsAt: number | null;
};

export const STORAGE_KEY = 'focusState';
export const DURATIONS = [null, 25, 50, 90] as const;
export type FocusDuration = (typeof DURATIONS)[number];
export const DEFAULT_STATE: FocusState = { version: 1, enabled: false, endsAt: null };

export function isDuration(value: unknown): value is FocusDuration {
  return value === null || value === 25 || value === 50 || value === 90;
}

export function isActive(state: FocusState, now = Date.now()) {
  return state.enabled && (state.endsAt === null || state.endsAt > now);
}

export function normalizeState(value: unknown, now = Date.now()): FocusState {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_STATE };
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.enabled !== 'boolean') return { ...DEFAULT_STATE };
  if (record.endsAt !== null && (typeof record.endsAt !== 'number' || !Number.isSafeInteger(record.endsAt) || record.endsAt <= 0)) return { ...DEFAULT_STATE };
  const state: FocusState = { version: 1, enabled: record.enabled, endsAt: record.endsAt as number | null };
  return isActive(state, now) ? state : { ...DEFAULT_STATE };
}

export function createSession(duration: FocusDuration, now = Date.now()): FocusState {
  return { version: 1, enabled: true, endsAt: duration === null ? null : now + duration * 60_000 };
}
