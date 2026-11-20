// Size of the window's own text and bars, chosen in Options → Appearance.
// Terminals keep their own font (layout.fontSize) and are not scaled.

export const UI_SCALES = [0.9, 1, 1.1, 1.25, 1.5] as const;

/** A saved value as one of the allowed scales; anything else is 1. */
export function uiScale(v: unknown): number {
  return typeof v === "number" && (UI_SCALES as readonly number[]).includes(v) ? v : 1;
}

/** Sets the CSS variable every UI size in styles.css is multiplied by. */
export function applyUiScale(v: unknown): void {
  document.documentElement.style.setProperty("--ui-scale", String(uiScale(v)));
}

/** Size of the buttons in a tile's header (+, ⏻…), on top of the interface size. */
export const TILE_ICON_SCALES = [1, 1.25, 1.5, 1.75] as const;

/** A saved value as one of the allowed icon sizes; anything else is 1. */
export function tileIconScale(v: unknown): number {
  return typeof v === "number" && (TILE_ICON_SCALES as readonly number[]).includes(v) ? v : 1;
}

/** Sets the CSS variable the tile header buttons are multiplied by. */
export function applyTileIconScale(v: unknown): void {
  document.documentElement.style.setProperty("--tile-icon-scale", String(tileIconScale(v)));
}
