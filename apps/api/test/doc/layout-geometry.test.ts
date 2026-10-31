import { PDFDocument } from 'pdf-lib';
import { ND30_A4_STANDARD, SEAL_OVERLAP_TARGET, SEAL_OVERLAP_TOLERANCE, signingTimeText } from '@machvon/kernel';
import { PdfLibRenderer } from '../../src/modules/doc/pdf-renderer';
import { prepareSignature, signedBytesOf } from '../../src/modules/doc/pdf-signing';
import { sampleRequest } from './render-fixture';

jest.setTimeout(30_000);

const renderer = new PdfLibRenderer();
/** The file of revision 0, with the two signature fields placed by the profile (BR-DOC-14 a). */
const withFields = () => ({ ...sampleRequest(), signatureFields: true });

async function widgetBoxes(bytes: Uint8Array): Promise<Record<string, { x: number; y: number; width: number; height: number }>> {
  const form = (await PDFDocument.load(bytes)).getForm();
  const boxes: Record<string, { x: number; y: number; width: number; height: number }> = {};
  for (const field of form.getFields()) boxes[field.getName()] = field.acroField.getWidgets()[0]?.getRectangle() ?? { x: 0, y: 0, width: 0, height: 0 };
  return boxes;
}

describe('the seal over the signature of the leader in the PDF (BR-DOC-13, AC-ST-DOC-016-2, UAT-AC416)', () => {
  it('lays the seal over a third of the width of the leader signature, on its left, as the boxes of the profile say', async () => {
    const rendered = await renderer.render(withFields());
    const boxes = await widgetBoxes(rendered.bytes);
    const leader = boxes.sig_leader;
    const seal = boxes.sig_org;
    expect(leader).toBeDefined();
    expect(seal).toBeDefined();
    if (leader === undefined || seal === undefined) return;
    const covered = Math.min(seal.x + seal.width, leader.x + leader.width) - Math.max(seal.x, leader.x);
    expect(Math.abs(covered / leader.width - SEAL_OVERLAP_TARGET)).toBeLessThanOrEqual(SEAL_OVERLAP_TOLERANCE);
    // On its left: the seal starts before the signature does, and the signature box sits inside the width of the page.
    expect(seal.x).toBeLessThan(leader.x);
    expect(leader.x + leader.width).toBeLessThan(595.28);
    // The sizes are those of the profile (1 mm = 72 / 25.4 pt).
    const pt = 72 / 25.4;
    expect(leader.width).toBeCloseTo(ND30_A4_STANDARD.signatureLayout.leaderBox.widthMm * pt, 1);
    expect(seal.width).toBeCloseTo(ND30_A4_STANDARD.signatureLayout.sealBox.widthMm * pt, 1);
  });

  it('writes the moment of signing under the signature as ISO 8601 in the zone of Vietnam, inside the bytes the signature covers', async () => {
    const rendered = await renderer.render(withFields());
    const signingTime = new Date('2026-10-22T02:15:30Z');
    expect(signingTimeText(signingTime)).toBe('2026-10-22T09:15:30+07:00');
    const prepared = prepareSignature(rendered.bytes, { fieldName: 'sig_leader', signingTime, appearanceText: signingTimeText(signingTime) });
    const text = prepared.pdf.toString('latin1');
    const line = text.indexOf('(2026-10-22T09:15:30+07:00) Tj');
    expect(line).toBeGreaterThan(prepared.contentsEnd);
    expect(signedBytesOf(prepared).toString('latin1')).toContain('(2026-10-22T09:15:30+07:00) Tj');
    // The field points at the appearance, and the box of the appearance is the box of the field.
    const boxes = await widgetBoxes(prepared.pdf);
    expect(boxes.sig_leader?.width).toBeGreaterThan(0);
    expect(text.slice(prepared.contentsEnd)).toMatch(/\/AP\s*<<\s*\/N \d+ 0 R\s*>>/);
  });

  it('writes nothing under the signature when no line is asked for, and escapes the marks of a text that has parentheses', async () => {
    const rendered = await renderer.render(withFields());
    const bare = prepareSignature(rendered.bytes, { fieldName: 'sig_org', signingTime: new Date('2026-10-22T02:15:30Z') });
    expect(bare.pdf.toString('latin1').slice(rendered.bytes.length)).not.toMatch(/\/AP\s*<</);
    const marked = prepareSignature(rendered.bytes, { fieldName: 'sig_org', signingTime: new Date('2026-10-22T02:15:30Z'), appearanceText: 'seal (org) \\ ok' });
    expect(marked.pdf.toString('latin1')).toContain('(seal \\(org\\) \\\\ ok) Tj');
  });
});
