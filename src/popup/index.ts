import { settleWithin } from '../shared/deadline';
import { isDuration, STORAGE_KEY, type FocusState } from '../shared/state';
import type { FocusMessage } from '../shared/messages';

const toggle = document.querySelector<HTMLButtonElement>('#toggle')!;
const duration = document.querySelector<HTMLSelectElement>('#duration')!;
const sessionText = document.querySelector<HTMLParagraphElement>('#session')!;
const problem = document.querySelector<HTMLDivElement>('#problem')!;
const errorText = document.querySelector<HTMLParagraphElement>('#error')!;
const retry = document.querySelector<HTMLButtonElement>('#retry')!;
let session: FocusState | null = null;
let reading = false;
let mutating = false;
let revision = 0;
let checkedExpiration: number | null = null;

function validSession(value: unknown): value is FocusState {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === 1 && typeof candidate.enabled === 'boolean' &&
    (candidate.endsAt === null || (typeof candidate.endsAt === 'number' && Number.isSafeInteger(candidate.endsAt) && candidate.endsAt > 0));
}

function render() {
  toggle.disabled = mutating || session === null;
  toggle.setAttribute('aria-checked', String(session?.enabled ?? false));
  toggle.setAttribute('aria-label', session?.enabled ? 'Turn Focus off' : 'Turn Focus on');
  duration.disabled = mutating || session === null || session.enabled;
  retry.disabled = reading || mutating;
  document.body.dataset.active = String(session?.enabled ?? false);
  if (!session) sessionText.textContent = reading ? 'Loading…' : 'Focus unavailable';
  else if (!session.enabled) sessionText.textContent = 'Off';
  else if (session.endsAt === null) sessionText.textContent = 'On';
  else {
    const seconds = Math.max(0, Math.ceil((session.endsAt - Date.now()) / 1000));
    const minutes = Math.floor(seconds / 60);
    sessionText.textContent = seconds ? `On · ${minutes}:${String(seconds % 60).padStart(2, '0')} remaining` : 'Ending session…';
    if (!seconds && !reading && !mutating && checkedExpiration !== session.endsAt) {
      checkedExpiration = session.endsAt;
      void request({ type: 'focus:get' });
    }
  }
}

function showError(message: string) {
  errorText.textContent = message;
  problem.hidden = !message;
}

async function readSavedSession() {
  try {
    const result = await settleWithin(chrome.storage.local.get(STORAGE_KEY), 2000);
    if (result.status === 'resolved' && validSession(result.value[STORAGE_KEY])) return result.value[STORAGE_KEY] as FocusState;
  } catch { /* A background retry remains available if storage is unavailable. */ }
  return null;
}

async function request(message: Exclude<FocusMessage, { type: 'focus:profile' }>) {
  const current = ++revision;
  const isMutation = message.type !== 'focus:get';
  reading = !isMutation;
  mutating = isMutation;
  showError('');
  render();
  try {
    const response = await settleWithin(chrome.runtime.sendMessage<FocusMessage, unknown>(message), isMutation ? 5000 : 3000);
    if (current !== revision) return;
    if (response.status !== 'resolved') {
      showError('Focus did not respond. Try again.');
      if (isMutation) {
        const saved = await readSavedSession();
        if (current !== revision) return;
        if (saved) session = saved;
      }
      return;
    }
    const result = response.value;
    if (typeof result !== 'object' || result === null) {
      showError('Focus did not respond. Try again.');
      return;
    }
    const value = result as Record<string, unknown>;
    if (value.ok !== true || !validSession(value.state)) {
      showError(typeof value.error === 'string' ? value.error : 'Could not update Focus. Try again.');
      return;
    }
    session = value.state;
  } catch {
    if (current === revision) showError('Could not reach Focus. Try again.');
  } finally {
    if (current === revision) {
      reading = false;
      mutating = false;
      render();
    }
  }
}

toggle.addEventListener('click', () => {
  if (!session || mutating) return;
  if (session.enabled) void request({ type: 'focus:stop' });
  else {
    const selected = duration.value === '' ? null : Number(duration.value);
    if (isDuration(selected)) void request({ type: 'focus:start', duration: selected });
  }
});
retry.addEventListener('click', () => { if (!reading && !mutating) void request({ type: 'focus:get' }); });
chrome.runtime.onMessage.addListener((message: unknown) => {
  if (typeof message !== 'object' || message === null || mutating) return;
  const notification = message as Record<string, unknown>;
  if (notification.type === 'focus:state' && validSession(notification.state)) {
    // A newer broadcast supersedes any older in-flight read.
    revision++;
    reading = false;
    session = notification.state;
    showError('');
    render();
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || mutating || !validSession(changes[STORAGE_KEY]?.newValue)) return;
  revision++;
  reading = false;
  session = changes[STORAGE_KEY].newValue;
  showError('');
  render();
});
setInterval(render, 1000);
void readSavedSession().then(saved => {
  if (saved && session === null) { session = saved; render(); }
});
void request({ type: 'focus:get' });
