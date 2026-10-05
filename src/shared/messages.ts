import { normalizeProfileHandle } from './policy';
import { isDuration, type FocusDuration, type FocusState } from './state';

export type FocusMessage =
  | { type: 'focus:get' }
  | { type: 'focus:start'; duration: FocusDuration }
  | { type: 'focus:stop' }
  | { type: 'focus:profile'; handle: string | null };
export type FocusResponse = { ok: true; state: FocusState; profileHandle?: string | null } | { ok: false; error: string };
export type FocusBroadcast = { type: 'focus:state'; state: FocusState; profileHandle?: string | null };

export function parseMessage(value: unknown): FocusMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const message = value as Record<string, unknown>;
  if (message.type === 'focus:get' || message.type === 'focus:stop') return { type: message.type };
  if (message.type === 'focus:profile') {
    if (message.handle === null) return { type: 'focus:profile', handle: null };
    const handle = normalizeProfileHandle(message.handle);
    return handle ? { type: 'focus:profile', handle } : null;
  }
  if (message.type === 'focus:start' && isDuration(message.duration)) return { type: message.type, duration: message.duration };
  return null;
}

export type FocusGuardAck = { ok: true; guarded: true; hasComposer: boolean };
export function parseGuardAck(value: unknown): FocusGuardAck | null {
  if (typeof value !== 'object' || value === null) return null;
  const response = value as Record<string, unknown>;
  if (response.ok !== true || response.guarded !== true || typeof response.hasComposer !== 'boolean') return null;
  return { ok: true, guarded: true, hasComposer: response.hasComposer };
}
