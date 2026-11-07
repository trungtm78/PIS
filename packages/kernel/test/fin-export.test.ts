import { csvOf, xlsxOf } from '../src/dis-export';
import { buildReport, FIN_DEFAULT_SCENARIOS, reportHash } from '../src/fin-analysis';
import type { FinModelInput } from '../src/fin-analysis';
import { scoreCriteria } from '../src/fin-criteria';
import { finExportDocument } from '../src/fin-export';
import type { FinExportInput } from '../src/fin-export';

const model: FinModelInput = {
  periodUnit: 'YEAR',
  discountRatePct: '10',
  convention: 'END',
  lines: [{ period: 0, capex: '1000' }, { period: 1, benefit: '300' }, { period: 2, benefit: '400' }, { period: 3, benefit: '500' }, { period: 4, benefit: '600' }],
};
const safe: FinModelInput = model;

function input(status: FinExportInput['status'], overrides: Partial<FinExportInput> = {}): FinExportInput {
  const report = buildReport({ model: safe, scenarios: [...FIN_DEFAULT_SCENARIOS] });
  return {
    code: 'FIN-2026-0001',
    revision: 2,
    title: 'Cải tạo hệ thống chiếu sáng',
    status,
    kind: 'FINANCIAL',
    ownerUnit: 'Ban QLDA 1',
    link: 'DA-001',
    currencyUnit: 'VND',
    computedAt: '2026-11-08T03:00:00.000Z',
    inputsHash: 'a'.repeat(64),
    resultHash: reportHash(report),
    formulaVersion: report.formulaVersion,
    approvedBy: 'Nguyễn Văn B',
    approvedAt: '2026-11-08T04:00:00.000Z',
    assumptions: [{ key: 'DISCOUNT_RATE', value: '10', unit: '%', sourceKind: 'DOCUMENT', source: 'Quyết định 123/QĐ-UBND', owner: 'Phòng Tài chính' }],
    report,
    criteria: scoreCriteria({ category: 'SAFETY', criteria: [{ key: 'one_a', label: 'Một', weightPct: '60' }, { key: 'two_b', label: 'Hai', weightPct: '40' }] }, [{ key: 'one_a', score: 4, evidence: 'Biên bản' }, { key: 'two_b', score: 5, evidence: 'Báo cáo' }]),
    ...overrides,
  };
}

describe('the export of an appraisal for cross-checking (KT.02)', () => {
  it('carries the inputs, the sources, the formulas, the table of the cash flow and the fingerprint', () => {
    const document = finExportDocument(input('APPROVED'));
    const sections = new Set(document.rows.map((row) => row[0]));
    for (const section of ['THAM SỐ', 'DÒNG TIỀN NHẬP', 'GIẢ ĐỊNH ĐẦU VÀO', 'KỊCH BẢN', 'KẾT QUẢ', 'ĐẦU VÀO CỦA KẾT QUẢ', 'GIẢ ĐỊNH CỦA CÔNG THỨC', 'BẢNG DÒNG TIỀN', 'KỊCH BẢN: KẾT QUẢ', 'ĐỘ NHẠY MỘT CHIỀU', 'ĐỘ NHẠY HAI CHIỀU', 'TORNADO', 'GIÁ TRỊ CHUYỂN ĐỔI', 'TỔNG CHI PHÍ SỞ HỮU', 'TIÊU CHÍ PHI TÀI CHÍNH']) expect(sections).toContain(section);
    const npv = document.rows.find((row) => row[0] === 'KẾT QUẢ' && row[1] === 'NPV');
    expect(npv?.[3]).toBe('388.77');
    expect(npv?.[5]).toContain('NPV = Σ CF(t) / (1 + r)^t');
    expect(document.rows.find((row) => row[0] === 'GIẢ ĐỊNH ĐẦU VÀO')?.[5]).toContain('Quyết định 123/QĐ-UBND');
    expect(document.header.map((entry) => entry.key)).toEqual(expect.arrayContaining(['code', 'inputs_hash', 'result_hash', 'formula_version', 'approved_by']));
    expect(document.header.find((entry) => entry.key === 'code')?.value).toBe('FIN-2026-0001 (phiên bản 2)');
    expect(document.notice).toContain('đã đóng băng');
    // the value column carries numbers only, so that it is not turned into text by the spreadsheet guard
    for (const row of document.rows) expect(row[3]).toMatch(/^(-?\d+(\.\d+)?)?$/);
  });

  it('says plainly that a draft is not a basis for a decision, and leaves out the approver', () => {
    const document = finExportDocument(input('DRAFT'));
    expect(document.notice).toContain('Bản nháp');
    expect(document.header.map((entry) => entry.key)).not.toContain('approved_by');
    expect(finExportDocument(input('DRAFT', { link: null })).header.map((entry) => entry.key)).not.toContain('link');
  });

  it('is the same file for the same appraisal, and a negative number stays a number in the CSV', () => {
    const one = csvOf(finExportDocument(input('APPROVED')));
    const two = csvOf(finExportDocument(input('APPROVED')));
    expect(one).toBe(two);
    expect(one.startsWith('﻿')).toBe(true);
    expect(one).toContain('KẾT QUẢ,NPV,Giá trị hiện tại ròng,388.77,VND');
    expect(one).toMatch(/Lũy kế dòng tiền ròng,-1000\.00,VND/);
    expect(one).toContain('result_hash');
    const book = xlsxOf(finExportDocument(input('APPROVED')));
    expect(Buffer.from(book).subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('writes the reason in words where a measure does not apply', () => {
    const report = buildReport({ model: { ...safe, lines: [{ period: 0, capex: '100' }, { period: 1, opex: '50' }] }, scenarios: [] });
    const document = finExportDocument(input('DRAFT', { report, criteria: null, resultHash: reportHash(report) }));
    const irr = document.rows.find((row) => row[0] === 'KẾT QUẢ' && row[1] === 'IRR');
    expect(irr?.[3]).toBe('');
    expect(irr?.[5]).toContain('không đổi dấu');
    expect(document.rows.some((row) => row[0] === 'TIÊU CHÍ PHI TÀI CHÍNH')).toBe(false);
  });
});
