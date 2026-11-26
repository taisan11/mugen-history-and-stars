/**
 * Shared search-box behaviour for the history and bookmark pages.
 *
 * - Debounces typing so we don't query/re-render on every keystroke.
 * - Never emits while an IME composition is in progress (important for Japanese
 *   input: converting "にほん" to "日本" should not trigger intermediate searches).
 * - Enter applies immediately and Escape clears the query.
 * - "/" focuses the search box when the user isn't already typing somewhere.
 */

export interface SearchInputHandle {
  /** Apply the current value immediately, skipping the remaining debounce. */
  flush(): void;
  /** Drop a pending debounced update. */
  cancel(): void;
}

const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || EDITABLE_TAGS.has(target.tagName))
  );
}

export function bindSearchInput(
  input: HTMLInputElement,
  onChange: (query: string) => void,
  options: { delay?: number } = {},
): SearchInputHandle {
  const delay = options.delay ?? 150;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let composing = false;

  const clearPending = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const flush = () => {
    clearPending();
    onChange(input.value);
  };

  const schedule = () => {
    clearPending();
    timer = setTimeout(flush, delay);
  };

  input.addEventListener("compositionstart", () => {
    composing = true;
    clearPending();
  });

  input.addEventListener("compositionend", () => {
    composing = false;
    schedule();
  });

  input.addEventListener("input", (event) => {
    if (composing || (event as InputEvent).isComposing) return;
    schedule();
  });

  input.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      flush();
    } else if (event.key === "Escape") {
      if (!input.value) return;
      event.preventDefault();
      input.value = "";
      flush();
    }
  });

  return { flush, cancel: clearPending };
}

/** Press "/" anywhere outside an input to jump to the search box. */
export function focusSearchShortcut(input: HTMLInputElement): void {
  document.addEventListener("keydown", (event) => {
    if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
    if (isEditableTarget(event.target)) return;
    event.preventDefault();
    input.focus();
    input.select();
  });
}
