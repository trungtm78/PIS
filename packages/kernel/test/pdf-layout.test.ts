import { DomainError } from '../src/errors.ts';
import { ND30_A4_STANDARD, PAGE_HEIGHT_MM, PAGE_WIDTH_MM, SEAL_OVERLAP_TARGET, SEAL_OVERLAP_TOLERANCE, assertLayoutWithinLegalRange, boxOnPage, layoutFromBody, layoutProfileOf, sealMeetsSignature, sealOverlapRatio } from '../src/pdf-layout.ts';
import type { LayoutProfile } from '../src/pdf-layout.ts';

function detailOf(profile: LayoutProfile): { code: string; detail: string | undefined } | undefined {
  try {
    assertLayoutWithinLegalRange(profile);
    return undefined;
  } catch (error) {
    if (error instanceof DomainError) return { code: error.code, detail: error.detail };
    throw error;
  }
}

function withMargin(key: 'top' | 'bottom' | 'left' | 'right', value: number): LayoutProfile {
  return { ...ND30_A4_STANDARD, marginsMm: { ...ND30_A4_STANDARD.marginsMm, [key]: value } };
}

function withSize(key: keyof LayoutProfile['elementStyles'], size: number): LayoutProfile {
  return {
    ...ND30_A4_STANDARD,
    elementStyles: { ...ND30_A4_STANDARD.elementStyles, [key]: { ...ND30_A4_STANDARD.elementStyles[key], sizePt: size } },
  };
}

describe('ND30_A4_STANDARD (BR-DOC-13)', () => {
  it('uses the default values of the table of BR-DOC-13', () => {
    expect(ND30_A4_STANDARD.code).toBe('ND30_A4_STANDARD');
    expect(ND30_A4_STANDARD.revision).toBe(1);
    expect(ND30_A4_STANDARD.marginsMm).toEqual({ top: 20, bottom: 20, left: 30, right: 15 });
    expect(ND30_A4_STANDARD.fontFamily).toBe('Times New Roman');
    expect(ND30_A4_STANDARD.elementStyles.nationalTitle.sizePt).toBe(13);
    expect(ND30_A4_STANDARD.elementStyles.motto.sizePt).toBe(14);
    expect(ND30_A4_STANDARD.elementStyles.body.sizePt).toBe(14);
    expect(ND30_A4_STANDARD.elementStyles.recipientsLabel.sizePt).toBe(12);
    expect(ND30_A4_STANDARD.elementStyles.recipientsList.sizePt).toBe(11);
  });

  it('is within its own legal range', () => {
    expect(detailOf(ND30_A4_STANDARD)).toBeUndefined();
  });
});

describe('assertLayoutWithinLegalRange', () => {
  it.each([
    ['top', 19.9, 'marginsMm.top'],
    ['top', 25.1, 'marginsMm.top'],
    ['bottom', 25.1, 'marginsMm.bottom'],
    ['left', 29.9, 'marginsMm.left'],
    ['left', 35.1, 'marginsMm.left'],
    ['right', 14.9, 'marginsMm.right'],
    ['right', 20.1, 'marginsMm.right'],
  ] as const)('refuses margin %s = %s', (key, value, detail) => {
    expect(detailOf(withMargin(key, value))).toEqual({ code: 'LAYOUT_OUT_OF_LEGAL_RANGE', detail });
  });

  it.each([
    ['top', 25],
    ['bottom', 20],
    ['left', 35],
    ['right', 20],
  ] as const)('accepts the boundary of margin %s = %s', (key, value) => {
    expect(detailOf(withMargin(key, value))).toBeUndefined();
  });

  it.each([
    ['nationalTitle', 11.9],
    ['nationalTitle', 13.1],
    ['motto', 12.9],
    ['motto', 14.1],
    ['body', 15],
    ['signerTitle', 12],
  ] as const)('refuses the size %s = %s', (key, size) => {
    expect(detailOf(withSize(key, size))).toEqual({ code: 'LAYOUT_OUT_OF_LEGAL_RANGE', detail: `elementStyles.${key}.sizePt` });
  });

  it('fixes the recipients label at 12 pt and the list at 11 pt', () => {
    expect(detailOf(withSize('recipientsLabel', 13))?.detail).toBe('elementStyles.recipientsLabel.sizePt');
    expect(detailOf(withSize('recipientsList', 12))?.detail).toBe('elementStyles.recipientsList.sizePt');
  });

  it('refuses a page size other than A4 and a missing element style', () => {
    expect(detailOf({ ...ND30_A4_STANDARD, pageSize: 'LETTER' as 'A4' })?.detail).toBe('pageSize');
    const rest = Object.fromEntries(Object.entries(ND30_A4_STANDARD.elementStyles).filter(([name]) => name !== 'body'));
    expect(detailOf({ ...ND30_A4_STANDARD, elementStyles: rest as LayoutProfile['elementStyles'] })?.detail).toBe('elementStyles.body');
  });
});

describe('a stored profile with malformed nested members', () => {
  const stateOf = (profile: unknown): { code: string; detail: string | undefined } | undefined => detailOf(profile as LayoutProfile);

  it.each([null, 'big', 12, []])('refuses an element style that is %j with LAYOUT_STATE_INVALID, not a TypeError', (style) => {
    const profile = { ...ND30_A4_STANDARD, elementStyles: { ...ND30_A4_STANDARD.elementStyles, body: style } };
    expect(stateOf(profile)).toEqual({ code: 'LAYOUT_STATE_INVALID', detail: 'elementStyles.body' });
  });

  it('refuses a box of the signature or number layout that is not a box of numbers', () => {
    const date = { ...ND30_A4_STANDARD.numberFieldLayout, date: { xMm: 'left', yMm: 50, widthMm: 60, heightMm: 6 } };
    expect(stateOf({ ...ND30_A4_STANDARD, numberFieldLayout: date })).toEqual({ code: 'LAYOUT_STATE_INVALID', detail: 'numberFieldLayout.date' });
    expect(stateOf({ ...ND30_A4_STANDARD, signatureLayout: { ...ND30_A4_STANDARD.signatureLayout, sealBox: null } })).toEqual({ code: 'LAYOUT_STATE_INVALID', detail: 'signatureLayout.sealBox' });
    expect(stateOf({ ...ND30_A4_STANDARD, numberFieldLayout: { number: ND30_A4_STANDARD.numberFieldLayout.number } })).toEqual({ code: 'LAYOUT_STATE_INVALID', detail: 'numberFieldLayout.symbol' });
  });

  it('is refused when it is read from a row', () => {
    const body = { ...ND30_A4_STANDARD.elementStyles, body: null };
    expect(() =>
      layoutProfileOf({
        profile_code: 'X',
        revision: 1,
        page_size: 'A4',
        margins_mm: ND30_A4_STANDARD.marginsMm,
        font_family: 'Times New Roman',
        element_styles: body,
        signature_layout: ND30_A4_STANDARD.signatureLayout,
        number_field_layout: ND30_A4_STANDARD.numberFieldLayout,
        watermark_policy: { text: 'DRAFT' },
        confirmation_status: 'PENDING_CONFIRMATION',
      }),
    ).toThrow(expect.objectContaining({ code: 'LAYOUT_STATE_INVALID' }));
  });
});

describe('layoutProfileOf (a document_layout_profile row to a profile)', () => {
  const row = {
    profile_code: 'ND30_A4_STANDARD',
    revision: 1,
    page_size: 'A4',
    margins_mm: { top: 20, bottom: 20, left: 30, right: 15 },
    font_family: 'Times New Roman',
    font_substitute: 'Tinos',
    element_styles: ND30_A4_STANDARD.elementStyles,
    signature_layout: ND30_A4_STANDARD.signatureLayout,
    number_field_layout: ND30_A4_STANDARD.numberFieldLayout,
    watermark_policy: { text: 'DRAFT' },
    confirmation_status: 'PENDING_CONFIRMATION',
  };

  it('maps the columns and keeps the confirmation state', () => {
    const profile = layoutProfileOf(row);
    expect(profile.code).toBe('ND30_A4_STANDARD');
    expect(profile.fontSubstitute).toBe('Tinos');
    expect(profile.confirmationStatus).toBe('PENDING_CONFIRMATION');
    expect(profile.watermarkPolicy.text).toBe('DRAFT');
  });

  it('refuses a row that is out of range or malformed', () => {
    expect(() => layoutProfileOf({ ...row, margins_mm: { top: 30, bottom: 20, left: 30, right: 15 } })).toThrow(DomainError);
    expect(() => layoutProfileOf({ ...row, margins_mm: 'wide' })).toThrow(DomainError);
    expect(() => layoutProfileOf({ ...row, element_styles: null })).toThrow(DomainError);
  });
});

describe('the boxes of the signature and of the number fields lie on the A4 page', () => {
  const moved = (part: 'signatureLayout' | 'numberFieldLayout', name: string, change: Partial<{ xMm: number; yMm: number; widthMm: number; heightMm: number }>): LayoutProfile => {
    const copy = JSON.parse(JSON.stringify(ND30_A4_STANDARD)) as LayoutProfile;
    const boxes = copy[part] as unknown as Record<string, Record<string, number>>;
    Object.assign(boxes[name] ?? {}, change);
    return copy;
  };

  it('knows what lies on the page: a box with a size, inside 210 x 297 mm', () => {
    expect([PAGE_WIDTH_MM, PAGE_HEIGHT_MM]).toEqual([210, 297]);
    expect(boxOnPage({ xMm: 0, yMm: 0, widthMm: 210, heightMm: 297 })).toBe(true);
    for (const box of [{ xMm: -1, yMm: 0, widthMm: 10, heightMm: 10 }, { xMm: 0, yMm: -1, widthMm: 10, heightMm: 10 }, { xMm: 201, yMm: 0, widthMm: 10, heightMm: 10 }, { xMm: 0, yMm: 288, widthMm: 10, heightMm: 10 }, { xMm: 0, yMm: 0, widthMm: 0, heightMm: 10 }, { xMm: 0, yMm: 0, widthMm: 10, heightMm: 0 }]) {
      expect(boxOnPage(box)).toBe(false);
    }
  });

  it.each([
    ['signatureLayout', 'leaderBox', { yMm: 400 }, 'signatureLayout.leaderBox'],
    ['signatureLayout', 'leaderBox', { xMm: 150 }, 'signatureLayout.leaderBox'],
    ['signatureLayout', 'leaderBox', { heightMm: 0 }, 'signatureLayout.leaderBox'],
    ['signatureLayout', 'sealBox', { xMm: -5 }, 'signatureLayout.sealBox'],
    ['numberFieldLayout', 'number', { yMm: 300 }, 'numberFieldLayout.number'],
    ['numberFieldLayout', 'symbol', { widthMm: 0 }, 'numberFieldLayout.symbol'],
    ['numberFieldLayout', 'date', { xMm: 200 }, 'numberFieldLayout.date'],
  ] as const)('refuses a profile whose %s %s is moved by %j off the page', (part, name, change, detail) => {
    expect(detailOf(moved(part, name, change))).toEqual({ code: 'LAYOUT_OUT_OF_LEGAL_RANGE', detail });
  });
});

describe('the seal over the signature of the leader (BR-DOC-13, AC-ST-DOC-016-2)', () => {
  const withBoxes = (leader: Partial<LayoutProfile['signatureLayout']['leaderBox']>, seal: Partial<LayoutProfile['signatureLayout']['sealBox']>): LayoutProfile => ({
    ...ND30_A4_STANDARD,
    signatureLayout: { leaderBox: { ...ND30_A4_STANDARD.signatureLayout.leaderBox, ...leader }, sealBox: { ...ND30_A4_STANDARD.signatureLayout.sealBox, ...seal } },
  });

  it('covers a third of the width of the signature, give or take 0.03, in the default profile', () => {
    expect(Math.abs(sealOverlapRatio(ND30_A4_STANDARD.signatureLayout) - SEAL_OVERLAP_TARGET)).toBeLessThanOrEqual(SEAL_OVERLAP_TOLERANCE);
    expect(sealOverlapRatio({ leaderBox: { xMm: 100, yMm: 0, widthMm: 60, heightMm: 30 }, sealBox: { xMm: 80, yMm: 0, widthMm: 40, heightMm: 40 } })).toBeCloseTo(1 / 3, 6);
  });

  it('meets the signature up and down as well as side to side, with boxes that have a size', () => {
    expect(sealMeetsSignature(ND30_A4_STANDARD.signatureLayout)).toBe(true);
    const layout = (seal: Partial<typeof ND30_A4_STANDARD.signatureLayout.sealBox>) => ({ leaderBox: ND30_A4_STANDARD.signatureLayout.leaderBox, sealBox: { ...ND30_A4_STANDARD.signatureLayout.sealBox, ...seal } });
    expect(sealMeetsSignature(layout({ yMm: 0 }))).toBe(false);
    expect(sealMeetsSignature(layout({ yMm: 255 }))).toBe(false);
    expect(sealMeetsSignature(layout({ yMm: 254 }))).toBe(true);
    expect(sealMeetsSignature(layout({ widthMm: 0 }))).toBe(false);
  });

  it('is 0 when the seal does not meet the signature, and when the signature has no width', () => {
    expect(sealOverlapRatio({ leaderBox: { xMm: 100, yMm: 0, widthMm: 60, heightMm: 30 }, sealBox: { xMm: 10, yMm: 0, widthMm: 40, heightMm: 40 } })).toBe(0);
    expect(sealOverlapRatio({ leaderBox: { xMm: 100, yMm: 0, widthMm: 0, heightMm: 30 }, sealBox: { xMm: 90, yMm: 0, widthMm: 40, heightMm: 40 } })).toBe(0);
  });

  it.each([
    ['a seal that covers half of it', { xMm: 80 }, { xMm: 80, widthMm: 50 }],
    ['a seal that covers a fifth of it', {}, { xMm: 80, widthMm: 44 }],
    ['a seal that does not touch it', {}, { xMm: 10 }],
    ['a seal that starts to the right of it', {}, { xMm: 120, widthMm: 30 }],
    ['a seal that is above the signature, not over it', {}, { yMm: 0 }],
    ['a seal that has no height', {}, { heightMm: 0 }],
  ] as const)('refuses %s', (_label, leader, seal) => {
    expect(detailOf(withBoxes(leader, seal))).toEqual({ code: 'LAYOUT_OUT_OF_LEGAL_RANGE', detail: 'signatureLayout.sealBox' });
  });

  it('takes a third on either edge of the tolerance and refuses just beyond it', () => {
    const at = (ratio: number): LayoutProfile => withBoxes({ xMm: 100, widthMm: 100 }, { xMm: 100 + ratio * 100 - 40, widthMm: 40 });
    expect(detailOf(at(SEAL_OVERLAP_TARGET - SEAL_OVERLAP_TOLERANCE))).toBeUndefined();
    expect(detailOf(at(SEAL_OVERLAP_TARGET + SEAL_OVERLAP_TOLERANCE))).toBeUndefined();
    expect(detailOf(at(SEAL_OVERLAP_TARGET - SEAL_OVERLAP_TOLERANCE - 0.01))?.code).toBe('LAYOUT_OUT_OF_LEGAL_RANGE');
    expect(detailOf(at(SEAL_OVERLAP_TARGET + SEAL_OVERLAP_TOLERANCE + 0.01))?.code).toBe('LAYOUT_OUT_OF_LEGAL_RANGE');
  });
});

describe('layoutFromBody (createDocumentLayoutProfileRevision)', () => {
  const body = () => ({
    margins_mm: { ...ND30_A4_STANDARD.marginsMm },
    font_family: 'Times New Roman',
    font_substitute: 'Tinos',
    element_styles: JSON.parse(JSON.stringify(ND30_A4_STANDARD.elementStyles)) as Record<string, unknown>,
    signature_layout: JSON.parse(JSON.stringify(ND30_A4_STANDARD.signatureLayout)) as Record<string, unknown>,
    number_field_layout: JSON.parse(JSON.stringify(ND30_A4_STANDARD.numberFieldLayout)) as Record<string, unknown>,
    watermark_policy: { text: '  PENDING  ' },
  });
  const failure = (change: (draft: ReturnType<typeof body>) => void): { code: string; detail: string | undefined } => {
    const draft = body();
    change(draft);
    try {
      layoutFromBody(draft, 'CODE', 2);
    } catch (error) {
      if (error instanceof DomainError) return { code: error.code, detail: error.detail };
      throw error;
    }
    throw new Error('the body was accepted');
  };

  it('builds the profile with the code and the revision of the store, and a trimmed watermark', () => {
    const profile = layoutFromBody(body(), 'CODE', 2);
    expect(profile).toMatchObject({ code: 'CODE', revision: 2, pageSize: 'A4', fontSubstitute: 'Tinos', watermarkPolicy: { text: 'PENDING' }, confirmationStatus: 'PENDING_CONFIRMATION' });
    expect(profile.marginsMm).toEqual(ND30_A4_STANDARD.marginsMm);
    expect(layoutFromBody({ ...body(), font_substitute: '' }, 'CODE', 1)).not.toHaveProperty('fontSubstitute');
    expect(layoutFromBody({ ...body(), font_substitute: undefined }, 'CODE', 1)).not.toHaveProperty('fontSubstitute');
  });

  it('refuses a value outside the ranges, naming it: a margin of 18, a size, the seal', () => {
    expect(failure((draft) => ((draft.margins_mm as Record<string, number>).top = 18))).toEqual({ code: 'LAYOUT_OUT_OF_LEGAL_RANGE', detail: 'marginsMm.top' });
    expect(failure((draft) => (((draft.element_styles.body as Record<string, number>).sizePt = 16)))).toEqual({ code: 'LAYOUT_OUT_OF_LEGAL_RANGE', detail: 'elementStyles.body.sizePt' });
    expect(failure((draft) => (((draft.signature_layout.sealBox as Record<string, number>).xMm = 10)))).toEqual({ code: 'LAYOUT_OUT_OF_LEGAL_RANGE', detail: 'signatureLayout.sealBox' });
    expect(failure((draft) => delete draft.element_styles.body)).toEqual({ code: 'LAYOUT_OUT_OF_LEGAL_RANGE', detail: 'elementStyles.body' });
  });

  it('refuses a body that is not the shape of a profile (422 VALIDATION_FAILED naming the member)', () => {
    expect(failure((draft) => ((draft as { margins_mm: unknown }).margins_mm = 'wide'))).toEqual({ code: 'VALIDATION_FAILED', detail: 'margins_mm' });
    expect(failure((draft) => ((draft.margins_mm as Record<string, unknown>).left = '30'))).toEqual({ code: 'VALIDATION_FAILED', detail: 'margins_mm' });
    expect(failure((draft) => ((draft as { element_styles: unknown }).element_styles = []))).toEqual({ code: 'VALIDATION_FAILED', detail: 'element_styles' });
    expect(failure((draft) => ((draft.element_styles.body as Record<string, unknown>).bold = 'yes'))).toEqual({ code: 'VALIDATION_FAILED', detail: 'element_styles.body' });
    expect(failure((draft) => ((draft.element_styles.body as Record<string, unknown>).sizePt = '14'))).toEqual({ code: 'VALIDATION_FAILED', detail: 'element_styles.body' });
    expect(failure((draft) => ((draft.element_styles as Record<string, unknown>).body = 5))).toEqual({ code: 'VALIDATION_FAILED', detail: 'element_styles.body' });
    expect(failure((draft) => ((draft as { signature_layout: unknown }).signature_layout = null))).toEqual({ code: 'VALIDATION_FAILED', detail: 'signature_layout' });
    expect(failure((draft) => delete draft.signature_layout.leaderBox)).toEqual({ code: 'VALIDATION_FAILED', detail: 'signature_layout.leaderBox' });
    expect(failure((draft) => ((draft.signature_layout.sealBox as Record<string, unknown>).xMm = 'x'))).toEqual({ code: 'VALIDATION_FAILED', detail: 'signature_layout.sealBox' });
    expect(failure((draft) => ((draft as { number_field_layout: unknown }).number_field_layout = 3))).toEqual({ code: 'VALIDATION_FAILED', detail: 'number_field_layout' });
    expect(failure((draft) => delete draft.number_field_layout.date)).toEqual({ code: 'VALIDATION_FAILED', detail: 'number_field_layout.date' });
    expect(failure((draft) => delete draft.number_field_layout.number)).toEqual({ code: 'VALIDATION_FAILED', detail: 'number_field_layout.number' });
    expect(failure((draft) => delete draft.number_field_layout.symbol)).toEqual({ code: 'VALIDATION_FAILED', detail: 'number_field_layout.symbol' });
    expect(failure((draft) => ((draft.watermark_policy as Record<string, unknown>).text = 'ab'))).toEqual({ code: 'VALIDATION_FAILED', detail: 'watermark_policy' });
    expect(failure((draft) => ((draft.watermark_policy as Record<string, unknown>).text = 'x'.repeat(121)))).toEqual({ code: 'VALIDATION_FAILED', detail: 'watermark_policy' });
    expect(failure((draft) => ((draft as { watermark_policy: unknown }).watermark_policy = {}))).toEqual({ code: 'VALIDATION_FAILED', detail: 'watermark_policy' });
  });
});
