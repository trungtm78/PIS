import { createHash } from 'node:crypto';
import { DomainError, INCOMING_URGENCIES } from '@machvon/kernel';
import type { IncomingUrgency } from '@machvon/kernel';
import type { InboundLetter, InteropCodec, OutboundEnvelopeInput } from './interop-port';

/** The name of the stand-in format: it is not the edXML of QCVN 102:2016, which waits for the specification of the pilot tenant [CXN-06]. */
export const JSON_ENVELOPE_FORMAT = 'machvon.lgsp.json/1';
const PDF_MEDIA_TYPE = 'application/pdf';
const SHA256 = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT = 500;

type Raw = Record<string, unknown>;
const record = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const invalid = (member: string): DomainError => new DomainError('ENVELOPE_INVALID', 422, member);

function required(value: unknown, member: string): string {
  if (typeof value !== 'string') throw invalid(member);
  const trimmed = value.normalize('NFC').trim();
  if (trimmed === '' || trimmed.length > MAX_TEXT) throw invalid(member);
  return trimmed;
}

const optional = (value: unknown, member: string): string | undefined => (value === undefined ? undefined : required(value, member));

/**
 * The envelope as one JSON document: the facts of the letter and its PDF in base64 with the digest of the PDF. It is the format MOCK adapters speak, so the whole path (build, send, receive, read) can be tried before
 * the format of the LGSP of the pilot tenant is known. An envelope that is not JSON of this shape, whose PDF does not match its digest or whose facts do not fit is 422 `ENVELOPE_INVALID` naming the member.
 */
export class JsonInteropCodec implements InteropCodec {
  encode(input: OutboundEnvelopeInput): Buffer {
    const pdf = Buffer.from(input.pdf);
    return Buffer.from(
      JSON.stringify({
        format: JSON_ENVELOPE_FORMAT,
        message_id: input.messageId,
        sender_code: input.senderCode,
        receiver_code: input.receiverCode,
        document: { symbol: input.symbol, issued_on: input.issuedOn, title: input.title, doc_type_code: input.docTypeCode, urgency: input.urgency },
        attachment: { media_type: PDF_MEDIA_TYPE, sha256: createHash('sha256').update(pdf).digest('hex'), content_base64: pdf.toString('base64') },
      }),
      'utf8',
    );
  }

  decode(bytes: Uint8Array): InboundLetter {
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch {
      throw invalid('envelope');
    }
    const envelope = record(parsed);
    if (envelope?.format !== JSON_ENVELOPE_FORMAT) throw invalid('format');
    const document = record(envelope.document);
    if (document === undefined) throw invalid('document');
    const attachment = record(envelope.attachment);
    if (attachment === undefined || attachment.media_type !== PDF_MEDIA_TYPE) throw invalid('attachment');
    const content = attachment.content_base64;
    const claimed = attachment.sha256;
    if (typeof content !== 'string' || typeof claimed !== 'string' || !SHA256.test(claimed)) throw invalid('attachment');
    const pdf = Buffer.from(content, 'base64');
    if (pdf.length === 0 || createHash('sha256').update(pdf).digest('hex') !== claimed) throw invalid('attachment.sha256');
    const issuedOn = optional(document.issued_on, 'document.issued_on');
    if (issuedOn !== undefined && (!ISO_DATE.test(issuedOn) || Number.isNaN(Date.parse(issuedOn)))) throw invalid('document.issued_on');
    const urgency = document.urgency === undefined ? 'NORMAL' : (INCOMING_URGENCIES as readonly unknown[]).find((candidate) => candidate === document.urgency);
    if (urgency === undefined) throw invalid('document.urgency');
    return {
      title: required(document.title, 'document.title'),
      docTypeCode: required(document.doc_type_code, 'document.doc_type_code'),
      originalSymbol: optional(document.symbol, 'document.symbol'),
      originalIssuedOn: issuedOn,
      senderName: optional(document.sender_name, 'document.sender_name'),
      urgency: urgency as IncomingUrgency,
      pdf,
    };
  }
}
