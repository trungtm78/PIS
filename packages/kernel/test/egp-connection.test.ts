import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DomainError } from '../src/errors';
import {
  EGP_LAYOUT_KINDS,
  EGP_LAYOUT_VERSION,
  EGP_MAPPING_MOVES,
  EGP_POSITIONS,
  assertEgpApplyAllowed,
  assertEgpLayoutKnown,
  egpConnectionMove,
  egpConnectionView,
  egpFreshnessParamsOf,
  egpKindOf,
  egpKindOfPosition,
  egpMappingMove,
  egpMappingRequestOf,
  egpReasonOf,
} from '../src/index';

const refusal = (run: () => unknown): DomainError => {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
};

const PARAMS = { max_age_hours: 168, warn_after_hours: 120, stale_severity: 'WATCH', figures_blocked_when_stale: false } as const;
const NOW = new Date('2026-11-08T03:00:00Z');

describe('the connection of the national network, switched on and off', () => {
  it('needs a reason of ten characters in both directions and refuses a move to the state it is already in', () => {
    expect(egpConnectionMove({ enabled: true }, { enabled: false, reason: '  Chờ mẫu tệp chính thức  ' })).toEqual({ enabled: false, reason: 'Chờ mẫu tệp chính thức' });
    expect(egpConnectionMove({ enabled: false }, { enabled: true, reason: 'Mẫu tệp đã được xác nhận' })).toEqual({ enabled: true, reason: 'Mẫu tệp đã được xác nhận' });
    expect(refusal(() => egpConnectionMove({ enabled: true }, { enabled: true, reason: 'Không đổi gì cả cả' })).detail).toBe('enabled');
    expect(refusal(() => egpConnectionMove({ enabled: true }, { enabled: 'no', reason: 'Không đổi gì cả cả' })).detail).toBe('enabled');
    expect(refusal(() => egpConnectionMove({ enabled: true }, { enabled: false, reason: 'ngắn' })).detail).toBe('reason');
    expect(refusal(() => egpReasonOf('x'.repeat(2001))).detail).toBe('reason');
    expect(refusal(() => egpReasonOf('một lý do\u0000có ký tự điều khiển')).detail).toBe('reason');
    expect(egpReasonOf('dòng một\ndòng hai đủ dài')).toContain('\n');
  });

  it('applies a file only while the connection is on: 409 EGP_CONNECTION_DISABLED', () => {
    expect(() => assertEgpApplyAllowed({ enabled: true })).not.toThrow();
    const error = refusal(() => assertEgpApplyAllowed({ enabled: false }));
    expect([error.code, error.status]).toEqual(['EGP_CONNECTION_DISABLED', 409]);
  });

  it('refuses a layout version it does not read and names it with the ones that exist', () => {
    expect(assertEgpLayoutKnown(undefined)).toBe(EGP_LAYOUT_VERSION);
    expect(assertEgpLayoutKnown(EGP_LAYOUT_VERSION)).toBe(EGP_LAYOUT_VERSION);
    const error = refusal(() => assertEgpLayoutKnown('OFFICIAL-2027.1'));
    expect([error.code, error.status, error.detail]).toEqual(['EGP_LAYOUT_VERSION_UNKNOWN', 422, 'mapping_version']);
    expect(error.extensions).toEqual({ layout_version: 'OFFICIAL-2027.1', supported: [EGP_LAYOUT_VERSION] });
  });

  it('knows the five kinds and their positions of the file import framework', () => {
    expect(EGP_LAYOUT_KINDS.map((kind) => EGP_POSITIONS[kind])).toEqual(['EGP_KHLCNT_FILE', 'EGP_TBMT_FILE', 'EGP_RESULT_FILE', 'EGP_CONTRACTOR_FILE', 'EGP_RESTRICTION_FILE']);
    for (const kind of EGP_LAYOUT_KINDS) expect(egpKindOfPosition(EGP_POSITIONS[kind])).toBe(kind);
    expect(egpKindOfPosition('PROCUREMENT_FILE')).toBeUndefined();
    expect(egpKindOf('TBMT')).toBe('TBMT');
    expect(refusal(() => egpKindOf('PLAN')).detail).toBe('kind');
  });

  it('shows the health with the acceptance word, the adapter that waits for the operator, and a connection that is off', () => {
    const never = egpConnectionView({ lastImportAt: null, now: NOW, params: PARAMS, enabled: true });
    expect(never.health.status).toBe('NEVER_IMPORTED');
    expect(never).toMatchObject({ acceptance: 'PENDING_EXTERNAL', mode: 'FILE_IMPORT', applyBlocked: false, apiAdapter: { status: 'MISSING', reason: 'OPERATOR_SPECIFICATION_PENDING' } });
    const stale = egpConnectionView({ lastImportAt: new Date('2026-10-30T03:00:00Z'), now: NOW, params: PARAMS, enabled: false });
    expect(stale.health).toMatchObject({ status: 'STALE', alert: { code: 'CONNECTOR_STALE', severity: 'WATCH' } });
    expect(stale.applyBlocked).toBe(true);
    const aging = egpConnectionView({ lastImportAt: new Date('2026-11-02T03:00:00Z'), now: NOW, params: PARAMS, enabled: true });
    expect(aging.health.status).toBe('AGING');
    expect(aging.health.alert).toBeNull();
  });

  it('reads the parameters of the freshness rule and refuses what is not a number or a severity', () => {
    expect(egpFreshnessParamsOf(PARAMS)).toEqual(PARAMS);
    expect(refusal(() => egpFreshnessParamsOf({ ...PARAMS, max_age_hours: '168' })).code).toBe('GOVERNANCE_RULE_PARAMS_INVALID');
    expect(refusal(() => egpFreshnessParamsOf({ ...PARAMS, stale_severity: 'LOW' })).detail).toBe('stale_severity');
    expect(refusal(() => egpFreshnessParamsOf({ ...PARAMS, figures_blocked_when_stale: 'false' })).detail).toBe('figures_blocked_when_stale');
  });
});

describe('the life of a mapping: the maker is not the approver', () => {
  const proposed = { status: 'PROPOSED', proposedBy: 'maker' } as const;

  it('has three edges: approve and reject from PROPOSED, retire from ACTIVE', () => {
    expect(Object.keys(EGP_MAPPING_MOVES)).toEqual(['APPROVE', 'REJECT', 'RETIRE']);
    expect(egpMappingMove(proposed, { move: 'APPROVE', actorId: 'checker', reason: 'Khớp theo quyết định phê duyệt số 12' })).toEqual({ to: 'ACTIVE', reason: 'Khớp theo quyết định phê duyệt số 12' });
    expect(egpMappingMove(proposed, { move: 'REJECT', actorId: 'checker', reason: 'Mã gói thầu thuộc kế hoạch khác' }).to).toBe('REJECTED');
    expect(egpMappingMove({ status: 'ACTIVE', proposedBy: 'maker' }, { move: 'RETIRE', actorId: 'checker', reason: 'Thông báo bị hủy trên hệ thống mạng' }).to).toBe('RETIRED');
  });

  it('refuses the person who proposed it as approver or rejecter: 403 SELF_APPROVAL_DENIED', () => {
    for (const move of ['APPROVE', 'REJECT'] as const) {
      const error = refusal(() => egpMappingMove(proposed, { move, actorId: 'maker', reason: 'Tôi tự duyệt đề xuất của mình' }));
      expect([error.code, error.status]).toEqual(['SELF_APPROVAL_DENIED', 403]);
    }
  });

  it('lets the person who proposed a mapping retire it once active (a correction is not an approval)', () => {
    expect(egpMappingMove({ status: 'ACTIVE', proposedBy: 'maker' }, { move: 'RETIRE', actorId: 'maker', reason: 'Nhập nhầm mã gói thầu' }).to).toBe('RETIRED');
  });

  it('refuses a move from the wrong state (409 EGP_MAPPING_STATE_INVALID) before it looks at the reason', () => {
    for (const status of ['ACTIVE', 'REJECTED', 'RETIRED'] as const) {
      const error = refusal(() => egpMappingMove({ status, proposedBy: 'maker' }, { move: 'APPROVE', actorId: 'checker', reason: '' }));
      expect([error.code, error.status]).toEqual(['EGP_MAPPING_STATE_INVALID', 409]);
    }
    expect(refusal(() => egpMappingMove({ status: 'PROPOSED', proposedBy: 'maker' }, { move: 'RETIRE', actorId: 'checker', reason: 'Mười ký tự trở lên' })).code).toBe('EGP_MAPPING_STATE_INVALID');
    expect(refusal(() => egpMappingMove({ status: 'RETIRED', proposedBy: 'maker' }, { move: 'RETIRE', actorId: 'checker', reason: 'Mười ký tự trở lên' })).code).toBe('EGP_MAPPING_STATE_INVALID');
  });

  it('refuses a decision without a reason of ten characters', () => {
    expect(refusal(() => egpMappingMove(proposed, { move: 'APPROVE', actorId: 'checker', reason: 'ok' })).detail).toBe('reason');
    expect(refusal(() => egpMappingMove(proposed, { move: 'REJECT', actorId: 'checker', reason: undefined })).detail).toBe('reason');
  });
});

describe('the request of a mapping made by hand', () => {
  const base = { subject_type: 'PACKAGE', our_code: ' GT-01 ', our_project_code: 'DA-01', external_code: ' PK-2026-0001 ', valid_from: '2026-11-01' };

  it('trims the codes and reads the days', () => {
    expect(egpMappingRequestOf(base)).toEqual({ subjectType: 'PACKAGE', ourCode: 'GT-01', ourProjectCode: 'DA-01', externalCode: 'PK-2026-0001', validFrom: '2026-11-01', validUntil: null, confidence: null, method: 'MANUAL' });
    expect(egpMappingRequestOf({ subject_type: 'CONTRACTOR', our_code: '0101234567', external_code: '0101234567' })).toMatchObject({ method: 'MANUAL', validFrom: null, ourProjectCode: null });
  });

  it('judges each field and names it', () => {
    const field = (change: Record<string, unknown>): string | undefined => refusal(() => egpMappingRequestOf({ ...base, ...change })).detail;
    expect(field({ subject_type: 'PLANET' })).toBe('subject_type');
    expect(field({ our_code: '' })).toBe('our_code');
    expect(field({ our_code: 7 })).toBe('our_code');
    expect(field({ external_code: 'x'.repeat(101) })).toBe('external_code');
    expect(field({ external_code: 'a\u0001b' })).toBe('external_code');
    expect(field({ valid_from: '2026-02-30' })).toBe('valid_from');
    expect(field({ valid_from: '01/11/2026' })).toBe('valid_from');
    expect(field({ valid_until: '2026-11-01' })).toBe('valid_until');
    expect(field({ match_method: 'IMPORT' })).toBe('match_method');
    expect(field({ confidence: 0.9 })).toBe('confidence');
  });

  it('takes a name suggestion only with a confidence in (0, 1], and never for a contractor', () => {
    expect(egpMappingRequestOf({ ...base, match_method: 'NAME_SUGGESTION', confidence: 0.91234 })).toMatchObject({ method: 'NAME_SUGGESTION', confidence: 0.912 });
    expect(refusal(() => egpMappingRequestOf({ ...base, match_method: 'NAME_SUGGESTION' })).detail).toBe('confidence');
    expect(refusal(() => egpMappingRequestOf({ ...base, match_method: 'NAME_SUGGESTION', confidence: 0 })).detail).toBe('confidence');
    expect(refusal(() => egpMappingRequestOf({ ...base, subject_type: 'CONTRACTOR', match_method: 'NAME_SUGGESTION', confidence: 0.9 })).detail).toBe('match_method');
  });
});

describe('the management of the connection opens no connection', () => {
  it('imports nothing that can reach the network', () => {
    const source = readFileSync(join(__dirname, '..', 'src', 'egp-connection.ts'), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1] as string);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) expect(specifier.startsWith('./')).toBe(true);
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });
});
