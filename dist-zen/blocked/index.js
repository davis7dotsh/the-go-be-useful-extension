"use strict";
(() => {
  // src/blocked/index.ts
  var heading = document.querySelector("#heading");
  var remaining = document.querySelector("#remaining");
  var stop = document.querySelector("#stop");
  var studio = document.querySelector("#studio");
  var errorText = document.querySelector("#error");
  var parameters = new URLSearchParams(location.search);
  studio.hidden = ![parameters.get("site"), parameters.get("source"), parameters.get("reason")].includes("youtube");
  var session = null;
  var pending = false;
  var checkingExpiration = false;
  function validSession(value) {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value;
    return candidate.version === 1 && typeof candidate.enabled === "boolean" && (candidate.endsAt === null || typeof candidate.endsAt === "number" && Number.isFinite(candidate.endsAt));
  }
  function render() {
    stop.disabled = pending || !session?.enabled;
    if (!session) return;
    heading.textContent = session.enabled ? "Focus is on." : "Focus is off.";
    stop.textContent = pending && session.enabled ? "Stopping\u2026" : "Stop Focus";
    if (!session.enabled) remaining.textContent = "You can continue browsing.";
    else if (session.endsAt === null) remaining.textContent = "Until stopped";
    else {
      const seconds = Math.max(0, Math.ceil((session.endsAt - Date.now()) / 1e3));
      remaining.textContent = seconds ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} remaining` : "Ending session\u2026";
      if (!seconds && !pending && !checkingExpiration) {
        checkingExpiration = true;
        void request("focus:get").finally(() => {
          checkingExpiration = false;
        });
      }
    }
  }
  async function request(type) {
    pending = true;
    errorText.textContent = "";
    render();
    try {
      const response = await chrome.runtime.sendMessage({ type });
      if (typeof response !== "object" || response === null) throw new Error("Focus did not respond. Reload the extension and try again.");
      const result = response;
      if (result.ok !== true) throw new Error(typeof result.error === "string" ? result.error : "Could not update Focus. Try again.");
      if (!validSession(result.state)) throw new Error("Focus returned an invalid session. Reload the extension.");
      session = result.state;
    } catch (error) {
      errorText.textContent = error instanceof Error ? error.message : "Could not reach Focus. Try again.";
      if (!session) {
        heading.textContent = "Focus";
        remaining.textContent = "Session unavailable";
      }
    } finally {
      pending = false;
      render();
    }
  }
  stop.addEventListener("click", () => {
    if (!pending && session?.enabled) void request("focus:stop");
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (typeof message !== "object" || message === null) return;
    const notification = message;
    if (notification.type === "focus:state" && validSession(notification.state)) {
      session = notification.state;
      render();
    }
  });
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === "local" && !pending) void request("focus:get");
  });
  setInterval(render, 1e3);
  void request("focus:get");
})();
