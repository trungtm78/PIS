import type { DraftRecipient } from '@machvon/db';
import { UnconfiguredEmailChannel } from '../../src/modules/doc/distribution-channel';
import { defaultChannelOf, itemsForAllRecipients, normaliseDispatch } from '../../src/modules/doc/distribution-rules';
import { ISSUED_SIGNATURE_REVOKED_ALERT, recheckIssuedRevocation } from '../../src/modules/doc/revocation-recheck';
import type { DocumentFilePort } from '../../src/modules/doc/file-port';
import type { TenantTx } from '@machvon/db';

const UNIT = '00000000-0000-4000-8000-0000000000a2';
const onDocument: DraftRecipient[] = [
  { kind: 'INTERNAL_UNIT', name: 'Planning Division', unit_id: UNIT },
  { kind: 'EXTERNAL_AGENCY', name: 'Department of Finance', code: 'SKHDT' },
  { kind: 'PERSON', name: 'Nguyen Van A' },
];

function problemOf(work: () => unknown): { code: string; detail: string | undefined; reason: unknown } {
  try {
    work();
  } catch (error) {
    const e = error as { code: string; detail?: string; extensions?: { reason?: unknown } };
    return { code: e.code, detail: e.detail, reason: e.extensions?.reason };
  }
  throw new Error('expected a refusal');
}

describe('the recipients of a dispatch (ST-DOC-010, RECIPIENT_INVALID)', () => {
  it('takes recipients the document names on a channel of the distribution, in the stored form, once each', () => {
    const items = normaliseDispatch(
      [
        { kind: 'INTERNAL_UNIT', name: ' planning division ', channel: 'INTERNAL' },
        { name: 'Department of Finance', kind: 'EXTERNAL_AGENCY', channel: 'EMAIL', acknowledgement_required: false },
        { name: 'DEPARTMENT OF FINANCE', kind: 'EXTERNAL_AGENCY', channel: 'EMAIL' },
        { name: 'Nguyen Van A', kind: 'PERSON', channel: 'PAPER_HANDOVER' },
      ],
      onDocument,
    );
    expect(items).toEqual([
      { recipient: onDocument[0], channel: 'INTERNAL', acknowledgementRequired: true },
      { recipient: onDocument[1], channel: 'EMAIL', acknowledgementRequired: false },
      { recipient: onDocument[2], channel: 'PAPER_HANDOVER', acknowledgementRequired: true },
    ]);
  });

  it.each([
    ['nothing', [], 'recipients', 'EMPTY'],
    ['a member that is not an object', ['text'], 'recipients[0].name', undefined],
    ['a member the request may not carry', [{ name: 'Department of Finance', channel: 'EMAIL', status: 'SENT' }], 'recipients[0].status', undefined],
    ['the LGSP channel for a unit of this system', [{ name: 'Planning Division', kind: 'INTERNAL_UNIT', channel: 'LGSP' }], 'recipients[0].channel', 'LGSP_NEEDS_AGENCY'],
    ['the LGSP channel for a person', [{ name: 'Nguyen Van A', kind: 'PERSON', channel: 'LGSP' }], 'recipients[0].channel', 'LGSP_NEEDS_AGENCY'],
    ['no channel', [{ name: 'Department of Finance' }], 'recipients[0].channel', undefined],
    ['a duty to acknowledge that is not a boolean', [{ name: 'Department of Finance', channel: 'EMAIL', acknowledgement_required: 1 }], 'recipients[0].acknowledgement_required', undefined],
    ['a name that is empty', [{ name: '   ', channel: 'EMAIL' }], 'recipients[0].name', undefined],
    ['a unit that is not an id', [{ name: 'Planning Division', unit_id: 'unit', channel: 'INTERNAL' }], 'recipients[0].unit_id', undefined],
    ['a recipient the document does not name', [{ name: 'Somebody Else', channel: 'EMAIL' }], 'recipients[0].name', 'NOT_ON_DOCUMENT'],
    ['another code than the document prints', [{ name: 'Department of Finance', code: 'OTHER', channel: 'EMAIL' }], 'recipients[0].code', 'NOT_ON_DOCUMENT'],
    ['the inbox of an agency outside the system', [{ name: 'Department of Finance', channel: 'INTERNAL' }], 'recipients[0].channel', 'INTERNAL_CHANNEL_NEEDS_UNIT'],
  ])('refuses %s', (_name, raw, detail, reason) => {
    expect(problemOf(() => normaliseDispatch(raw as object[], onDocument))).toEqual({ code: 'RECIPIENT_INVALID', detail, reason });
  });

  it('takes an agency on the LGSP channel by the code the document prints for it (AC-ST-DOC-021-1)', () => {
    expect(normaliseDispatch([{ name: 'Department of Finance', channel: 'LGSP' }], onDocument)).toEqual([{ recipient: onDocument[1], channel: 'LGSP', acknowledgementRequired: true }]);
  });

  it('refuses an agency with no code on the LGSP channel: the gateway addresses a message by the code of the receiving agency (AC-ST-DOC-021-1)', () => {
    const nameless: DraftRecipient[] = [{ kind: 'EXTERNAL_AGENCY', name: 'Provincial Archive' }];
    expect(problemOf(() => normaliseDispatch([{ name: 'Provincial Archive', channel: 'LGSP' }], nameless))).toEqual({ code: 'RECIPIENT_INVALID', detail: 'recipients[0].code', reason: 'CODE_REQUIRED_FOR_LGSP' });
    expect(normaliseDispatch([{ name: 'Provincial Archive', channel: 'EMAIL' }], nameless)).toHaveLength(1);
  });

  it('sends to every recipient at once on the channel that needs no transport', () => {
    expect(defaultChannelOf(onDocument[0] as DraftRecipient)).toBe('INTERNAL');
    expect(itemsForAllRecipients(onDocument).map((item) => item.channel)).toEqual(['INTERNAL', 'PAPER_HANDOVER', 'PAPER_HANDOVER']);
  });
});

describe('the email channel until a mail transport exists', () => {
  it('says the provider is not available and never that a message was sent', async () => {
    await expect(new UnconfiguredEmailChannel().send()).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', status: 503 });
  });
});

describe('doc.revocation-recheck with stores that hold nothing the verifier can read', () => {
  const tx = {} as TenantTx;
  const due = (objectKey: string) => ({ outgoingDocumentId: 'o1', documentId: 'd1', versionId: 'v1', objectKey, checksum: 'a'.repeat(64) });
  const run = async (file: Uint8Array | undefined) => {
    const recorded: unknown[] = [];
    const raised: Array<{ code: string }> = [];
    const files = { get: async () => (file === undefined ? undefined : { bytes: file, mime: 'application/pdf' }) } as unknown as DocumentFilePort;
    const result = await recheckIssuedRevocation(tx, 'tenant', new Date('2026-10-23T03:00:00Z'), {
      files,
      trust: { forTenant: async () => ({ anchors: () => [] }) },
      revocation: { check: async () => ({ status: 'GOOD' as const }) },
      store: { issuedFilesDueForRevocationCheck: async () => [due('k')] } as never,
      signatures: { record: async (_tx: unknown, input: unknown) => void recorded.push(input) } as never,
      alerts: { raise: (code: string) => void raised.push({ code }) },
    });
    return { result, recorded, raised };
  };

  it('counts a file that is missing from storage as failed and stores nothing', async () => {
    const { result, recorded } = await run(undefined);
    expect(result).toEqual({ checked: 0, good: 0, unknown: 0, revoked: [], failed: ['o1'] });
    expect(recorded).toEqual([]);
  });

  it('counts a file without a signature as failed (nothing vouches for it), stores that verification and raises no alert', async () => {
    const { result, recorded, raised } = await run(Buffer.from('%PDF-1.7\n%%EOF\n'));
    expect(result).toMatchObject({ checked: 1, good: 0, unknown: 0, revoked: [], failed: ['o1'] });
    expect(recorded).toHaveLength(1);
    expect(raised.map((alert) => alert.code)).not.toContain(ISSUED_SIGNATURE_REVOKED_ALERT);
  });
});
