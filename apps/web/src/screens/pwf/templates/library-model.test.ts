import { describe, expect, it } from 'vitest';
import { toResolved, toVersion } from '../../adm/governance/model';
import { effectiveBody, version } from '../../adm/governance/test/fixtures';
import type { CodeEntry, Resolved, RuleVersion } from '../../adm/governance/model';
import { templateParams } from '../test/fixtures';
import { DEFAULT_SIDE, compareSides, libraryRow, libraryTotals, statusCountsOf } from './library-model';

const codeEntry = (over: Partial<CodeEntry> = {}): CodeEntry => ({ code: 'PUBLIC_REPAIR', hasDefault: true, unverified: false, provenance: null, storedVersions: 0, inForce: 'DEFAULT', inForceVersion: 0, ...over });
const stored = (n: number, over: Record<string, unknown> = {}): RuleVersion => toVersion(version(n, { rule_type: 'PROJECT_WORKFLOW_TEMPLATE', code: 'PUBLIC_REPAIR', params: templateParams(), ...over })) as RuleVersion;
const effective = (over: Record<string, unknown> = {}): Resolved => toResolved(effectiveBody({ rule_type: 'PROJECT_WORKFLOW_TEMPLATE', code: 'PUBLIC_REPAIR', params: templateParams(), ...over })) as Resolved;

describe('library model', () => {
  it('counts the versions by status', () => {
    expect(statusCountsOf([stored(1, { status: 'APPROVED' }), stored(2, { status: 'DRAFT' }), stored(3, { status: 'DRAFT' })])).toEqual({ DRAFT: 2, SUBMITTED: 0, APPROVED: 1, RETIRED: 0 });
  });

  it('makes a row of a code governed by a rule of the tenant: the day it begins and its size come from the version in force', () => {
    const versions = [stored(2, { status: 'APPROVED', effective_from: '2026-12-01' }), stored(1, { status: 'RETIRED', effective_from: '2026-01-01' })];
    const row = libraryRow(codeEntry({ inForce: 'RULE', inForceVersion: 2 }), versions, effective({ version: 2, source: 'RULE' }));
    expect(row).toMatchObject({ code: 'PUBLIC_REPAIR', force: 'RULE', forceVersion: 2, effectiveFrom: '2026-12-01', unverified: false });
    expect(row.summary).toEqual({ name: 'Đầu tư công: xây dựng', projectType: 'CONSTRUCTION', phases: 1, tasks: 2 });
    expect(row.statusCounts.RETIRED).toBe(1);
  });

  it('makes a row of a code that only has the template that ships with the platform: no day, and the unconfirmed flag', () => {
    const row = libraryRow(codeEntry({ unverified: true }), [], effective({ source: 'DEFAULT', version: 0, rule_id: null }));
    expect(row).toMatchObject({ force: 'DEFAULT', effectiveFrom: null, unverified: true, versions: [] });
  });

  it('flags a row unconfirmed when the rule in force says so even though the catalogue does not', () => {
    expect(libraryRow(codeEntry(), [], effective({ unverified: true })).unverified).toBe(true);
  });

  it('falls back to the newest version when nothing is in force, and to nothing when there is nothing at all', () => {
    const draft = libraryRow(codeEntry({ hasDefault: false, inForce: 'NONE' }), [stored(1)], null);
    expect(draft.force).toBe('NONE');
    expect(draft.summary?.tasks).toBe(2);
    expect(libraryRow(codeEntry({ inForce: 'NONE' }), [], null).summary).toBeNull();
  });

  it('totals the templates, those a rule governs and those unconfirmed', () => {
    const rows = [libraryRow(codeEntry({ unverified: true }), [], effective({ source: 'DEFAULT' })), libraryRow(codeEntry({ code: 'B' }), [stored(1)], effective({ version: 1 }))];
    expect(libraryTotals(rows)).toEqual({ templates: 2, governed: 1, unverified: 1 });
  });

  it('offers every version and the shipped template (only when it is what governs the code) to compare', () => {
    const versions = [stored(1)];
    expect(compareSides(versions, effective({ source: 'DEFAULT', rule_id: null, version: 0 })).map((side) => [side.id === DEFAULT_SIDE ? 'default' : side.version, side.status])).toEqual([
      [1, 'DRAFT'],
      ['default', 'DEFAULT'],
    ]);
    expect(compareSides(versions, effective({ source: 'RULE' }))).toHaveLength(1);
    expect(compareSides(versions, null)).toHaveLength(1);
  });
});
