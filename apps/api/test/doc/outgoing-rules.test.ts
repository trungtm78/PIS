import { DomainError } from '@machvon/kernel';
import {
  REVIEW_CHECKLIST,
  checklistFailures,
  formatCheckFailed,
  normaliseRecipients,
  normalisedPayload,
  payloadWithBlocks,
  readinessFailures,
  recipientNames,
  stateSecretDeclaration,
  storedChecklist,
} from '../../src/modules/doc/outgoing-rules';

const UNIT = '0A1B2C3D-0000-4000-8000-00000000AAAA';

function codeOf(work: () => unknown): { code: string; detail: string | undefined } {
  try {
    work();
  } catch (error) {
    if (error instanceof DomainError) return { code: error.code, detail: error.detail };
    throw error;
  }
  throw new Error('expected a DomainError');
}

describe('the rules of an outgoing draft (BR-DOC-11, BR-DOC-13, BR-DOC-20)', () => {
  describe('stateSecretDeclaration', () => {
    it('finds a declared level in any spelling, case and nesting, and names the path', () => {
      expect(stateSecretDeclaration({ secrecy_level: 'Tuyệt  MẬT' })).toBe('payload.secrecy_level');
      expect(stateSecretDeclaration({ 'Do Mat': 'Toi mat' })).toBe('payload.Do Mat');
      expect(stateSecretDeclaration({ a: { b: { state_secret: true } } })).toBe('payload.a.b.state_secret');
      expect(stateSecretDeclaration({ blocks: [{ ok: 1 }, { security_level: 'MẬT' }] })).toBe('payload.blocks[1].security_level');
    });

    it('lets ordinary members, other levels and values of other types through', () => {
      expect(stateSecretDeclaration({ secrecy_level: 'public', state_secret: false, do_mat: 3, note: 'Tuyet mat' })).toBeUndefined();
      expect(stateSecretDeclaration([{ x: [1, 'mat'] }])).toBeUndefined();
      expect(stateSecretDeclaration('mat')).toBeUndefined();
      expect(stateSecretDeclaration(null)).toBeUndefined();
    });

    it('stops reading below the depth limit', () => {
      let nested: Record<string, unknown> = { secrecy_level: 'mat' };
      for (let level = 0; level < 20; level += 1) nested = { next: nested };
      expect(stateSecretDeclaration(nested)).toBeUndefined();
    });
  });

  describe('normalisedPayload', () => {
    it('returns the canonical form with its hash, and the amount when one is declared', () => {
      const a = normalisedPayload({ b: 1, a: 'x', amount_vnd: '1500000' });
      const b = normalisedPayload({ amount_vnd: '1500000', a: 'x', b: 1 });
      expect(a.sha256).toBe(b.sha256);
      expect(a.amountVnd).toBe('1500000');
      expect(normalisedPayload({ a: 1, amount_vnd: null }).amountVnd).toBeNull();
      expect(normalisedPayload({ a: 1 }).amountVnd).toBeNull();
    });

    it('refuses what is not an object, what is too large and an amount that is not whole VND', () => {
      expect(codeOf(() => normalisedPayload([1]))).toEqual({ code: 'PAYLOAD_SCHEMA_INVALID', detail: 'payload' });
      expect(codeOf(() => normalisedPayload('x', 'content'))).toEqual({ code: 'PAYLOAD_SCHEMA_INVALID', detail: 'content' });
      expect(codeOf(() => normalisedPayload({ text: 'x'.repeat(200_001) })).code).toBe('PAYLOAD_SCHEMA_INVALID');
      expect(codeOf(() => normalisedPayload({ amount_vnd: '12.5' }))).toEqual({ code: 'PAYLOAD_SCHEMA_INVALID', detail: 'amount_vnd' });
      expect(codeOf(() => normalisedPayload({ amount_vnd: true }))).toEqual({ code: 'PAYLOAD_SCHEMA_INVALID', detail: 'amount_vnd' });
    });
  });

  describe('payloadWithBlocks', () => {
    it('puts the blocks under their name, and leaves the payload when there are none', () => {
      expect(payloadWithBlocks({ a: 1 }, undefined)).toEqual({ a: 1 });
      expect(payloadWithBlocks({ a: 1 }, { intro: 'x' })).toEqual({ a: 1, content_blocks: { intro: 'x' } });
      expect(payloadWithBlocks(undefined, { intro: 'x' })).toEqual({ content_blocks: { intro: 'x' } });
      expect(payloadWithBlocks([1], { intro: 'x' })).toEqual([1]);
    });

    it('refuses a payload that already has a member of that name', () => {
      expect(codeOf(() => payloadWithBlocks({ content_blocks: 1 }, {}))).toEqual({ code: 'PAYLOAD_SCHEMA_INVALID', detail: 'content_blocks' });
    });
  });

  describe('normaliseRecipients', () => {
    it('trims, lower-cases the unit id, defaults the kind and keeps a repeated entry once', () => {
      const result = normaliseRecipients([
        { name: '  Finance Dept ', code: ' FIN ' },
        { name: 'Finance Dept', code: 'FIN' },
        { name: 'Unit', unit_id: UNIT },
        { name: 'Anna', kind: 'PERSON' },
      ]);
      expect(result).toEqual([
        { kind: 'EXTERNAL_AGENCY', name: 'Finance Dept', code: 'FIN' },
        { kind: 'INTERNAL_UNIT', name: 'Unit', unit_id: UNIT.toLowerCase() },
        { kind: 'PERSON', name: 'Anna' },
      ]);
      expect(recipientNames(result)).toEqual(['Finance Dept', 'Unit', 'Anna']);
      expect(normaliseRecipients(undefined)).toEqual([]);
    });

    it('names the member of the first entry that is wrong', () => {
      expect(codeOf(() => normaliseRecipients([{ name: '' }])).detail).toBe('recipients[0].name');
      expect(codeOf(() => normaliseRecipients([{ name: 'x'.repeat(301) }])).detail).toBe('recipients[0].name');
      expect(codeOf(() => normaliseRecipients([{ name: 'ok' }, { name: 'ok', extra: 1 }])).detail).toBe('recipients[1].extra');
      expect(codeOf(() => normaliseRecipients([{ name: 'ok', code: '' }])).detail).toBe('recipients[0].code');
      expect(codeOf(() => normaliseRecipients([{ name: 'ok', code: 'c'.repeat(61) }])).detail).toBe('recipients[0].code');
      expect(codeOf(() => normaliseRecipients([{ name: 'ok', code: 7 }])).detail).toBe('recipients[0].code');
      expect(codeOf(() => normaliseRecipients([{ name: 'ok', unit_id: 'nope' }])).detail).toBe('recipients[0].unit_id');
      expect(codeOf(() => normaliseRecipients([{ name: 'ok', kind: 'ROBOT' }])).detail).toBe('recipients[0].kind');
      expect(codeOf(() => normaliseRecipients(['x' as unknown as object])).detail).toBe('recipients[0].name');
    });
  });

  describe('readiness and the review checklist', () => {
    it('lists what keeps a draft from review', () => {
      expect(readinessFailures({ recipientCount: 1, signerUserId: 's', signingMode: 'DIRECT', delegationId: null })).toEqual([]);
      expect(readinessFailures({ recipientCount: 0, signerUserId: null, signingMode: 'KT', delegationId: null }).map((failure) => failure.code)).toEqual([
        'RECIPIENTS_REQUIRED',
        'SIGNER_REQUIRED',
        'DELEGATION_REQUIRED',
      ]);
      expect(readinessFailures({ recipientCount: 1, signerUserId: 's', signingMode: 'KT', delegationId: 'd' })).toEqual([]);
    });

    it('wants every item of the checklist confirmed with true and keeps only the catalogue in the history', () => {
      expect(checklistFailures(Object.fromEntries(REVIEW_CHECKLIST.map((key) => [key, true])))).toEqual([]);
      const failures = checklistFailures({ national_title: true, motto: 'yes' });
      expect(failures).toHaveLength(REVIEW_CHECKLIST.length - 1);
      expect(failures[0]).toEqual({ field: 'format_checklist.motto', code: 'CHECK_NOT_CONFIRMED' });
      expect(checklistFailures(undefined)).toHaveLength(REVIEW_CHECKLIST.length);
      expect(storedChecklist({ national_title: true, motto: 'yes', extra: true })).toMatchObject({ national_title: true, motto: false });
      expect(Object.keys(storedChecklist(undefined))).toEqual([...REVIEW_CHECKLIST]);
    });

    it('turns the failures into one 422 that carries all of them', () => {
      const error = formatCheckFailed([{ field: 'body', code: 'X' }]);
      expect(error).toMatchObject({ code: 'FORMAT_CHECK_FAILED', detail: 'body' });
      expect(formatCheckFailed([]).detail).toBeUndefined();
    });
  });
});
