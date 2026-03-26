const DEFAULT_MSG = "Loading…";
const messageStack = [];

function syncOverlay() {
  const el = document.getElementById("app-loading-overlay");
  if (!el) return;
  const body = document.body;
  if (messageStack.length === 0) {
    el.classList.add("hidden");
    el.setAttribute("aria-hidden", "true");
    el.removeAttribute("aria-busy");
    if (body) body.classList.remove("app-loading-active");
    return;
  }
  el.classList.remove("hidden");
  el.setAttribute("aria-hidden", "false");
  el.setAttribute("aria-busy", "true");
  if (body) body.classList.add("app-loading-active");
  const t = el.querySelector(".app-loading-text");
  if (t) t.textContent = messageStack[messageStack.length - 1] || DEFAULT_MSG;
}

export function showLoading(message = DEFAULT_MSG) {
  messageStack.push(message || DEFAULT_MSG);
  syncOverlay();
}

export function hideLoading() {
  if (messageStack.length > 0) {
    messageStack.pop();
  }
  syncOverlay();
}

export async function withLoading(fn, message = DEFAULT_MSG) {
  showLoading(message);
  try {
    return await fn();
  } finally {
    hideLoading();
  }
}
