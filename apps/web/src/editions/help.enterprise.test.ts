import { describe, expect, it } from 'vitest';
import { applyHelpOverlay, helpFor, loadHelpIndex } from '../help/help-index';
import { enterpriseBundle } from './enterprise';
import enterpriseOverlay from './enterprise/overlay.vi.json';
import helpOverlay from './enterprise/help.overlay.vi.json';

// This test names the enterprise folder, so it carries `.enterprise.` in its name: the edition check lets only such tests, the loader and the folder itself do so.
// The words only the public product says (the Treasury, the Prime Minister, the Ministry and the Department of Finance, the central and local budget). An ODA loan is a real enterprise source, but only as "ODA vay lai".
const PUBLIC_ONLY = /Kho bạc|Thủ tướng|TTg|NSTW|NSĐP|NSDP|CTMTQG|Sở Tài chính|Bộ Tài chính|UBND|Cao Bằng|địa phương giao|ngân sách nhà nước|đầu tư công|\bODA\b(?! vay lại)/iu;

const textsOf = (value: unknown): string[] => (typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(textsOf) : value !== null && typeof value === 'object' ? Object.values(value).flatMap(textsOf) : []);

describe('the guides (DOC-3) and the words of the enterprise edition', () => {
  const overlay = enterpriseBundle.help?.vi;

  it('brings an overlay of the guides in Vietnamese', () => {
    expect(overlay).toBeDefined();
  });

  it('says no public-only word in any guide of any screen once the overlay is applied (the drawer shows every screen of the edition)', async () => {
    const said = applyHelpOverlay(await loadHelpIndex('vi'), overlay);
    const found = Object.entries(said.screens).flatMap(([id, entry]) => textsOf(entry).filter((text) => PUBLIC_ONLY.test(text)).map((text) => `${id}: ${text}`));
    expect(found).toEqual([]);
    expect(textsOf(said.tips).concat(textsOf(said.kinds)).filter((text) => PUBLIC_ONLY.test(text))).toEqual([]);
  });

  it('would see the public words in the base file (the scan can fail)', async () => {
    const base = await loadHelpIndex('vi');
    expect(Object.values(base.screens).some((entry) => textsOf(entry).some((text) => PUBLIC_ONLY.test(text)))).toBe(true);
  });

  it('gives the capital screens (HOME-07, PRJ-01) the enterprise reading', async () => {
    const said = applyHelpOverlay(await loadHelpIndex('vi'), overlay);
    expect(helpFor(said, 'HOME-07')?.fields).toEqual(expect.arrayContaining(['Vốn chủ sở hữu', 'Vốn vay']));
    expect(helpFor(said, 'PRJ-01')?.audience).toBe('Chủ đầu tư và Phòng Tài chính - Kế toán');
  });

  it('keeps every screen and its fields (the overlay says the same guide, it drops nothing)', async () => {
    const base = await loadHelpIndex('vi');
    const said = applyHelpOverlay(base, overlay);
    expect(Object.keys(said.screens)).toEqual(Object.keys(base.screens));
    for (const [id, entry] of Object.entries(base.screens)) {
      expect(said.screens[id]?.fields.length, id).toBe(helpOverlay.screens[id as keyof typeof helpOverlay.screens]?.fields.length ?? entry.fields.length);
      expect(said.screens[id]?.title.length, id).toBeGreaterThan(0);
    }
  });

  it('names no public-only word in the terminology overlay of the screens either', () => {
    expect(textsOf(enterpriseOverlay).filter((text) => PUBLIC_ONLY.test(text))).toEqual([]);
  });
});
