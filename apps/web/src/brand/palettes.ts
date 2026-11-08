import type { IconColors } from "../pwa/icon-art";

/**
 * The colours of the mark for each edition (`brand/README.md`). The master shape is the same; only the colours differ. `tile` is the flat ground of a small icon (the
 * favicon, the shell, the phone icon); the film and the lockups of `brand/` use the gradient from `top` to `bottom` on the same ground. The public colours are tokens of the
 * design (the executive oil green) plus the gold of `color.fundCarryOver`; `npm run pwa:icons:check` keeps the PWA icons equal to them.
 */
export interface MarkPalette {
  /** The ground of the tile, flat. */
  tile: string;
  /** The gradient of the tile in the lockups and the film. */
  top: string;
  bottom: string;
  /** The mark on the ground. */
  mark: IconColors;
  /** The mark on a light page (no tile). */
  onLight: IconColors;
  /** The text colours: on a dark ground and on a light one. */
  text: {
    onDark: string;
    onDarkSoft: string;
    onLight: string;
    onLightSoft: string;
  };
}

export const MARK_PALETTES: Readonly<
  Record<"public" | "enterprise", MarkPalette>
> = {
  public: {
    tile: "#102E3B",
    top: "#1B4A5B",
    bottom: "#0A2029",
    mark: {
      background: "#102E3B",
      barLow: "#C4D5DC",
      barMid: "#2FB5A8",
      barHigh: "#FFFFFF",
      accent: "#E0AA52",
    },
    onLight: {
      background: "#FFFFFF",
      barLow: "#7EA2B1",
      barMid: "#007D77",
      barHigh: "#102E3B",
      accent: "#C98F2E",
    },
    text: {
      onDark: "#FFFFFF",
      onDarkSoft: "#C4D5DC",
      onLight: "#102E3B",
      onLightSoft: "#4C6571",
    },
  },
  enterprise: {
    tile: "#0F3B57",
    top: "#16507A",
    bottom: "#061826",
    mark: {
      background: "#0F3B57",
      barLow: "#B9CFE0",
      barMid: "#27B7CF",
      barHigh: "#FFFFFF",
      accent: "#F28C3A",
    },
    onLight: {
      background: "#FFFFFF",
      barLow: "#6E93B0",
      barMid: "#0E8FA6",
      barHigh: "#0B2A44",
      accent: "#D9701C",
    },
    text: {
      onDark: "#FFFFFF",
      onDarkSoft: "#B9CFE0",
      onLight: "#0B2A44",
      onLightSoft: "#44607A",
    },
  },
};

/** The palette of an edition id; an edition the brand does not know (a test product) wears the public one. */
export function paletteOf(edition: string): MarkPalette {
  return edition === "enterprise"
    ? MARK_PALETTES.enterprise
    : MARK_PALETTES.public;
}
