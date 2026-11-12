import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contrastRatio } from '../src/contrast.ts';
import { CSS_OUTPUT_PATH, TS_OUTPUT_PATH, buildTokens, generateTokens } from '../src/generate.ts';
import { DART_V2_OUTPUT_PATH, generateMobileV2Dart } from '../src/mobile-v2.ts';
import type { DesignTokens, MobileV2Tokens } from '../src/types.ts';
import { REPO_ROOT, realDesignTokens } from './support.ts';

function v2Of(json: DesignTokens): MobileV2Tokens {
  if (json.mobileV2 === undefined) throw new Error('the design token file has no mobileV2 group');
  return json.mobileV2;
}

function withV2(json: DesignTokens, change: (v2: MobileV2Tokens) => void): DesignTokens {
  const copy = JSON.parse(JSON.stringify(json)) as DesignTokens;
  change(v2Of(copy));
  return copy;
}

describe('the mobileV2 group never reaches a web output (R31)', () => {
  const json = realDesignTokens();

  it('is stripped from the built tokens, so the typed module and the CSS of the web carry nothing of it', () => {
    expect(buildTokens(json)).not.toHaveProperty('mobileV2');
    const { css, ts } = generateTokens(json);
    expect(css).not.toMatch(/mobileV2|mv2|-late|-soon|-ok-/i);
    expect(ts).not.toContain('mobileV2');
  });

  it('gives the same web outputs with and without the group, byte for byte', () => {
    const without = { ...json } as Partial<DesignTokens>;
    delete without.mobileV2;
    expect(generateTokens(json)).toEqual(generateTokens(without as DesignTokens));
  });

  it('keeps the committed web outputs equal to what the generator writes from the file with the group', () => {
    const { css, ts } = generateTokens(json);
    const committed = (path: string): string => readFileSync(join(REPO_ROOT, path), 'utf8').replace(/\r\n/g, '\n');
    expect(committed(CSS_OUTPUT_PATH)).toBe(css);
    expect(committed(TS_OUTPUT_PATH)).toBe(ts);
  });
});

describe('the contrast of the mobile.v2 colours, light and dark, as the design system v2 states it', () => {
  const v2 = v2Of(realDesignTokens());
  const modes = ['light', 'dark'] as const;

  const textPairs: Array<[string, string, string, number]> = [
    ['ink', 'bg', 'text on the app background', 4.5],
    ['ink', 'surface', 'text on a surface', 4.5],
    ['ink2', 'bg', 'secondary text on the background', 4.5],
    ['ink2', 'surface', 'secondary text on a surface', 4.5],
    ['ink3', 'surface', 'caption text on a surface', 4.5],
    ['onHeader', 'header', 'text on the command band', 4.5],
    ['onHeader2', 'header', 'secondary text on the command band', 4.5],
    ['onPrimary', 'primary', 'text on the primary button', 4.5],
    ['primaryStrong', 'primarySoft', 'link text on the soft primary', 4.5],
    ['primaryStrong', 'surface', 'link text on a surface', 4.5],
    ['lateFg', 'lateBg', 'late text on its band', 4.5],
    ['soonFg', 'soonBg', 'soon text on its band', 4.5],
    ['okFg', 'okBg', 'ok text on its band', 4.5],
    ['infoFg', 'infoBg', 'info text on its band', 4.5],
    ['lateFg', 'surface', 'late text on a surface', 4.5],
    ['soonFg', 'surface', 'soon text on a surface', 4.5],
    ['okFg', 'surface', 'ok text on a surface', 4.5],
  ];

  for (const mode of modes) {
    const palette = v2.color[mode];
    it.each(textPairs)(`${mode}: %s on %s (%s) is at least %f:1`, (foreground, background, _label, minimum) => {
      expect(contrastRatio(palette[foreground] as string, palette[background] as string)).toBeGreaterThanOrEqual(minimum);
    });

    it(`${mode}: the three band marks and the outline reach 3:1 against the surface (WCAG 1.4.11 for shapes and controls)`, () => {
      for (const key of ['lateMark', 'soonMark', 'okMark', 'outline']) {
        expect(contrastRatio(palette[key] as string, palette.surface as string)).toBeGreaterThanOrEqual(3);
      }
    });

    it(`${mode}: every text on a band fill is at least 6.4:1 (the design system promise)`, () => {
      for (const band of ['late', 'soon', 'ok']) {
        expect(contrastRatio(palette[`${band}Fg`] as string, palette[`${band}Bg`] as string)).toBeGreaterThanOrEqual(6.4);
      }
    });
  }

  it('has the same keys in light and dark', () => {
    expect(Object.keys(v2.color.dark)).toEqual(Object.keys(v2.color.light));
  });
});

describe('the type scale, spacing and elevation of mobile.v2', () => {
  const v2 = v2Of(realDesignTokens());

  it('has six steps, no size below 12 and only the weights 400 and 600', () => {
    expect(Object.keys(v2.type.scale)).toEqual(['display', 'title', 'heading', 'body', 'label', 'caption']);
    for (const step of [...Object.values(v2.type.scale), ...Object.values(v2.type.emphasis)]) {
      expect(step.size).toBeGreaterThanOrEqual(12);
      expect([400, 600]).toContain(step.weight);
      expect(step.line).toBeGreaterThan(step.size);
    }
  });

  it('spaces by 4, 8, 12, 16, 24 and 32 only', () => {
    expect(v2.space).toEqual([4, 8, 12, 16, 24, 32]);
  });

  it('has no shadow in dark mode that is a drop shadow of a list: dark e1 is a hairline border', () => {
    expect(v2.elevation.e1?.dark).toEqual([{ dx: 0, dy: 0, blur: 0, spread: 1, color: '#FFFFFF', opacity: 0.04 }]);
  });
});

describe('generateMobileV2Dart', () => {
  const json = realDesignTokens();
  const dart = generateMobileV2Dart(json);

  it('is deterministic, plain ASCII and carries the generated notice', () => {
    expect(generateMobileV2Dart(json)).toBe(dart);
    expect(dart).toMatch(/^[\n -~]*$/);
    expect(dart.startsWith('// Generated by packages/design-tokens/src/mobile-v2.ts')).toBe(true);
    expect(DART_V2_OUTPUT_PATH).toBe('packages/mobile-tokens/lib/machvon_v2.generated.dart');
  });

  it('writes both palettes, the type steps, the spacing and the elevation', () => {
    expect(dart).toContain('static const MachvonV2Palette light = MachvonV2Palette(');
    expect(dart).toContain('static const MachvonV2Palette dark = MachvonV2Palette(');
    expect(dart).toContain('primary: Color(0xFF007D77),');
    expect(dart).toContain('primary: Color(0xFF4FD1C5),');
    expect(dart).toContain('static const MachvonV2TypeStep display = MachvonV2TypeStep(size: 32, line: 40, weight: FontWeight.w600);');
    expect(dart).toContain('static const MachvonV2TypeStep caption = MachvonV2TypeStep(size: 12, line: 18, weight: FontWeight.w400);');
    expect(dart).toContain('static const double s24 = 24;');
    expect(dart).toContain('static const double displayScaleCap = 1.3;');
    expect(dart).toContain('static const List<BoxShadow> e2Light = <BoxShadow>[BoxShadow(color: Color(0x2E102E3B), offset: Offset(0, -8), blurRadius: 28, spreadRadius: 0)];');
    expect(dart).toContain('static const Curve curve = Cubic(0.2, 0.7, 0.2, 1);');
  });

  it('refuses a file without the group', () => {
    const broken = { ...json } as Partial<DesignTokens>;
    delete broken.mobileV2;
    expect(() => generateMobileV2Dart(broken as DesignTokens)).toThrow(/mobileV2 group is missing/);
  });

  it('refuses dark colours that do not mirror the light ones', () => {
    const broken = withV2(json, (v2) => {
      delete v2.color.dark.scrim;
    });
    expect(() => generateMobileV2Dart(broken)).toThrow(/same keys/);
  });

  it('refuses a colour that is not six digit hex, or a missing one', () => {
    expect(() => generateMobileV2Dart(withV2(json, (v2) => { v2.color.light.ink = 'red'; }))).toThrow(/ink/);
    expect(() => generateMobileV2Dart(withV2(json, (v2) => { v2.color.light.ink = '#123'; }))).toThrow(/six digit/);
  });

  it('refuses a third weight, a cramped line height and a bad name or number', () => {
    expect(() => generateMobileV2Dart(withV2(json, (v2) => { v2.type.scale.body = { size: 15, line: 22, weight: 700 }; }))).toThrow(/only 400 and 600/);
    expect(() => generateMobileV2Dart(withV2(json, (v2) => { v2.type.scale.body = { size: 15, line: 16, weight: 400 }; }))).toThrow(/line height/);
    expect(() => generateMobileV2Dart(withV2(json, (v2) => { v2.radius['Bad-name'] = 4; }))).toThrow(/Dart name/);
    expect(() => generateMobileV2Dart(withV2(json, (v2) => { v2.radius.chip = Number.NaN; }))).toThrow(/not a number/);
  });

  it('refuses a shadow opacity outside 0 to 1 and a motion curve without four numbers', () => {
    expect(() => generateMobileV2Dart(withV2(json, (v2) => { v2.elevation.e2!.light[0]!.opacity = 2; }))).toThrow(/opacity/);
    expect(() => generateMobileV2Dart(withV2(json, (v2) => { v2.motion.curve = [0.2, 0.7]; }))).toThrow(/four numbers/);
  });

  it('writes an empty list for an elevation without layers', () => {
    const flat = withV2(json, (v2) => {
      v2.elevation.e1!.light = [];
    });
    expect(generateMobileV2Dart(flat)).toContain('static const List<BoxShadow> e1Light = <BoxShadow>[];');
  });
});
