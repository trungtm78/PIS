import { contrastRatio } from './contrast.ts';
import { validateTenantOverlay } from './overlay.ts';
import { TOKENS } from './tokens.generated.ts';

export const VECTORS_PATH = 'packages/design-tokens/test/vectors/contrast-vectors.json';

export interface ContrastVector {
  foreground: string;
  background: string;
  /** The WCAG ratio of the TypeScript implementation, rounded to two decimals. */
  ratio: number;
}

export interface OverlayVector {
  name: string;
  overlay: Record<string, string>;
  /** Verdict of validateTenantOverlay on the base tokens. */
  accepted: boolean;
  /** Distinct finding codes, sorted. */
  codes: string[];
}

export interface ContrastVectors {
  contrast: ContrastVector[];
  overlays: OverlayVector[];
}

const CONTRAST_INPUTS: ReadonlyArray<readonly [string, string]> = [
  ['#000000', '#FFFFFF'],
  ['#FFFFFF', '#FFFFFF'],
  ['#FFFFFF', '#007D77'],
  ['#122D3B', '#F3F6F5'],
  ['#5B6E77', '#FFFFFF'],
  ['#FFFFFF', '#1C4A52'],
  ['#909090', '#FFFFFF'],
  ['#777777', '#FFFFFF'],
  ['#767676', '#FFFFFF'],
  ['#444', '#FFFFFF'],
  ['#FF0000', '#00FF00'],
  ['#123456', '#ABCDEF'],
];

/** Overlay cases shared with the Dart tests: the 3.2:1 rejection, the 4.5:1 boundary and every refused kind of value. */
const OVERLAY_INPUTS: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ['empty overlay', {}],
  ['contrast 3.19 on menu', { menu: '#FFFFFF', menuText: '#909090' }],
  ['contrast 4.48 on menu', { menu: '#FFFFFF', menuText: '#777777' }],
  ['contrast 4.54 on menu', { menu: '#FFFFFF', menuText: '#767676' }],
  ['three digit hex', { menu: '#FFFFFF', menuText: '#444' }],
  ['dark menu with light text', { menu: '#202020', menuText: '#F0F0F0' }],
  ['menu as light as its text', { menu: '#FFFFFF' }],
  ['url value', { primary: 'url(https://example.com/x.png)' }],
  ['javascript value', { primary: 'javascript:alert(1)' }],
  ['declaration break', { primary: '#B4233D;' }],
  ['named colour', { primary: 'red' }],
  ['rgb function', { primary: 'rgb(0,0,0)' }],
  ['unknown token', { sidebarWidth: '#FFFFFF' }],
  ['logo that is a URL', { logoAssetId: 'https://example.com/logo.png' }],
  ['logo asset id', { logoAssetId: '123e4567-e89b-42d3-a456-426614174000' }],
];

function roundTo2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Pure and deterministic: the vectors the web validator and the Dart package must agree on. */
export function buildContrastVectors(): ContrastVectors {
  return {
    contrast: CONTRAST_INPUTS.map(([foreground, background]) => ({ foreground, background, ratio: roundTo2(contrastRatio(foreground, background)) })),
    overlays: OVERLAY_INPUTS.map(([name, overlay]) => {
      const result = validateTenantOverlay(TOKENS, overlay);
      return {
        name,
        overlay,
        accepted: result.ok,
        codes: result.ok ? [] : [...new Set(result.findings.map((finding) => finding.code))].sort(),
      };
    }),
  };
}

export function renderVectors(vectors: ContrastVectors): string {
  return `${JSON.stringify(vectors, null, 2)}\n`;
}
