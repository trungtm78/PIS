import { createHash } from 'node:crypto';
import type { DomainError } from '@machvon/kernel';
import { JSON_ENVELOPE_FORMAT, JsonInteropCodec } from '../../src/modules/doc/interop-codec';
import { MockLgspGateway } from '../../src/modules/doc/interop-mock';
import { UnconfiguredInteropTransport } from '../../src/modules/doc/interop-port';
import type { OutboundEnvelopeInput } from '../../src/modules/doc/interop-port';
import { adapterStatusOf, lgspSettingsOf } from '../../src/modules/doc/interop.service';

const codec = new JsonInteropCodec();
const PDF = Buffer.from('%PDF-1.4 a document');
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const input = (overrides: Partial<OutboundEnvelopeInput> = {}): OutboundEnvelopeInput => ({
  messageId: '00000000-0000-4000-8000-000000000001',
  senderCode: 'G08.SO-XD',
  receiverCode: 'G08.SKHDT',
  symbol: '12/QD-UBND',
  issuedOn: '2026-10-20',
  title: 'Decision on the capital plan',
  docTypeCode: 'QD',
  urgency: 'KHAN',
  pdf: PDF,
  ...overrides,
});

/** An envelope as the sender would write it, with members changed or taken away. */
function envelope(change: (value: Record<string, unknown>) => void = () => undefined): Buffer {
  const value = JSON.parse(codec.encode(input()).toString('utf8')) as Record<string, unknown>;
  change(value);
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function refusal(work: () => unknown): DomainError {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
}

describe('the JSON stand-in of the envelope of the LGSP (ST-DOC-021)', () => {
  it('names itself, so that an envelope of another format is told apart', () => {
    expect(JSON_ENVELOPE_FORMAT).toBe('machvon.lgsp.json/1');
  });

  it('carries the facts of the document, the parties and the PDF with its digest, and reads them back', () => {
    const bytes = codec.encode(input());
    const parsed = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      format: JSON_ENVELOPE_FORMAT,
      message_id: '00000000-0000-4000-8000-000000000001',
      sender_code: 'G08.SO-XD',
      receiver_code: 'G08.SKHDT',
      document: { symbol: '12/QD-UBND', issued_on: '2026-10-20', title: 'Decision on the capital plan', doc_type_code: 'QD', urgency: 'KHAN' },
      attachment: { media_type: 'application/pdf', sha256: sha(PDF), content_base64: PDF.toString('base64') },
    });
    expect(codec.decode(bytes)).toEqual({
      title: 'Decision on the capital plan',
      docTypeCode: 'QD',
      originalSymbol: '12/QD-UBND',
      originalIssuedOn: '2026-10-20',
      senderName: undefined,
      urgency: 'KHAN',
      pdf: PDF,
    });
  });

  it('builds the same bytes for the same document, so that the digest of the envelope is stable', () => {
    expect(sha(codec.encode(input()))).toBe(sha(codec.encode(input())));
    expect(sha(codec.encode(input()))).not.toBe(sha(codec.encode(input({ title: 'Another' }))));
  });

  it('leaves out what an envelope may leave out: the symbol, the date, the name of the sender, and takes the urgency as NORMAL', () => {
    const read = codec.decode(
      envelope((value) => {
        const document = value.document as Record<string, unknown>;
        delete document.symbol;
        delete document.issued_on;
        delete document.urgency;
        document.sender_name = '  Bo Tai chinh  ';
      }),
    );
    expect(read).toMatchObject({ originalSymbol: undefined, originalIssuedOn: undefined, urgency: 'NORMAL', senderName: 'Bo Tai chinh' });
  });

  it('trims and composes the words it reads', () => {
    const read = codec.decode(envelope((value) => ((value.document as Record<string, unknown>).title = `  Cong vȧn  `)));
    expect(read.title).toBe('Cong vȧn'.normalize('NFC'));
    expect(read.title.startsWith(' ')).toBe(false);
  });

  it.each([
    ['text that is not JSON', Buffer.from('not json'), 'envelope'],
    ['JSON that is not an object', Buffer.from('[1, 2]'), 'format'],
    ['JSON of another format', envelope((value) => (value.format = 'other/1')), 'format'],
    ['no document', envelope((value) => delete value.document), 'document'],
    ['a document that is not an object', envelope((value) => (value.document = 'x')), 'document'],
    ['no attachment', envelope((value) => delete value.attachment), 'attachment'],
    ['an attachment of another media type', envelope((value) => ((value.attachment as Record<string, unknown>).media_type = 'text/plain')), 'attachment'],
    ['an attachment with no content', envelope((value) => delete (value.attachment as Record<string, unknown>).content_base64), 'attachment'],
    ['an attachment with a digest that is not a digest', envelope((value) => ((value.attachment as Record<string, unknown>).sha256 = 'abc')), 'attachment'],
    ['an attachment with no digest', envelope((value) => delete (value.attachment as Record<string, unknown>).sha256), 'attachment'],
    ['an attachment that does not match its digest', envelope((value) => ((value.attachment as Record<string, unknown>).sha256 = 'd'.repeat(64))), 'attachment.sha256'],
    ['an empty attachment', envelope((value) => Object.assign(value.attachment as Record<string, unknown>, { content_base64: '', sha256: sha(Buffer.alloc(0)) })), 'attachment.sha256'],
    ['a title that is missing', envelope((value) => delete (value.document as Record<string, unknown>).title), 'document.title'],
    ['a title that is only spaces', envelope((value) => ((value.document as Record<string, unknown>).title = '   ')), 'document.title'],
    ['a title that is too long', envelope((value) => ((value.document as Record<string, unknown>).title = 'x'.repeat(501))), 'document.title'],
    ['a title that is not text', envelope((value) => ((value.document as Record<string, unknown>).title = 7)), 'document.title'],
    ['a type of document that is missing', envelope((value) => delete (value.document as Record<string, unknown>).doc_type_code), 'document.doc_type_code'],
    ['a date that is not a date', envelope((value) => ((value.document as Record<string, unknown>).issued_on = '20/10/2026')), 'document.issued_on'],
    ['a date that a parser reads but is not ISO', envelope((value) => ((value.document as Record<string, unknown>).issued_on = '10/11/2026')), 'document.issued_on'],
    ['a date that does not exist', envelope((value) => ((value.document as Record<string, unknown>).issued_on = '2026-13-45')), 'document.issued_on'],
    ['an urgency nobody knows', envelope((value) => ((value.document as Record<string, unknown>).urgency = 'ASAP')), 'document.urgency'],
  ])('refuses %s with 422 ENVELOPE_INVALID naming the member', (_name, bytes, member) => {
    const error = refusal(() => codec.decode(bytes));
    expect([error.code, error.status, error.detail]).toEqual(['ENVELOPE_INVALID', 422, member]);
  });
});

describe('the adapter that is bound until the specification of the LGSP exists (CXN-06)', () => {
  it('says the provider cannot be reached for a send and for a receipt, and never that a message was sent', async () => {
    const transport = new UnconfiguredInteropTransport();
    await expect(transport.send()).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', status: 503 });
    await expect(transport.receipt()).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', status: 503 });
  });
});

describe('the MOCK gateway of the LGSP', () => {
  const request = (messageId: string) => ({ endpoint: 'https://lgsp.example.gov.vn/ws', messageId, senderCode: 'A', receiverCode: 'B', envelope: Buffer.from('x'), envelopeSha256: sha(Buffer.from('x')) });

  it('refuses the sends it was told to refuse, then takes one, and drops a message id it has seen', async () => {
    const gateway = new MockLgspGateway();
    gateway.failures = 2;
    await expect(gateway.send(request('m1'))).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    await expect(gateway.send(request('m1'))).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    const first = await gateway.send(request('m1'));
    const again = await gateway.send(request('m1'));
    expect(again).toEqual(first);
    expect(gateway.accepted).toHaveLength(1);
    expect(gateway.endpoints).toHaveLength(4);
    expect((await gateway.send(request('m2'))).externalMessageId).not.toBe(first.externalMessageId);
  });

  it('answers the receipt it was told to, or cannot answer, and is back to nothing after a reset without ever giving an id twice', async () => {
    const gateway = new MockLgspGateway();
    const { externalMessageId } = await gateway.send(request('m1'));
    expect(await gateway.receipt({ endpoint: 'https://lgsp.example.gov.vn/ws', externalMessageId })).toEqual({ outcome: 'ACKED' });
    gateway.answer = { outcome: 'REJECTED', reasonCode: 'RECEIVER_UNKNOWN' };
    expect(await gateway.receipt({ endpoint: 'https://lgsp.example.gov.vn/ws', externalMessageId })).toEqual({ outcome: 'REJECTED', reasonCode: 'RECEIVER_UNKNOWN' });
    gateway.receiptFailure = new Error('timeout');
    await expect(gateway.receipt({ endpoint: 'https://lgsp.example.gov.vn/ws', externalMessageId })).rejects.toThrow('timeout');
    gateway.reset();
    expect(gateway.accepted).toEqual([]);
    expect(gateway.endpoints).toEqual([]);
    expect(await gateway.receipt({ endpoint: 'https://lgsp.example.gov.vn/ws', externalMessageId })).toEqual({ outcome: 'ACKED' });
    expect((await gateway.send(request('m1'))).externalMessageId).not.toBe(externalMessageId);
  });
});

describe('what the connector of the LGSP says (ADM-09)', () => {
  const connector = (config: Record<string, unknown>, adapterStatus = 'MOCK') => ({ config, adapterStatus }) as never;

  it('reads the address, the allowlist and the code of the agency, and nothing it cannot trust', () => {
    expect(lgspSettingsOf(connector({ endpoint: 'https://lgsp.example.gov.vn', egress_allowlist: ['lgsp.example.gov.vn'], agency_code: ' G08.SO-XD ' }))).toEqual({
      endpoint: 'https://lgsp.example.gov.vn',
      egressAllowlist: ['lgsp.example.gov.vn'],
      agencyCode: 'G08.SO-XD',
    });
    expect(lgspSettingsOf(connector({ endpoint: 7, egress_allowlist: 'lgsp.example.gov.vn', agency_code: '   ' }))).toEqual({ endpoint: undefined, egressAllowlist: [], agencyCode: null });
    expect(lgspSettingsOf(undefined)).toEqual({ endpoint: undefined, egressAllowlist: [], agencyCode: null });
  });

  it('names the adapter by the connector, and MISSING where the tenant declared none', () => {
    expect(adapterStatusOf(connector({}, 'VERIFIED'))).toBe('VERIFIED');
    expect(adapterStatusOf(connector({}, 'PROPOSED'))).toBe('PROPOSED');
    expect(adapterStatusOf(undefined)).toBe('MISSING');
  });
});
