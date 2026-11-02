/**
 * Copies text to the clipboard.
 *
 * The Clipboard API exists only in secure contexts: HTTPS, localhost and the
 * desktop app. A self-hosted server opened over plain HTTP on a network address
 * has none, so there the text goes through a hidden text field and the
 * browser's copy command. Rejects when neither works, so callers keep their
 * own failure message.
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  copyThroughTextField(text);
}

function copyThroughTextField(text: string) {
  const previousFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.setAttribute("aria-hidden", "true");
  Object.assign(field.style, {
    position: "fixed",
    top: "0",
    left: "0",
    opacity: "0",
    pointerEvents: "none",
  });
  // Inside an open dialog, so the dialog's focus trap lets the field take focus.
  const host = previousFocus?.closest("[role='dialog'], [role='alertdialog']") ?? document.body;
  host.appendChild(field);
  field.focus({ preventScroll: true });
  field.setSelectionRange(0, text.length);
  try {
    if (!document.execCommand("copy")) {
      throw new Error("The browser did not copy the text.");
    }
  } finally {
    field.remove();
    previousFocus?.focus({ preventScroll: true });
  }
}
