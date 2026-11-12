import type { ThemeColorKey } from './theme-rules.ts';

/** The shape of `04_Design_Assets/design_tokens.json` (Ruby / Porcelain). */
export interface DesignTokens {
  name: string;
  version: string;
  color: Record<string, string>;
  font: {
    family: string;
    body: number;
    title: number;
    mobileBody: number;
    navPrimary: number;
    navSecondary: number;
  };
  space: number[];
  radius: Record<string, number>;
  viewport: { web: [number, number]; mobile: [number, number] };
  touch: { ios_pt: number; android_dp: number };
  /** Phone-only tokens; absent from every web output. */
  mobileV2?: MobileV2Tokens;
  displayName: string;
  prototypeNavigation: Record<string, unknown>;
  businessNavigation: {
    sidebarWidth: number;
    compactSidebarWidth: number;
    mobileDrawerBreakpoint: number;
    inboxSinglePaneBreakpoint: number;
    selectedText: string;
    [key: string]: unknown;
  };
  theme: string;
}

/** One step of the mobile.v2 type scale: size and line height in logical pixels, weight 400 or 600. */
export interface MobileV2TypeStep {
  size: number;
  line: number;
  weight: number;
}

export interface MobileV2Shadow {
  dx: number;
  dy: number;
  blur: number;
  spread: number;
  color: string;
  opacity: number;
}

/** The mobileV2 group of the design tokens: the phone only (R31). It is never written to the web outputs. */
export interface MobileV2Tokens {
  note?: string;
  color: { light: Record<string, string>; dark: Record<string, string> };
  type: {
    scale: Record<string, MobileV2TypeStep>;
    emphasis: Record<string, MobileV2TypeStep>;
    scaleCap: Record<string, number>;
    clampFreeFrom: number;
  };
  space: number[];
  radius: Record<string, number>;
  elevation: Record<string, { light: MobileV2Shadow[]; dark: MobileV2Shadow[] }>;
  motion: { fastMs: number; slowMs: number; reducedMs: number; curve: number[]; scrimOpacity: number };
  size: Record<string, number>;
}

export type ThemeColors = Record<ThemeColorKey, string>;

/** The design tokens plus the twelve colours a tenant may override (the base values come from the design tokens). */
export type Tokens = DesignTokens & {
  tenantTheme: ThemeColors;
  /** Reference to a stored logo asset; never a URL. */
  logoAssetId?: string;
};
