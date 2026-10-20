export async function writeClipboard(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    /* Try native WebView fallback below. */
  }
  const focused = document.activeElement as HTMLElement | null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.cssText = "position:fixed;left:-9999px;top:0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (!document.execCommand("copy"))
      throw new Error(
        "Clipboard access was denied. Allow clipboard access and try again.",
      );
  } finally {
    textarea.remove();
    focused?.focus();
  }
}
