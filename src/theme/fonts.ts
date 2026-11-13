// UI font styles for panels, drawers, settings and agent terminals. The office
// canvas keeps its pixel font. Saved per browser, not in the repo's config.json,
// because it's a personal choice, not a team setting.

export type FontStyle = "pixel" | "clean" | "mono";

export const FONT_STYLES: { id: FontStyle; label: string; hint: string }[] = [
  { id: "pixel", label: "Pixel", hint: "Pixelify Sans, the game look" },
  { id: "clean", label: "Clean", hint: "Inter, easiest to read" },
  { id: "mono", label: "Mono", hint: "JetBrains Mono, like a terminal" },
];

const KEY = "kh-team.font";
const LEGACY_KEY = "jsmhq.font"; // before the rename; still read so a saved choice isn't lost
export const FONT_EVENT = "kh-team:font";

/** Terminals need a monospace font: Pixel keeps VT323, Clean and Mono use JetBrains Mono. */
export function terminalFont(font: FontStyle) {
  return font === "pixel"
    ? { family: '"VT323", ui-monospace, Menlo, monospace', size: 19, lineHeight: 1.05, load: '19px "VT323"' }
    : { family: '"JetBrains Mono", ui-monospace, Menlo, monospace', size: 13, lineHeight: 1.2, load: '13px "JetBrains Mono"' };
}

export function savedFont(): FontStyle {
  try {
    const v = localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY);
    return FONT_STYLES.some((f) => f.id === v) ? (v as FontStyle) : "pixel";
  } catch {
    return "pixel";
  }
}

export function applyFont(font: FontStyle) {
  if (font === "pixel") delete document.documentElement.dataset.font;
  else document.documentElement.dataset.font = font;
}

export function setFont(font: FontStyle) {
  applyFont(font);
  window.dispatchEvent(new CustomEvent(FONT_EVENT, { detail: font }));
  try {
    localStorage.setItem(KEY, font);
  } catch {
    /* private window: still applies until reload */
  }
}
