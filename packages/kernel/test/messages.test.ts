import { message, messagesUnder } from '../src/messages.ts';

describe('kernel messages', () => {
  it('reads a text by its key and fills the places in one pass', () => {
    expect(message('dgv.recon.basis')).toBe('VND, ngày Kho bạc thanh toán');
    expect(message('bi.export.title', { code: 'RATE_{x}' })).toBe('Xuất số liệu RATE_{x}');
    expect(message('bi.export.header.metric_value', { code: 'M', revision: 3, unit: 'pct' })).toBe('M (bản 3, pct)');
  });

  it('fails loudly on an unknown key or a place without a value', () => {
    expect(() => message('no.such.key')).toThrow('no text for no.such.key');
    expect(() => message('bi.export.title')).toThrow('bi.export.title needs code');
  });

  it('lists the texts of a family by their suffix', () => {
    const dimensions = messagesUnder('bi.export.dimension');
    expect(Object.keys(dimensions)).toEqual(['unit', 'project', 'fund_source', 'budget_level', 'bucket']);
    expect(dimensions.unit).toBe('Đơn vị');
    expect(messagesUnder('no.such.family')).toEqual({});
  });

  it('writes a day in a text of the screens of HOME as dd/mm/yyyy and leaves the files of an export in ISO', () => {
    expect(message('home.source.prc.step.due', { date: '2026-09-03' })).toBe('Hạn bước 03/09/2026');
    expect(message('home.source.prc.step.due', { date: 'hôm qua' })).toBe('Hạn bước hôm qua');
    expect(message('bi.export.title', { code: '2026-09-03' })).toBe('Xuất số liệu 2026-09-03');
  });
});
