// What the Docker and Upload side panels share: remembered values in
// localStorage and the splitter that resizes them.

export function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered.
  }
}

export function recall(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Drag the panel's `.splitter` to resize it (never under `minWidth`); the width is kept under `widthKey`. */
export function dockSplitter(el: HTMLElement, minWidth: number, widthKey: string, onLayout: () => void): void {
  const bar = el.querySelector<HTMLElement>(".splitter");
  if (!bar) return;
  bar.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    bar.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = el.getBoundingClientRect().width;
    const move = (ev: PointerEvent) => {
      const max = window.innerWidth - 320;
      const w = Math.min(max, Math.max(minWidth, startW + startX - ev.clientX));
      el.style.width = `${w}px`;
    };
    const up = () => {
      bar.removeEventListener("pointermove", move);
      bar.removeEventListener("pointerup", up);
      remember(widthKey, String(Math.round(el.getBoundingClientRect().width)));
      onLayout();
    };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up);
  });
}
