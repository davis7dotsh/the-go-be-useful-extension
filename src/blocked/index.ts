export {};

type Session = { version: 1; enabled: boolean; endsAt: number | null };
const heading = document.querySelector<HTMLHeadingElement>("#heading")!;
const remaining = document.querySelector<HTMLParagraphElement>("#remaining")!;
const stop = document.querySelector<HTMLButtonElement>("#stop")!;
const studio = document.querySelector<HTMLAnchorElement>("#studio")!;
const errorText = document.querySelector<HTMLParagraphElement>("#error")!;
const parameters = new URLSearchParams(location.search);
studio.hidden = ![parameters.get("site"), parameters.get("source"), parameters.get("reason")].includes("youtube");
let session: Session | null = null;
let pending = false;
let checkingExpiration = false;

function validSession(value: unknown): value is Session {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === 1 && typeof candidate.enabled === "boolean" &&
    (candidate.endsAt === null || (typeof candidate.endsAt === "number" && Number.isFinite(candidate.endsAt)));
}

function render() {
  stop.disabled = pending || !session?.enabled;
  if (!session) return;
  heading.textContent = session.enabled ? "Focus is on." : "Focus is off.";
  stop.textContent = pending && session.enabled ? "Stopping…" : "Stop Focus";
  if (!session.enabled) remaining.textContent = "You can continue browsing.";
  else if (session.endsAt === null) remaining.textContent = "Until stopped";
  else {
    const seconds = Math.max(0, Math.ceil((session.endsAt - Date.now()) / 1000));
    remaining.textContent = seconds ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} remaining` : "Ending session…";
    if (!seconds && !pending && !checkingExpiration) {
      checkingExpiration = true;
      void request("focus:get").finally(() => { checkingExpiration = false; });
    }
  }
}

async function request(type: "focus:get" | "focus:stop") {
  pending = true;
  errorText.textContent = "";
  render();
  try {
    const response: unknown = await chrome.runtime.sendMessage({ type });
    if (typeof response !== "object" || response === null) throw new Error("Focus did not respond. Reload the extension and try again.");
    const result = response as Record<string, unknown>;
    if (result.ok !== true) throw new Error(typeof result.error === "string" ? result.error : "Could not update Focus. Try again.");
    if (!validSession(result.state)) throw new Error("Focus returned an invalid session. Reload the extension.");
    session = result.state;
  } catch (error) {
    errorText.textContent = error instanceof Error ? error.message : "Could not reach Focus. Try again.";
    if (!session) { heading.textContent = "Focus"; remaining.textContent = "Session unavailable"; }
  } finally { pending = false; render(); }
}

stop.addEventListener("click", () => { if (!pending && session?.enabled) void request("focus:stop"); });
chrome.runtime.onMessage.addListener((message: unknown) => {
  if (typeof message !== "object" || message === null) return;
  const notification = message as Record<string, unknown>;
  if (notification.type === "focus:state" && validSession(notification.state)) { session = notification.state; render(); }
});
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local" && !pending) void request("focus:get");
});
setInterval(render, 1000);
void request("focus:get");
