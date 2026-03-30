const DEFAULT_DURATION = 4200;
const ROOT_ID = "toast-root";

/**
 * @param {string} message
 * @param {{ type?: 'success' | 'error' | 'info', duration?: number }} [options]
 */
export function showToast(message, options = {}) {
  const { type = "success", duration = DEFAULT_DURATION } = options;
  let root = document.getElementById(ROOT_ID);
  if (!root) {
    root = document.createElement("div");
    root.id = ROOT_ID;
    root.className = "toast-root no-print";
    root.setAttribute("aria-live", "polite");
    root.setAttribute("aria-atomic", "true");
    document.body.appendChild(root);
  }

  const el = document.createElement("div");
  el.className = `toast toast--${type}`;
  el.textContent = message;
  root.appendChild(el);

  requestAnimationFrame(() => {
    el.classList.add("toast--visible");
  });

  const removeEl = () => {
    el.classList.remove("toast--visible");
    const done = () => {
      el.remove();
      if (root && root.childElementCount === 0) {
        root.remove();
      }
    };
    el.addEventListener("transitionend", done, { once: true });
    setTimeout(done, 350);
  };

  setTimeout(removeEl, duration);
}

/**
 * Show a message as an error toast and optionally mirror it to inline form error element(s).
 * @param {string} message
 * @param {{ errEl?: HTMLElement | null, errEl2?: HTMLElement | null }} [options]
 */
export function showValidationToast(message, options = {}) {
  const { errEl, errEl2 } = options;
  if (errEl) errEl.textContent = message;
  if (errEl2) errEl2.textContent = message;
  showToast(message, { type: "error" });
}
