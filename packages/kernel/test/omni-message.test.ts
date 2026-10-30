import { assertConversationReason, assertMessageSend, attachable, judgeSend, mayMoveDelivery, retryDelayMs, textWithLinks, withAbsoluteLinks } from '../src/omni-message';
import type { SendFacts } from '../src/omni-message';

const refusal = (run: () => unknown): { code: string; detail: string | undefined; status: number } => {
  try {
    run();
  } catch (error) {
    const known = error as { code: string; detail?: string; status: number };
    return { code: known.code, detail: known.detail, status: known.status };
  }
  throw new Error('it was allowed');
};
const ACCOUNT = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000a2';
const DOC = '00000000-0000-4000-8000-0000000000d1';
const NOW = new Date('2026-10-30T10:00:00Z');

describe('what an agent says in a conversation (ST-OMNI-005, OMNI.md 3.3)', () => {
  describe('the shape of a send', () => {
    it('takes a message to the person with a text, the purpose of support by default, and nothing else', () => {
      expect(assertMessageSend({ kind: 'EXTERNAL', channel_account_id: ACCOUNT.toUpperCase(), text: '  Xin chào  ' })).toEqual({
        kind: 'EXTERNAL',
        channelAccountId: ACCOUNT,
        purpose: 'SUPPORT_CONVERSATION',
        text: 'Xin chào',
        templateVersionId: undefined,
        templateVariables: {},
        attachmentIds: [],
        links: [],
      });
    });

    it('takes a template with its variables instead of a text, never both, and no variables without a template', () => {
      const draft = assertMessageSend({ kind: 'EXTERNAL', channel_account_id: ACCOUNT, purpose: 'REMINDER', template_version_id: DOC, template_variables: { name: 'An' } });
      expect(draft).toMatchObject({ purpose: 'REMINDER', text: undefined, templateVersionId: DOC, templateVariables: { name: 'An' } });
      expect(refusal(() => assertMessageSend({ kind: 'EXTERNAL', channel_account_id: ACCOUNT, text: 'x', template_version_id: DOC })).detail).toBe('template_version_id');
      expect(refusal(() => assertMessageSend({ kind: 'EXTERNAL', channel_account_id: ACCOUNT })).detail).toBe('text');
      expect(refusal(() => assertMessageSend({ kind: 'EXTERNAL', channel_account_id: ACCOUNT, text: 'x', template_variables: { a: 'b' } })).detail).toBe('template_variables');
      expect(refusal(() => assertMessageSend({ kind: 'EXTERNAL', channel_account_id: ACCOUNT, template_version_id: DOC, template_variables: { a: 3 } })).detail).toBe('template_variables');
      expect(refusal(() => assertMessageSend({ kind: 'EXTERNAL', channel_account_id: ACCOUNT, template_version_id: DOC, template_variables: [] })).detail).toBe('template_variables');
      expect(refusal(() => assertMessageSend({ kind: 'EXTERNAL', channel_account_id: ACCOUNT, template_version_id: 'x' })).detail).toBe('template_version_id');
    });

    it('refuses what is not a kind, an account, a purpose or a text of 1 to 4000 characters', () => {
      expect(refusal(() => assertMessageSend({ kind: 'SHOUT', channel_account_id: ACCOUNT, text: 'x' })).detail).toBe('kind');
      expect(refusal(() => assertMessageSend({ kind: 'EXTERNAL', channel_account_id: 'x', text: 'x' })).detail).toBe('channel_account_id');
      expect(refusal(() => assertMessageSend({ kind: 'EXTERNAL', channel_account_id: ACCOUNT, text: 'x', purpose: 'ADS' })).detail).toBe('purpose');
      expect(refusal(() => assertMessageSend({ kind: 'EXTERNAL', channel_account_id: ACCOUNT, text: '   ' })).detail).toBe('text');
      expect(refusal(() => assertMessageSend({ kind: 'EXTERNAL', channel_account_id: ACCOUNT, text: 3 })).detail).toBe('text');
      expect(assertMessageSend({ kind: 'EXTERNAL', channel_account_id: ACCOUNT, text: 'x'.repeat(4000) }).text).toHaveLength(4000);
      expect(refusal(() => assertMessageSend({ kind: 'EXTERNAL', channel_account_id: ACCOUNT, text: 'x'.repeat(4001) })).detail).toBe('text');
    });

    it('takes at most five attachments and five links, each once, and links only to a version of a document', () => {
      const ids = (n: number) => Array.from({ length: n }, (_, index) => `00000000-0000-4000-8000-00000000e${String(index).padStart(3, '0')}`);
      expect(assertMessageSend({ kind: 'EXTERNAL', channel_account_id: ACCOUNT, text: 'x', attachment_ids: ids(5) }).attachmentIds).toHaveLength(5);
      expect(refusal(() => assertMessageSend({ kind: 'EXTERNAL', channel_account_id: ACCOUNT, text: 'x', attachment_ids: ids(6) })).detail).toBe('attachment_ids');
      expect(refusal(() => assertMessageSend({ kind: 'EXTERNAL', channel_account_id: ACCOUNT, text: 'x', attachment_ids: [DOC, DOC] })).detail).toBe('attachment_ids');
      expect(refusal(() => assertMessageSend({ kind: 'EXTERNAL', channel_account_id: ACCOUNT, text: 'x', attachment_ids: ['x'] })).detail).toBe('attachment_ids');
      expect(refusal(() => assertMessageSend({ kind: 'EXTERNAL', channel_account_id: ACCOUNT, text: 'x', attachment_ids: 'x' })).detail).toBe('attachment_ids');
      const link = { resource_type: 'document_version', resource_id: DOC };
      expect(assertMessageSend({ kind: 'EXTERNAL', channel_account_id: ACCOUNT, text: 'x', resource_links: [link] }).links).toEqual([{ resourceType: 'document_version', resourceId: DOC }]);
      expect(refusal(() => assertMessageSend({ kind: 'EXTERNAL', channel_account_id: ACCOUNT, text: 'x', resource_links: [link, link] })).detail).toBe('resource_links');
      expect(refusal(() => assertMessageSend({ kind: 'EXTERNAL', channel_account_id: ACCOUNT, text: 'x', resource_links: [{ resource_type: 'issue', resource_id: DOC }] })).detail).toBe('resource_links');
      expect(refusal(() => assertMessageSend({ kind: 'EXTERNAL', channel_account_id: ACCOUNT, text: 'x', resource_links: [null] })).detail).toBe('resource_links');
      expect(refusal(() => assertMessageSend({ kind: 'EXTERNAL', channel_account_id: ACCOUNT, text: 'x', resource_links: ids(6).map((resource_id) => ({ resource_type: 'document_version', resource_id })) })).detail).toBe('resource_links');
      expect(refusal(() => assertMessageSend({ kind: 'EXTERNAL', channel_account_id: ACCOUNT, text: 'x', resource_links: 'x' })).detail).toBe('resource_links');
    });

    it('takes a note with a text only: whatever would make it leave the system is refused, not ignored', () => {
      expect(assertMessageSend({ kind: 'INTERNAL_NOTE', channel_account_id: ACCOUNT, text: 'Gọi lại sau 3 giờ' })).toMatchObject({ kind: 'INTERNAL_NOTE', text: 'Gọi lại sau 3 giờ', attachmentIds: [], links: [] });
      expect(refusal(() => assertMessageSend({ kind: 'INTERNAL_NOTE', channel_account_id: ACCOUNT })).detail).toBe('text');
      expect(refusal(() => assertMessageSend({ kind: 'INTERNAL_NOTE', channel_account_id: ACCOUNT, text: 'x', purpose: 'REMINDER' })).detail).toBe('purpose');
      expect(refusal(() => assertMessageSend({ kind: 'INTERNAL_NOTE', channel_account_id: ACCOUNT, text: 'x', template_version_id: DOC })).detail).toBe('template_version_id');
      expect(refusal(() => assertMessageSend({ kind: 'INTERNAL_NOTE', channel_account_id: ACCOUNT, text: 'x', attachment_ids: [DOC] })).detail).toBe('attachment_ids');
      expect(refusal(() => assertMessageSend({ kind: 'INTERNAL_NOTE', channel_account_id: ACCOUNT, text: 'x', resource_links: [{ resource_type: 'document_version', resource_id: DOC }] })).detail).toBe('resource_links');
    });

    it('asks a reason of 10 to 2000 characters for a resolve or a reopening', () => {
      expect(assertConversationReason({ reason: '  Khách đã được giải đáp.  ' })).toBe('Khách đã được giải đáp.');
      for (const reason of [undefined, 3, 'short', 'r'.repeat(2001), '          ']) expect(refusal(() => assertConversationReason({ reason })).detail).toBe('reason');
    });
  });

  describe('what may be sent as a file or a link', () => {
    it('lets a public or internal document that was scanned clean go, and keeps the rest inside', () => {
      expect(attachable({ classification: 'PUBLIC', scanStatus: 'CLEAN' })).toBe(true);
      expect(attachable({ classification: 'INTERNAL', scanStatus: 'clean' })).toBe(true);
      for (const classification of ['CONFIDENTIAL', 'PERSONAL', 'IMPORTANT_CORE', 'SECRET']) expect(attachable({ classification, scanStatus: 'CLEAN' })).toBe(false);
      expect(attachable({ classification: 'PUBLIC', scanStatus: 'PENDING' })).toBe(false);
      expect(attachable({ classification: 'PUBLIC', scanStatus: 'INFECTED' })).toBe(false);
    });

    it('puts one opaque link after the words, for each file or record named, and nothing else', () => {
      expect(textWithLinks('Xin chào', [])).toBe('Xin chào');
      expect(textWithLinks('Xin chào', [DOC, OTHER])).toBe(`Xin chào\n/d/${DOC}\n/d/${OTHER}`);
    });
  });

  describe('the address of a link', () => {
    it('makes each opaque link a whole address with the public origin of the application, and leaves the words alone', () => {
      const text = textWithLinks('Xin chào /d/not-a-link', [DOC, OTHER]);
      expect(withAbsoluteLinks(text, 'https://app.example.test')).toBe(`Xin chào /d/not-a-link\nhttps://app.example.test/d/${DOC}\nhttps://app.example.test/d/${OTHER}`);
      expect(withAbsoluteLinks(text, 'https://app.example.test/')).toBe(`Xin chào /d/not-a-link\nhttps://app.example.test/d/${DOC}\nhttps://app.example.test/d/${OTHER}`);
    });

    it('sends a text with no link as it is, and refuses to send a link that has no origin to rest on', () => {
      expect(withAbsoluteLinks('Xin chào', undefined)).toBe('Xin chào');
      expect(withAbsoluteLinks('Xin chào', 'https://app.example.test')).toBe('Xin chào');
      expect(withAbsoluteLinks(textWithLinks('Xin chào', [DOC]), undefined)).toBeUndefined();
    });
  });

  describe('the checks of a message to the person, in order', () => {
    const facts = (change: Partial<SendFacts> = {}): SendFacts => ({
      requestedAccountId: ACCOUNT,
      conversationAccountId: ACCOUNT,
      accountStatus: 'Active',
      accountVerified: true,
      channel: 'WHATSAPP',
      purpose: 'SUPPORT_CONVERSATION',
      consent: undefined,
      windowExpiresAt: new Date('2026-10-30T12:00:00Z'),
      now: NOW,
      approvedTemplate: false,
      ...change,
    });

    it('lets an answer for support inside the window of the person through without a consent, and a channel without a window always', () => {
      expect(() => judgeSend(facts())).not.toThrow();
      expect(() => judgeSend(facts({ channel: 'EMAIL', windowExpiresAt: undefined }))).not.toThrow();
      expect(() => judgeSend(facts({ consent: 'Granted' }))).not.toThrow();
    });

    it('refuses an account that is not the conversation\'s before anything else (CHANNEL_ACCOUNT_MISMATCH), naming no owner', () => {
      const refused = refusal(() => judgeSend(facts({ requestedAccountId: OTHER, accountStatus: 'Disabled', consent: 'Withdrawn' })));
      expect(refused).toEqual({ code: 'CHANNEL_ACCOUNT_MISMATCH', detail: 'channel_account_id', status: 422 });
    });

    it('refuses an account that is not Active or not verified (CHANNEL_UNVERIFIED), before the consent', () => {
      expect(refusal(() => judgeSend(facts({ accountStatus: 'Disabled', consent: 'Withdrawn' }))).code).toBe('CHANNEL_UNVERIFIED');
      expect(refusal(() => judgeSend(facts({ accountStatus: 'CredentialExpired' }))).code).toBe('CHANNEL_UNVERIFIED');
      expect(refusal(() => judgeSend(facts({ accountVerified: false }))).code).toBe('CHANNEL_UNVERIFIED');
    });

    it('stops a message the person withdrew the consent for, however the conversation began (CONSENT_DENIED), also on WhatsApp', () => {
      expect(refusal(() => judgeSend(facts({ consent: 'Withdrawn' }))).code).toBe('CONSENT_DENIED');
      expect(refusal(() => judgeSend(facts({ consent: 'Expired', channel: 'SMS', windowExpiresAt: undefined }))).code).toBe('CONSENT_DENIED');
      expect(refusal(() => judgeSend(facts({ consent: 'Withdrawn', purpose: 'REMINDER' }))).code).toBe('CONSENT_DENIED');
    });

    it('asks a Granted consent for anything but an answer for support in the window: CONSENT_DENIED, and OPT_IN_REQUIRED on WhatsApp, which wants the opt-in', () => {
      expect(refusal(() => judgeSend(facts({ purpose: 'REMINDER', channel: 'SMS', windowExpiresAt: undefined }))).code).toBe('CONSENT_DENIED');
      expect(refusal(() => judgeSend(facts({ purpose: 'OPERATIONAL', channel: 'ZALO_OA' }))).code).toBe('CONSENT_DENIED');
      expect(refusal(() => judgeSend(facts({ purpose: 'REMINDER' }))).code).toBe('OPT_IN_REQUIRED');
      // The window is over: the answer for support is no longer grounded by the person's own message.
      expect(refusal(() => judgeSend(facts({ windowExpiresAt: new Date('2026-10-30T09:00:00Z') }))).code).toBe('OPT_IN_REQUIRED');
      expect(refusal(() => judgeSend(facts({ windowExpiresAt: new Date('2026-10-30T09:00:00Z'), channel: 'ZALO_OA' }))).code).toBe('CONSENT_DENIED');
      expect(() => judgeSend(facts({ purpose: 'REMINDER', consent: 'Granted' }))).not.toThrow();
    });

    it('closes the window on a free text, and lets a template the provider approved through, the instant it ends included', () => {
      const over = { consent: 'Granted' as const, windowExpiresAt: new Date('2026-10-30T09:00:00Z') };
      expect(refusal(() => judgeSend(facts(over))).code).toBe('CHANNEL_WINDOW_CLOSED');
      expect(() => judgeSend(facts({ ...over, approvedTemplate: true }))).not.toThrow();
      expect(refusal(() => judgeSend(facts({ consent: 'Granted', windowExpiresAt: NOW }))).code).toBe('CHANNEL_WINDOW_CLOSED');
      expect(() => judgeSend(facts({ consent: 'Granted', windowExpiresAt: new Date(NOW.getTime() + 1) }))).not.toThrow();
    });
  });

  describe('the status of a message that went out', () => {
    it('moves forward only, fails only before delivery, and never leaves a failure', () => {
      expect(mayMoveDelivery('Queued', 'ProviderAccepted')).toBe(true);
      expect(mayMoveDelivery('Queued', 'Delivered')).toBe(true);
      expect(mayMoveDelivery('ProviderAccepted', 'Read')).toBe(true);
      expect(mayMoveDelivery('Delivered', 'Read')).toBe(true);
      expect(mayMoveDelivery('Delivered', 'ProviderAccepted')).toBe(false);
      expect(mayMoveDelivery('Read', 'Delivered')).toBe(false);
      expect(mayMoveDelivery('Delivered', 'Delivered')).toBe(false);
      expect(mayMoveDelivery('Queued', 'Failed')).toBe(true);
      expect(mayMoveDelivery('ProviderAccepted', 'Failed')).toBe(true);
      expect(mayMoveDelivery('Delivered', 'Failed')).toBe(false);
      expect(mayMoveDelivery('Failed', 'Delivered')).toBe(false);
      expect(mayMoveDelivery('Failed', 'Failed')).toBe(false);
      expect(mayMoveDelivery('Queued', 'Weird')).toBe(false);
    });

    it('waits longer after each failure, 30 seconds, one minute, two minutes', () => {
      expect([1, 2, 3].map(retryDelayMs)).toEqual([30_000, 60_000, 120_000]);
      expect(retryDelayMs(0)).toBe(30_000);
    });
  });
});
