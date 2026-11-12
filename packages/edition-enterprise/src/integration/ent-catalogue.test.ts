import { DomainError, builtInDefault, builtInPack, describeRuleType, isGovernanceRuleType, registerAllGovernanceRules, validateRuleParams } from '@machvon/kernel';
import type { GovernanceRuleVersion } from '@machvon/kernel';
import { editionBaselines, packDigest } from '@machvon/db';
import {
  CATALOGUE_RULE_TYPES,
  LEGAL_DOC_TYPE_RULE,
  MILESTONE_RULE,
  MILESTONE_SEEDS,
  PROJECT_TYPE_RULE,
  assertMilestonesInOrder,
  catalogueProblems,
  enterpriseProjectTypeEntries,
  enterpriseProjectTypePack,
  legalDocTypesOf,
  milestonesOf,
  milestonesOfResolved,
  registerEnterpriseCatalogueRules,
  startFlagOf,
} from './ent-catalogue.ts';

const DAY = '2026-11-09';

const version = (type: string, code: string, params: Record<string, unknown>, extra: Partial<GovernanceRuleVersion> = {}): GovernanceRuleVersion => ({
  id: `00000000-0000-4000-8000-${String(Math.abs(code.length * 7919)).padStart(12, '0')}`,
  type,
  code,
  version: 1,
  status: 'APPROVED',
  params,
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  unitId: null,
  ...extra,
});

const fails = (run: () => unknown, field: string): void => {
  try {
    run();
  } catch (failure) {
    expect(failure).toBeInstanceOf(DomainError);
    expect(failure).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: field });
    return;
  }
  throw new Error(`expected a refusal naming ${field}`);
};

describe('the catalogues of the enterprise project register (ENT-3e, MD.01, MD.02)', () => {
  beforeAll(() => {
    registerAllGovernanceRules();
    registerEnterpriseCatalogueRules();
  });

  it('registers four rule types once, each flagged unverified with a formula and a source', () => {
    expect(() => registerEnterpriseCatalogueRules()).not.toThrow();
    for (const type of CATALOGUE_RULE_TYPES) {
      expect(isGovernanceRuleType(type)).toBe(true);
      const described = describeRuleType(type);
      expect(described.formula.length).toBeGreaterThan(20);
      expect(described.source.length).toBeGreaterThan(10);
      expect(described.codes.length).toBeGreaterThan(0);
      for (const entry of described.codes) expect(entry.unverified).toBe(true);
    }
  });

  it('holds the three kinds of project, the two flags, the eight milestones of the investment life and the document types', () => {
    expect(describeRuleType(PROJECT_TYPE_RULE).codes.map((one) => one.code)).toEqual(['CAPEX_CONSTRUCTION', 'EQUIPMENT_PROCUREMENT', 'MAJOR_REPAIR']);
    expect(describeRuleType('ENT_START_FLAG').codes.map((one) => one.code)).toEqual(['NEW_START', 'CONTINUING']);
    expect(MILESTONE_SEEDS.map((one) => one.code)).toEqual([
      'INVESTMENT_POLICY',
      'INVESTMENT_CERTIFICATE',
      'FS_APPROVAL',
      'TMDT_APPROVAL',
      'CONTRACTOR_SELECTION_PLAN',
      'GROUNDBREAKING',
      'ACCEPTANCE',
      'FINAL_SETTLEMENT',
    ]);
    const kinds = legalDocTypesOf([], DAY).map((one) => one.code);
    for (const kind of ['GROUP_RESOLUTION', 'GROUP_DECISION', 'COMPANY_RESOLUTION', 'COMPANY_DECISION']) expect(kinds).toContain(kind);
  });

  it('the built-in entries are sound as a set and the milestones come in the order of their sequence', () => {
    const milestones = milestonesOf([], DAY);
    expect(milestones.map((one) => one.sequence)).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
    expect(catalogueProblems({ milestones, legalDocTypes: legalDocTypesOf([], DAY) })).toEqual([]);
  });

  it('every kind of decision the enterprise funding pack binds to an origin is a document type of the catalogue that assigns capital, issued by the right level', () => {
    const types = legalDocTypesOf([], DAY);
    const pack = builtInPack('ENTERPRISE');
    for (const [origin, kinds] of pack.originDecisions) {
      for (const kind of kinds) {
        const found = types.find((one) => one.code === kind);
        expect(found).toBeDefined();
        expect(found?.purpose).toBe('CAPITAL_ASSIGNMENT');
        if (origin === 'GROUP_ASSIGNED') expect(found?.issuer).toBe('GROUP');
        if (origin === 'BOARD_APPROVED') expect(found?.issuer).toBe('COMPANY');
      }
    }
  });

  it('a tenant can add an entry by an approved rule; a draft governs nothing; a retired rule falls back to the built-in entry', () => {
    const own = version(MILESTONE_RULE, 'ENVIRONMENT_PERMIT', { label: 'Permit', sequence: 35, phase: 'APPROVAL', evidence_kinds: ['FS_APPROVAL_DECISION'], required: false });
    expect(milestonesOfResolved([{ code: 'B', params: { label: 'b', sequence: 20, phase: 'EXECUTION', evidence_kinds: ['X'], required: false } }, { code: 'A', params: { label: 'a', sequence: 20, phase: 'EXECUTION', evidence_kinds: ['X'], required: true } }, { code: 'C', params: { label: 'c', sequence: 5, phase: 'PREPARATION', evidence_kinds: ['X'], required: true } }]).map((one) => [one.code, one.required])).toEqual([['C', true], ['A', true], ['B', false]]);
    expect(milestonesOf([own], DAY).map((one) => one.code)).toContain('ENVIRONMENT_PERMIT');
    expect(milestonesOf([own], DAY).findIndex((one) => one.code === 'ENVIRONMENT_PERMIT')).toBe(3);
    expect(milestonesOf([{ ...own, status: 'SUBMITTED' }], DAY).map((one) => one.code)).not.toContain('ENVIRONMENT_PERMIT');
    const retiredBuiltIn = version(LEGAL_DOC_TYPE_RULE, 'GROUP_DECISION', { label: 'x', issuer: 'GROUP', purpose: 'CAPITAL_ASSIGNMENT' }, { status: 'RETIRED', effectiveTo: '2026-06-01' });
    expect(legalDocTypesOf([retiredBuiltIn], DAY).map((one) => one.code)).toContain('GROUP_DECISION');
  });

  it('the judgement across entries finds the faults a single rule cannot: a repeated sequence, evidence that does not exist, evidence that assigns capital', () => {
    const milestones = milestonesOf([], DAY);
    const types = legalDocTypesOf([], DAY);
    const repeated = [...milestones, { ...(milestones[0] as (typeof milestones)[number]), code: 'DUPLICATE' }];
    expect(catalogueProblems({ milestones: repeated, legalDocTypes: types })).toEqual(['SEQUENCE_REPEATED:DUPLICATE']);
    const unknown = [{ ...(milestones[0] as (typeof milestones)[number]), evidenceKinds: ['NOTHING'] }];
    expect(catalogueProblems({ milestones: unknown, legalDocTypes: types })).toEqual(['EVIDENCE_UNKNOWN:INVESTMENT_POLICY:NOTHING']);
    const capital = [{ ...(milestones[0] as (typeof milestones)[number]), evidenceKinds: ['GROUP_DECISION'] }];
    expect(catalogueProblems({ milestones: capital, legalDocTypes: types })).toEqual(['EVIDENCE_NOT_EVIDENCE:INVESTMENT_POLICY:GROUP_DECISION']);
  });

  it('the schema refuses what it should', () => {
    expect(() => validateRuleParams(PROJECT_TYPE_RULE, { label: 'x', kind: 'OTHER_KIND', master_key: 'K' })).toThrow(DomainError);
    expect(() => validateRuleParams(MILESTONE_RULE, { label: 'x', sequence: 0, phase: 'APPROVAL', evidence_kinds: ['A1'], required: true })).toThrow(DomainError);
    expect(() => validateRuleParams(MILESTONE_RULE, { label: 'x', sequence: 5, phase: 'APPROVAL', evidence_kinds: [], required: true })).toThrow(DomainError);
    expect(() => validateRuleParams(LEGAL_DOC_TYPE_RULE, { label: 'x', issuer: 'COMPANY', purpose: 'CAPITAL_ASSIGNMENT', extra: 1 })).toThrow(DomainError);
    expect(builtInDefault(PROJECT_TYPE_RULE, 'MAJOR_REPAIR')?.params.kind).toBe('MAJOR_REPAIR');
  });

  describe('the flag of the stage in a plan year', () => {
    it('is new start in the year of the start, continuing after it, none before it or without a start', () => {
      expect(startFlagOf({ startYear: 2026, planYear: 2026 })).toBe('NEW_START');
      expect(startFlagOf({ startYear: 2024, planYear: 2026 })).toBe('CONTINUING');
      expect(startFlagOf({ startYear: 2027, planYear: 2026 })).toBeNull();
      expect(startFlagOf({ startYear: null, planYear: 2026 })).toBeNull();
    });
  });

  describe('the order of the milestones a project reached', () => {
    const catalogue = milestonesOf([], DAY);

    it('accepts dates that follow the sequence, with gaps, and the same day', () => {
      expect(() => assertMilestonesInOrder(catalogue, [])).not.toThrow();
      expect(() =>
        assertMilestonesInOrder(catalogue, [
          { code: 'FS_APPROVAL', on: '2025-03-01' },
          { code: 'INVESTMENT_POLICY', on: '2024-12-01' },
          { code: 'TMDT_APPROVAL', on: '2025-03-01' },
        ]),
      ).not.toThrow();
    });

    it('refuses a later milestone dated before an earlier one, and a code the catalogue does not hold', () => {
      fails(
        () =>
          assertMilestonesInOrder(catalogue, [
            { code: 'GROUNDBREAKING', on: '2025-01-01' },
            { code: 'FS_APPROVAL', on: '2025-06-01' },
          ]),
        'milestone',
      );
      fails(() => assertMilestonesInOrder(catalogue, [{ code: 'NOWHERE', on: '2025-01-01' }]), 'milestone');
    });
  });

  describe('the project types in the master catalogue', () => {
    it('are published as PROJECT_TYPE entries of a signed pack that the baseline job applies in an enterprise process', () => {
      const entries = enterpriseProjectTypeEntries();
      expect(entries.map((one) => one.businessKey)).toEqual(['ENT_CAPEX_CONSTRUCTION', 'ENT_EQUIPMENT_PROCUREMENT', 'ENT_MAJOR_REPAIR']);
      expect(entries.map((one) => one.attributes.kind)).toEqual(['CAPITAL_WORKS', 'PROCUREMENT', 'MAJOR_REPAIR']);
      const pack = enterpriseProjectTypePack();
      expect(pack.sha256).toBe(packDigest(entries));
      expect(enterpriseProjectTypePack().id).toBe(pack.id);
      expect(editionBaselines().map((one) => one.id)).toContain(pack.id);
    });
  });
});
