/**
 * Whether a page-level keyboard shortcut should be ignored: the person is typing in a field, or a
 * dialog is open (its keys belong to it, so `1` mustn't switch tabs behind a modal).
 */
export function shortcutBlocked(target: EventTarget | null) {
  return (
    document.querySelector("[aria-modal='true']") !== null ||
    (target instanceof HTMLElement &&
      (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)))
  );
}
