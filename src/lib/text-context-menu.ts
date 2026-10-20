import { writeClipboard } from "./clipboard";
import type { AreaMenuItem } from "../components/AreaContextMenu";
export function textContextItems(
  input: HTMLInputElement | HTMLTextAreaElement,
  onError: (message: string) => void,
): AreaMenuItem[] {
  const start = input.selectionStart ?? 0,
    end = input.selectionEnd ?? 0;
  const original = input.value;
  const selected = original.slice(start, end);
  const secret = input instanceof HTMLInputElement && input.type === "password";
  const editable =
    !input.disabled && !input.readOnly && input.selectionStart !== null;
  async function apply(value: string) {
    if (input.value !== original || !input.isConnected) return;
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, original.slice(0, start) + value + original.slice(end));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.setSelectionRange(start + value.length, start + value.length);
  }
  const run = (action: () => Promise<void>) => {
    void action().catch((error) => onError(String(error)));
  };
  return [
    {
      label: "Cut",
      disabled: !editable || !selected || secret,
      action: () =>
        run(async () => {
          await writeClipboard(selected);
          await apply("");
        }),
    },
    {
      label: "Copy",
      disabled: !selected || secret,
      action: () => run(() => writeClipboard(selected)),
    },
    {
      label: "Paste",
      disabled: !editable || !navigator.clipboard?.readText,
      action: () =>
        run(async () => {
          await apply(await navigator.clipboard.readText());
        }),
    },
    {
      label: "Select All",
      disabled: !original || input.disabled || input.selectionStart === null,
      action: () => {
        input.focus();
        input.select();
      },
    },
  ];
}
