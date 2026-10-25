import type { DomainError } from '../src/errors';
import { ACCEPTANCE_COMMANDS, ACCEPTANCE_SCOPES, ACCEPTANCE_STATUSES, assertAcceptanceTransition, assertSignaturesComplete, canonicalContent, legalEffectOf, missingSigners, rolesSignableBy, scopeAccepts } from '../src/qms-acceptance';
import type { AcceptanceContent } from '../src/qms-acceptance';
import { INSPECTION_TYPES } from '../src/qms-inspection';

function refusal(work: () => unknown): DomainError {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
}

const HASH = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

describe('the quality acceptance minutes (ST-QMS-005)', () => {
  it('moves along the edges of the life of the minutes and nowhere else', () => {
    expect(assertAcceptanceTransition('sign', 'DRAFT')).toBe('SIGNING');
    expect(assertAcceptanceTransition('sign', 'SIGNING')).toBe('SIGNING');
    expect(assertAcceptanceTransition('approve', 'SIGNING')).toBe('APPROVED');
    expect(assertAcceptanceTransition('reject', 'SIGNING')).toBe('REJECTED');
    expect(assertAcceptanceTransition('revoke', 'APPROVED')).toBe('REVOKED');
    const allowed: Record<string, string[]> = { sign: ['DRAFT', 'SIGNING'], approve: ['SIGNING'], reject: ['SIGNING'], revoke: ['APPROVED'] };
    for (const command of ACCEPTANCE_COMMANDS) {
      for (const status of ACCEPTANCE_STATUSES) {
        if (allowed[command]?.includes(status)) continue;
        const error = refusal(() => assertAcceptanceTransition(command, status));
        expect(error.code).toBe('QUALITY_ACCEPTANCE_STATE_INVALID');
        expect(error.status).toBe(409);
        expect(error.extensions).toEqual({ acceptance_status: status });
      }
    }
  });

  it('drafts minutes of a scope only from the kinds of inspection that cover it, and every kind of inspection has a scope', () => {
    expect(scopeAccepts('WORK_ITEM', 'CONCEALED_WORK')).toBe(true);
    expect(scopeAccepts('WORK_ITEM', 'MATERIAL_ENTRY')).toBe(true);
    expect(scopeAccepts('STAGE', 'CONSTRUCTION_STAGE')).toBe(true);
    expect(scopeAccepts('PART', 'PART_ACCEPTANCE')).toBe(true);
    expect(scopeAccepts('COMPLETION', 'COMPLETION')).toBe(true);
    expect(scopeAccepts('COMPLETION', 'CONCEALED_WORK')).toBe(false);
    expect(scopeAccepts('STAGE', 'COMPLETION')).toBe(false);
    for (const type of INSPECTION_TYPES) expect(ACCEPTANCE_SCOPES.filter((scope) => scopeAccepts(scope, type))).toHaveLength(1);
  });

  it('gives only a digital certificate the worth of a legal electronic signature (BR-QMS-03)', () => {
    expect(legalEffectOf('IN_APP_OTP')).toBe('INTERNAL_RECORD');
    expect(legalEffectOf('IN_APP_WEBAUTHN')).toBe('INTERNAL_RECORD');
    expect(legalEffectOf('DIGITAL_CERT')).toBe('LEGAL_E_SIGNATURE');
  });

  it('AC-ST-QMS-005-1, UAT-AC360: counts a role as signed only by a signature over the hash the minutes carry, and names the roles that are missing', () => {
    const required = ['CONTRACTOR', 'SUPERVISOR', 'OWNER'] as const;
    expect(missingSigners(required, [], HASH)).toEqual(['CONTRACTOR', 'SUPERVISOR', 'OWNER']);
    const two = [
      { role: 'CONTRACTOR', contentHash: HASH },
      { role: 'SUPERVISOR', contentHash: HASH },
    ];
    expect(missingSigners(required, two, HASH)).toEqual(['OWNER']);
    const error = refusal(() => assertSignaturesComplete(required, two, HASH));
    expect(error.code).toBe('SIGNATURES_INCOMPLETE');
    expect(error.status).toBe(422);
    expect(error.extensions).toEqual({ missing_roles: ['OWNER'] });
    // A signature over other content is void.
    expect(missingSigners(required, [...two, { role: 'OWNER', contentHash: OTHER }], HASH)).toEqual(['OWNER']);
    // A signature of a role the minutes do not require does not stand in for one that is.
    expect(missingSigners(required, [...two, { role: 'DESIGNER', contentHash: HASH }], HASH)).toEqual(['OWNER']);
    expect(() => assertSignaturesComplete(required, [...two, { role: 'OWNER', contentHash: HASH }], HASH)).not.toThrow();
  });

  it('writes the same text for the same minutes whatever the order of the lists, and another text for other content (BR-QMS-02)', () => {
    const content: AcceptanceContent = {
      acceptanceId: 'qa',
      contractId: 'c',
      inspectionId: 'i',
      recordNo: 'QA-W-001',
      acceptanceScope: 'WORK_ITEM',
      documentVersionId: 'd',
      requiredRoles: ['OWNER', 'CONTRACTOR', 'SUPERVISOR'],
      inspectionResult: 'PASS',
      checklist: [
        { code: 'B', outcome: 'PASS' },
        { code: 'A', outcome: 'NA', note: 'not on this work' },
      ],
    };
    const text = canonicalContent(content);
    expect(canonicalContent({ ...content, requiredRoles: ['CONTRACTOR', 'SUPERVISOR', 'OWNER'], checklist: [...content.checklist].reverse() })).toBe(text);
    expect(JSON.parse(text)).toEqual({
      acceptance_id: 'qa',
      acceptance_scope: 'WORK_ITEM',
      checklist: [
        { code: 'A', note: 'not on this work', outcome: 'NA' },
        { code: 'B', note: null, outcome: 'PASS' },
      ],
      contract_id: 'c',
      document_version_id: 'd',
      inspection_id: 'i',
      inspection_result: 'PASS',
      record_no: 'QA-W-001',
      required_roles: ['CONTRACTOR', 'OWNER', 'SUPERVISOR'],
    });
    expect(canonicalContent({ ...content, documentVersionId: 'other' })).not.toBe(text);
    expect(canonicalContent({ ...content, checklist: [{ code: 'A' }] })).toContain('"outcome":null');
  });

  it('lets the contractor sign for the contractor only, and the staff for the side of the procuring entity (BR-QMS-05)', () => {
    const parties = ['lead', 'partner'];
    expect(rolesSignableBy({ kind: 'GUEST_CONTRACTOR', contractorId: 'lead' }, parties)).toEqual(['CONTRACTOR']);
    expect(rolesSignableBy({ kind: 'GUEST_CONTRACTOR', contractorId: 'partner' }, parties)).toEqual(['CONTRACTOR']);
    expect(rolesSignableBy({ kind: 'GUEST_CONTRACTOR', contractorId: 'stranger' }, parties)).toEqual([]);
    expect(rolesSignableBy({ kind: 'STAFF' }, parties)).toEqual(['SUPERVISOR', 'OWNER', 'DESIGNER']);
  });
});
