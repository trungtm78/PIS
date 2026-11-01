import { describe, expect, it } from 'vitest';
import { issue } from '../test-support';
import { AUTOMATIC_SOURCES, NO_FILTER, categoriesOf, countBySource, filterIssues, mayRead, sourceLink, toSourceIssue } from './model';
import type { SourceIssue } from './model';

const REF = '00000000-0000-4000-8000-0000000000aa';
const from = (n: number, overrides: Record<string, unknown> = {}): SourceIssue => toSourceIssue(issue(n, { source_module: 'PMT', source_ref_id: REF, ...overrides })) as SourceIssue;

describe('ISS-11 model', () => {
  it('reads an issue of another module with the object it names and nothing a person wrote', () => {
    const row = from(1, { title: 'Nguyễn Văn Hộ khiếu nại', assignee: { membership_id: 'x', display_name: 'Trần Thị B' }, category_label: 'Giấy phép' });
    expect(row).toEqual({
      id: '00000000-0000-4000-8000-a20000000001',
      code: 'VM-2026-000001',
      source: 'PMT',
      sourceRefId: REF,
      categoryLabel: 'Giấy phép',
      severity: 'HIGH',
      status: 'OPEN',
      projectCode: 'DA-2026-001',
      ownerUnitName: 'Ủy ban nhân dân 1',
      dueAt: '2999-01-01T10:00:00.000Z',
      overdueDays: null,
    });
    expect(JSON.stringify(row)).not.toContain('Nguyễn Văn Hộ');
    expect(JSON.stringify(row)).not.toContain('Trần Thị B');
  });

  it('leaves out a manual issue and a row that is not an issue; a guest gets no object', () => {
    expect(toSourceIssue(issue(1))).toBeUndefined();
    expect(toSourceIssue({ id: 'x' })).toBeUndefined();
    expect(from(2, { source_ref_id: null }).sourceRefId).toBeNull();
    expect(from(3, { source_ref_id: '' }).sourceRefId).toBeNull();
  });

  it('links a permit to PMT-02 by the parameter it reads, and links no other source, whose reference is not the object the screen opens', () => {
    expect(sourceLink({ source: 'PMT', sourceRefId: REF })).toBe(`/pmt/pmt-02?permit=${REF}`);
    for (const source of ['LND', 'QMS', 'AST', 'PAY', 'CTR', 'AUD'] as const) expect(sourceLink({ source, sourceRefId: REF })).toBeUndefined();
    expect(sourceLink({ source: 'PMT', sourceRefId: null })).toBeUndefined();
  });

  it('filters by source and by category, counts by source and lists the categories once', () => {
    const list = [from(1), from(2, { source_module: 'QMS', category_label: 'Chất lượng' }), from(3, { source_module: 'QMS', category_label: 'Chất lượng' }), from(4, { category_label: '' })];
    expect(filterIssues(list, NO_FILTER)).toHaveLength(4);
    expect(filterIssues(list, { source: 'QMS', category: '' }).map((row) => row.code)).toEqual(['VM-2026-000002', 'VM-2026-000003']);
    expect(filterIssues(list, { source: 'QMS', category: 'Giải phóng' })).toEqual([]);
    expect(filterIssues(list, { source: '', category: 'Chất lượng' })).toHaveLength(2);
    expect(countBySource(list)).toEqual([
      { source: 'PMT', count: 2 },
      { source: 'QMS', count: 2 },
    ]);
    expect(categoriesOf(list)).toEqual(['Chất lượng', 'Giải phóng mặt bằng 1']);
    expect(AUTOMATIC_SOURCES).not.toContain('MANUAL');
  });

  it('asks for the read permission, or reads while the permissions are not known', () => {
    expect(mayRead(undefined)).toBe(true);
    expect(mayRead(['issue.read'])).toBe(true);
    expect(mayRead(['issue.create'])).toBe(false);
  });
});
