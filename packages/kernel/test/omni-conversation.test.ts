import type { EffectiveAccess, GrantView } from '../src/effective-access';
import { assertAssignment, assigneeEligible, consentChannelOfAccount, conversationAfter, identityChannelOfAccount, isStopKeyword, windowExpiresAt } from '../src/omni-conversation';

const refusal = (run: () => unknown): { code: string; detail: string | undefined; status: number } => {
  try {
    run();
  } catch (error) {
    const known = error as { code: string; detail?: string; status: number };
    return { code: known.code, detail: known.detail, status: known.status };
  }
  throw new Error('it was allowed');
};
const ID = '00000000-0000-4000-8000-0000000000a1';

describe('the conversations of the omnichannel center (ST-OMNI-004, OMNI.md 3.1, 3.2)', () => {
  it('moves a conversation only the ways the table allows, and says CONVERSATION_STATE_INVALID otherwise', () => {
    expect(conversationAfter('New', 'assign')).toBe('Assigned');
    expect(conversationAfter('Assigned', 'assign')).toBe('Assigned');
    expect(conversationAfter('InProgress', 'assign')).toBe('InProgress');
    expect(conversationAfter('Assigned', 'open')).toBe('InProgress');
    expect(conversationAfter('InProgress', 'pend')).toBe('PendingCustomer');
    expect(conversationAfter('Assigned', 'reply')).toBe('InProgress');
    expect(conversationAfter('PendingCustomer', 'reply')).toBe('InProgress');
    expect(conversationAfter('InProgress', 'reply')).toBe('InProgress');
    expect(refusal(() => conversationAfter('New', 'reply')).code).toBe('CONVERSATION_STATE_INVALID');
    expect(refusal(() => conversationAfter('Resolved', 'reply')).code).toBe('CONVERSATION_STATE_INVALID');
    expect(refusal(() => conversationAfter('Closed', 'reply')).code).toBe('CONVERSATION_STATE_INVALID');
    expect(conversationAfter('InProgress', 'resolve')).toBe('Resolved');
    expect(conversationAfter('PendingCustomer', 'resolve')).toBe('Resolved');
    expect(conversationAfter('Resolved', 'reopen')).toBe('InProgress');
    expect(conversationAfter('Resolved', 'close')).toBe('Closed');
    expect(refusal(() => conversationAfter('Resolved', 'assign'))).toEqual({ code: 'CONVERSATION_STATE_INVALID', detail: 'status', status: 409 });
    expect(refusal(() => conversationAfter('Closed', 'assign')).code).toBe('CONVERSATION_STATE_INVALID');
    expect(refusal(() => conversationAfter('New', 'open')).code).toBe('CONVERSATION_STATE_INVALID');
    expect(refusal(() => conversationAfter('New', 'resolve')).code).toBe('CONVERSATION_STATE_INVALID');
    expect(refusal(() => conversationAfter('Assigned', 'resolve')).code).toBe('CONVERSATION_STATE_INVALID');
    expect(refusal(() => conversationAfter('InProgress', 'close')).code).toBe('CONVERSATION_STATE_INVALID');
  });

  it('says what a message that comes in does: a customer who answers moves what waited for them, a resolved conversation is reopened, and a closed one takes none', () => {
    expect(conversationAfter('New', 'inbound')).toBe('New');
    expect(conversationAfter('Assigned', 'inbound')).toBe('Assigned');
    expect(conversationAfter('InProgress', 'inbound')).toBe('InProgress');
    expect(conversationAfter('PendingCustomer', 'inbound')).toBe('InProgress');
    expect(conversationAfter('Resolved', 'inbound')).toBe('InProgress');
    expect(refusal(() => conversationAfter('Closed', 'inbound')).code).toBe('CONVERSATION_STATE_INVALID');
  });

  it('gives a window of 24 hours only to the channels whose provider closes one', () => {
    const last = new Date('2026-10-30T10:00:00.000Z');
    expect(windowExpiresAt('WHATSAPP', last)?.toISOString()).toBe('2026-10-31T10:00:00.000Z');
    expect(windowExpiresAt('ZALO_OA', last)?.toISOString()).toBe('2026-10-31T10:00:00.000Z');
    expect(windowExpiresAt('EMAIL', last)).toBeUndefined();
    expect(windowExpiresAt('SMS', last)).toBeUndefined();
  });

  it('knows the identity and the consent a message on a channel account speaks for, and which providers vouch for the sender', () => {
    expect(identityChannelOfAccount('EMAIL')).toBe('EMAIL');
    expect(identityChannelOfAccount('SMS')).toBe('PHONE');
    expect(identityChannelOfAccount('ZALO_OA')).toBe('ZALO');
    expect(identityChannelOfAccount('WHATSAPP')).toBe('WHATSAPP');
    expect(identityChannelOfAccount('PUSH_FCM')).toBeUndefined();
    expect(consentChannelOfAccount('SMS')).toBe('SMS');
    expect(consentChannelOfAccount('ZALO_OA')).toBe('ZALO');
    expect(consentChannelOfAccount('PUSH_APNS')).toBeUndefined();
  });

  it('reads STOP and HUY, however they are written, as the whole message, and a sentence that has the word in it as nothing', () => {
    for (const text of ['STOP', 'stop', ' Stop. ', 'HUY', 'huy', 'Hủy', 'HỦY!', 'hủy ', 'DUNG', 'Dừng']) expect(isStopKeyword(text)).toBe(true);
    for (const text of ['please do not stop', 'stop sending me this', 'huy hiệu', 'stopped', '', 'hủy đơn của tôi', 'dung lượng']) expect(isStopKeyword(text)).toBe(false);
  });

  it('takes an assignment with the member it goes to and a reason of up to 500 characters, if said', () => {
    expect(assertAssignment({ assignee_membership_id: ID.toUpperCase(), reason: ' the queue of the unit ' })).toEqual({ assigneeId: ID, reason: 'the queue of the unit' });
    expect(assertAssignment({ assignee_membership_id: ID })).toEqual({ assigneeId: ID, reason: undefined });
    expect(refusal(() => assertAssignment({ assignee_membership_id: 'x' })).detail).toBe('assignee_membership_id');
    expect(refusal(() => assertAssignment({ assignee_membership_id: ID, reason: '   ' })).detail).toBe('reason');
    expect(refusal(() => assertAssignment({ assignee_membership_id: ID, reason: 'r'.repeat(501) })).detail).toBe('reason');
  });

  describe('who may be given a conversation', () => {
    const NOW = new Date('2026-10-30T10:00:00Z');
    const unit = { id: 'unit-2', path: '/unit-1/unit-2/' };
    const access = (grant: Partial<GrantView> & Pick<GrantView, 'scope'>, active = true): EffectiveAccess => ({
      membershipId: 'm',
      scopeVersion: 1,
      membershipActive: active,
      grants: [{ roleCode: 'OMNI_AGENT', rank: 35, permissions: ['omni.conversation.reply'], status: 'Active', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveUntil: null, ...grant }],
    });

    it('is a member whose grant carries the permission to answer and whose scope contains the unit of the queue', () => {
      expect(assigneeEligible(access({ scope: { kind: 'TENANT' } }), unit, NOW)).toBe(true);
      expect(assigneeEligible(access({ scope: { kind: 'UNIT_SUBTREE', refIds: ['unit-1'], paths: ['/unit-1/'] } }), unit, NOW)).toBe(true);
      expect(assigneeEligible(access({ scope: { kind: 'UNIT_ONLY', refIds: ['unit-2'] } }), unit, NOW)).toBe(true);
      expect(assigneeEligible(access({ scope: { kind: 'UNIT_ONLY', refIds: ['unit-9'] } }), unit, NOW)).toBe(false);
      expect(assigneeEligible(access({ scope: { kind: 'UNIT_SUBTREE', refIds: ['unit-5'], paths: ['/unit-5/'] } }), unit, NOW)).toBe(false);
    });

    it('is a member who holds the permission anywhere when the queue is of the whole tenant, and not one whose grant has another permission, has ended or is not yet in force, or whose membership is not active', () => {
      expect(assigneeEligible(access({ scope: { kind: 'UNIT_ONLY', refIds: ['unit-9'] } }), undefined, NOW)).toBe(true);
      expect(assigneeEligible(access({ scope: { kind: 'TENANT' }, permissions: ['omni.contact.manage'] }), unit, NOW)).toBe(false);
      expect(assigneeEligible(access({ scope: { kind: 'TENANT' }, permissions: ['omni.*'] }), unit, NOW)).toBe(true);
      expect(assigneeEligible(access({ scope: { kind: 'TENANT' }, effectiveUntil: new Date('2026-10-01T00:00:00Z') }), unit, NOW)).toBe(false);
      expect(assigneeEligible(access({ scope: { kind: 'TENANT' }, effectiveFrom: new Date('2026-11-01T00:00:00Z') }), unit, NOW)).toBe(false);
      expect(assigneeEligible(access({ scope: { kind: 'TENANT' } }, false), unit, NOW)).toBe(false);
    });
  });
});
