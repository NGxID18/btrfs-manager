window.$ = (id) => document.getElementById(id);
window.on = (id, evt, cb) => {
  const e = $(id);
  if (e) e.addEventListener(evt, cb);
};
window.cmd = (args, opts = {}) =>
  cockpit.spawn(args, {
    superuser: "require",
    environ: ["LC_ALL=C.UTF-8", "LANG=C.UTF-8"],
    ...opts,
  });

window.escapeHtml = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

window.parseSize = (s) => {
  if (!s) return 0;
  const m = s.match(/([0-9.]+)\s*([a-zA-Z]+)/);
  return m
    ? parseFloat(m[1]) *
        ({ K: 1024, M: 1048576, G: 1073741824, T: 1099511627776, P: 1125899906842624 }[
          m[2][0].toUpperCase()
        ] || 1)
    : 0;
};

window.formatSize = (b) => {
  if (!b || isNaN(b) || b <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), units.length - 1);
  if (i <= 0) return `${Math.round(b)} B`;
  return `${(b / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
};

window.Modal = {
  cb: null,
  show(title, msg, type = "alert", opts = null, cb = null, btnText = null, isDanger = false) {
    try {
      if (!$("generic-modal")) return;
      $("generic-modal-title").innerText = title;
      $("generic-modal-message").innerText = msg;

      const inputContainer = $("generic-modal-input-container");
      if (inputContainer) {
        inputContainer.classList.toggle(
          "hidden-element",
          type === "alert" || type === "confirm",
        );
      }

      const inputEl = $("generic-modal-input");
      if (inputEl) {
        inputEl.classList.toggle("hidden-element", type !== "prompt");
      }

      const selectEl = $("generic-modal-select");
      if (selectEl) {
        selectEl.classList.toggle("hidden-element", type !== "select");
      }

      const cancelBtn = $("generic-modal-cancel");
      if (cancelBtn) {
        cancelBtn.classList.toggle("hidden-element", type === "alert");
      }

      const confirmBtn = $("generic-modal-confirm");
      if (confirmBtn) {
        confirmBtn.innerText = btnText || (type === "alert" ? "OK" : "Confirm");
        confirmBtn.classList.toggle("btn-danger", Boolean(isDanger));
        confirmBtn.classList.toggle("btn-primary", !isDanger);
      }

      if (type === "prompt" && inputEl) {
        inputEl.value = opts || "";
        setTimeout(() => {
          inputEl.focus();
          inputEl.select();
        }, 100);
      }
      if (type === "select" && selectEl) {
        selectEl.innerHTML = (opts || [])
          .map((o) => `<option value="${o.v}">${o.l}</option>`)
          .join("");
        setTimeout(() => selectEl.focus(), 100);
      }

      this.cb = cb;
      $("generic-modal").classList.remove("hidden-element");
    } catch (e) {
      console.error("Modal Engine Crash:", e);
    }
  },
  close() {
    const m = $("generic-modal");
    if (m) m.classList.add("hidden-element");
    this.cb = null;
  },
  confirm() {
    const actionCallback = this.cb;
    const selectEl = $("generic-modal-select");
    const inputEl = $("generic-modal-input");
    const val =
      selectEl && !selectEl.classList.contains("hidden-element")
        ? selectEl.value
        : inputEl
          ? inputEl.value
          : "";
    this.close();
    if (actionCallback) actionCallback(val);
  },
};

window.customAlert = (title, message) => {
  Modal.show(title, message, "alert", null, null, "OK", false);
};
window.customConfirm = (
  title,
  message,
  confirmBtnText,
  onConfirm,
  isDanger = false,
) => {
  Modal.show(
    title,
    message,
    "confirm",
    null,
    onConfirm,
    confirmBtnText || "Confirm",
    isDanger,
  );
};
window.customPrompt = (
  title,
  message,
  defaultVal,
  confirmBtnText,
  onConfirm,
) => {
  Modal.show(
    title,
    message,
    "prompt",
    defaultVal,
    onConfirm,
    confirmBtnText || "Submit",
    false,
  );
};
window.customSelect = (title, message, options, confirmBtnText, onConfirm) => {
  Modal.show(
    title,
    message,
    "select",
    options,
    onConfirm,
    confirmBtnText || "Select",
    false,
  );
};

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (
      $("generic-modal") &&
      !$("generic-modal").classList.contains("hidden-element")
    ) {
      Modal.close();
    }
    if (
      $("add-dev-modal") &&
      !$("add-dev-modal").classList.contains("hidden-element")
    ) {
      $("add-dev-modal").classList.add("hidden-element");
    }
    if (
      $("destroy-vol-modal") &&
      !$("destroy-vol-modal").classList.contains("hidden-element")
    ) {
      $("destroy-vol-modal").classList.add("hidden-element");
    }
  } else if (e.key === "Enter") {
    if (
      $("generic-modal") &&
      !$("generic-modal").classList.contains("hidden-element") &&
      document.activeElement === $("generic-modal-input")
    ) {
      e.preventDefault();
      Modal.confirm();
    }
  }
});
