import {
  DIRECT_MATCH_FALLBACK,
  EBS_PROJECT_CODE,
  EBS_CODE_SYSTEM,
  ENTERPRISE_SYSTEM_SEEDS,
  HPM_PROJECT_CODE,
  HPM_CODE_SYSTEM,
  coverageOf,
  holdsOn,
  isEnterpriseCodeSystem,
  resolveInbound,
  resolveOutbound,
  shadowedProject,
} from './project-codes.ts';
import type { CodeMapping } from './project-codes.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const DAY = '2026-11-09';

const mapping = (projectId: string, externalCode: string, extra: Partial<CodeMapping> = {}): CodeMapping => ({
  projectId,
  sourceSystem: EBS_CODE_SYSTEM,
  externalCode,
  validFrom: '2026-01-01',
  validUntil: null,
  status: 'ACTIVE',
  ...extra,
});

describe('the code of a project in EBS and in HPM (ENT-3e, MD.01, TH.03)', () => {
  it('names the two pairs of system and type on the rails of INT-1', () => {
    expect(EBS_PROJECT_CODE).toEqual({ sourceSystem: 'ORACLE_EBS', externalType: 'PROJECT_CODE' });
    expect(HPM_PROJECT_CODE).toEqual({ sourceSystem: 'HPM', externalType: 'PROJECT_CODE' });
    expect(isEnterpriseCodeSystem('ORACLE_EBS')).toBe(true);
    expect(isEnterpriseCodeSystem('SAP')).toBe(false);
    expect(ENTERPRISE_SYSTEM_SEEDS.map((one) => one.code)).toEqual(['ORACLE_EBS', 'HPM']);
    for (const seed of ENTERPRISE_SYSTEM_SEEDS) expect(new RegExp(`^(?:${seed.codePattern})$`).test('PRJ-2026.001/A')).toBe(true);
  });

  it('a mapping holds on the days of its range only and only while ACTIVE', () => {
    expect(holdsOn(mapping(A, 'X'), DAY)).toBe(true);
    expect(holdsOn(mapping(A, 'X', { validFrom: '2026-11-10' }), DAY)).toBe(false);
    expect(holdsOn(mapping(A, 'X', { validUntil: DAY }), DAY)).toBe(false);
    expect(holdsOn(mapping(A, 'X', { validUntil: '2026-11-10' }), DAY)).toBe(true);
    for (const status of ['PROPOSED', 'REJECTED', 'RETIRED'] as const) expect(holdsOn(mapping(A, 'X', { status }), DAY)).toBe(false);
  });

  describe('inbound: the code of EBS to a project of ours', () => {
    const read = (mappings: CodeMapping[], externalCode: string, directProjectId: string | null, options?: { directFallback?: boolean }) =>
      resolveInbound({ mappings, sourceSystem: EBS_CODE_SYSTEM, externalCode, day: DAY, directProjectId }, options);

    it('the crosswalk is the way', () => {
      expect(read([mapping(A, 'EBS-9')], 'EBS-9', null)).toEqual({ projectId: A, via: 'CROSSWALK', shadowsDirect: false });
    });

    it('a code that was read by direct match is read the same way while the fallback lasts (regression of the reconciled imports)', () => {
      expect(DIRECT_MATCH_FALLBACK).toBe(true);
      expect(read([], 'EBS-P001', B)).toEqual({ projectId: B, via: 'DIRECT', shadowsDirect: false });
      expect(read([mapping(A, 'OTHER')], 'EBS-P001', B)).toEqual({ projectId: B, via: 'DIRECT', shadowsDirect: false });
    });

    it('with both, the crosswalk wins and the answer says it shadowed the direct reading; with the same project there is no shadow', () => {
      expect(read([mapping(A, 'EBS-P001')], 'EBS-P001', B)).toEqual({ projectId: A, via: 'CROSSWALK', shadowsDirect: true });
      expect(read([mapping(A, 'EBS-P001')], 'EBS-P001', A)).toEqual({ projectId: A, via: 'CROSSWALK', shadowsDirect: false });
    });

    it('a code nobody holds stays unknown, as before', () => {
      expect(read([], 'NOBODY', null)).toEqual({ projectId: null, via: null, shadowsDirect: false });
    });

    it('a mapping of another system, a retired one or one that has ended is not a way; the direct reading answers instead', () => {
      expect(read([mapping(A, 'EBS-P001', { sourceSystem: HPM_CODE_SYSTEM })], 'EBS-P001', B).via).toBe('DIRECT');
      expect(read([mapping(A, 'EBS-P001', { status: 'RETIRED' })], 'EBS-P001', null).via).toBeNull();
      expect(read([mapping(A, 'EBS-P001', { validUntil: '2026-06-01' })], 'EBS-P001', null).via).toBeNull();
    });

    it('after the contract step the direct match is no longer a way', () => {
      expect(read([], 'EBS-P001', B, { directFallback: false })).toEqual({ projectId: null, via: null, shadowsDirect: false });
      expect(read([mapping(A, 'EBS-P001')], 'EBS-P001', B, { directFallback: false }).via).toBe('CROSSWALK');
    });
  });

  describe('outbound: the code of a project of ours in HPM', () => {
    const send = (mappings: CodeMapping[], options?: { directFallback?: boolean }) => resolveOutbound({ mappings, sourceSystem: HPM_CODE_SYSTEM, projectId: A, ourCode: 'PRJ-001', day: DAY }, options);

    it('goes under its mapped code', () => {
      expect(send([mapping(A, 'HPM-77', { sourceSystem: HPM_CODE_SYSTEM })])).toEqual({ code: 'HPM-77', via: 'CROSSWALK' });
    });

    it('goes under its own code, flagged, while the fallback lasts, and under none after it', () => {
      expect(send([])).toEqual({ code: 'PRJ-001', via: 'DIRECT' });
      expect(send([mapping(A, 'EBS-77')])).toEqual({ code: 'PRJ-001', via: 'DIRECT' });
      expect(send([], { directFallback: false })).toEqual({ code: '', via: 'UNMAPPED' });
    });
  });

  it('a mapping may not shadow the direct reading of another project', () => {
    expect(shadowedProject({ externalCode: 'P-1', projectId: A, directProjectId: B })).toBe(B);
    expect(shadowedProject({ externalCode: 'P-1', projectId: A, directProjectId: A })).toBeNull();
    expect(shadowedProject({ externalCode: 'P-1', projectId: A, directProjectId: null })).toBeNull();
  });

  describe('coverage', () => {
    const projects = [
      { id: A, code: 'PRJ-A' },
      { id: B, code: 'PRJ-B' },
      { id: C, code: 'PRJ-C' },
    ];

    it('counts what is mapped, what only the fallback serves, what waits and what shadows', () => {
      const mappings = [mapping(A, 'E-A'), mapping(B, 'PRJ-C'), mapping(C, 'E-C', { status: 'PROPOSED' })];
      expect(coverageOf({ projects, mappings, sourceSystem: EBS_CODE_SYSTEM, day: DAY })).toEqual({ projects: 3, mapped: 2, directOnly: 1, unmapped: 0, proposed: 1, shadows: 1 });
    });

    it('after the contract step the same figures call the rest unmapped', () => {
      expect(coverageOf({ projects, mappings: [mapping(A, 'E-A')], sourceSystem: EBS_CODE_SYSTEM, day: DAY }, { directFallback: false })).toEqual({ projects: 3, mapped: 1, directOnly: 0, unmapped: 2, proposed: 0, shadows: 0 });
    });

    it('one system never counts the mappings of the other', () => {
      expect(coverageOf({ projects, mappings: [mapping(A, 'H-A', { sourceSystem: HPM_CODE_SYSTEM })], sourceSystem: EBS_CODE_SYSTEM, day: DAY }).mapped).toBe(0);
    });
  });
});
