"use strict";
(() => {
  // src/shared/deadline.ts
  function settleWithin(operation, milliseconds) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ status: "timeout" }), milliseconds);
      operation.then((value) => {
        clearTimeout(timer);
        resolve({ status: "resolved", value });
      }, (error) => {
        clearTimeout(timer);
        resolve({ status: "rejected", error });
      });
    });
  }

  // src/shared/state.ts
  var STORAGE_KEY = "focusState";
  function isDuration(value) {
    return value === null || value === 25 || value === 50 || value === 90;
  }

  // src/popup/index.ts
  var toggle = document.querySelector("#toggle");
  var duration = document.querySelector("#duration");
  var sessionText = document.querySelector("#session");
  var problem = document.querySelector("#problem");
  var errorText = document.querySelector("#error");
  var retry = document.querySelector("#retry");
  var session = null;
  var reading = false;
  var mutating = false;
  var revision = 0;
  var checkedExpiration = null;
  function validSession(value) {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value;
    return candidate.version === 1 && typeof candidate.enabled === "boolean" && (candidate.endsAt === null || typeof candidate.endsAt === "number" && Number.isSafeInteger(candidate.endsAt) && candidate.endsAt > 0);
  }
  function render() {
    toggle.disabled = mutating || session === null;
    toggle.setAttribute("aria-checked", String(session?.enabled ?? false));
    toggle.setAttribute("aria-label", session?.enabled ? "Turn Focus off" : "Turn Focus on");
    duration.disabled = mutating || session === null || session.enabled;
    retry.disabled = reading || mutating;
    document.body.dataset.active = String(session?.enabled ?? false);
    if (!session) sessionText.textContent = reading ? "Loading\u2026" : "Focus unavailable";
    else if (!session.enabled) sessionText.textContent = "Off";
    else if (session.endsAt === null) sessionText.textContent = "On";
    else {
      const seconds = Math.max(0, Math.ceil((session.endsAt - Date.now()) / 1e3));
      const minutes = Math.floor(seconds / 60);
      sessionText.textContent = seconds ? `On \xB7 ${minutes}:${String(seconds % 60).padStart(2, "0")} remaining` : "Ending session\u2026";
      if (!seconds && !reading && !mutating && checkedExpiration !== session.endsAt) {
        checkedExpiration = session.endsAt;
        void request({ type: "focus:get" });
      }
    }
  }
  function showError(message) {
    errorText.textContent = message;
    problem.hidden = !message;
  }
  async function readSavedSession() {
    try {
      const result = await settleWithin(chrome.storage.local.get(STORAGE_KEY), 2e3);
      if (result.status === "resolved" && validSession(result.value[STORAGE_KEY])) return result.value[STORAGE_KEY];
    } catch {
    }
    return null;
  }
  async function request(message) {
    const current = ++revision;
    const isMutation = message.type !== "focus:get";
    reading = !isMutation;
    mutating = isMutation;
    showError("");
    render();
    try {
      const response = await settleWithin(chrome.runtime.sendMessage(message), isMutation ? 5e3 : 3e3);
      if (current !== revision) return;
      if (response.status !== "resolved") {
        showError("Focus did not respond. Try again.");
        if (isMutation) {
          const saved = await readSavedSession();
          if (current !== revision) return;
          if (saved) session = saved;
        }
        return;
      }
      const result = response.value;
      if (typeof result !== "object" || result === null) {
        showError("Focus did not respond. Try again.");
        return;
      }
      const value = result;
      if (value.ok !== true || !validSession(value.state)) {
        showError(typeof value.error === "string" ? value.error : "Could not update Focus. Try again.");
        return;
      }
      session = value.state;
    } catch {
      if (current === revision) showError("Could not reach Focus. Try again.");
    } finally {
      if (current === revision) {
        reading = false;
        mutating = false;
        render();
      }
    }
  }
  toggle.addEventListener("click", () => {
    if (!session || mutating) return;
    if (session.enabled) void request({ type: "focus:stop" });
    else {
      const selected = duration.value === "" ? null : Number(duration.value);
      if (isDuration(selected)) void request({ type: "focus:start", duration: selected });
    }
  });
  retry.addEventListener("click", () => {
    if (!reading && !mutating) void request({ type: "focus:get" });
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (typeof message !== "object" || message === null || mutating) return;
    const notification = message;
    if (notification.type === "focus:state" && validSession(notification.state)) {
      revision++;
      reading = false;
      session = notification.state;
      showError("");
      render();
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || mutating || !validSession(changes[STORAGE_KEY]?.newValue)) return;
    revision++;
    reading = false;
    session = changes[STORAGE_KEY].newValue;
    showError("");
    render();
  });
  setInterval(render, 1e3);
  void readSavedSession().then((saved) => {
    if (saved && session === null) {
      session = saved;
      render();
    }
  });
  void request({ type: "focus:get" });
})();
