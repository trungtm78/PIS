import { DomainError } from './errors.ts';
import { CONSENT_CHANNELS, CONSENT_PURPOSES } from './notification-policy.ts';
import type { ConsentChannel, ConsentPurpose } from './notification-policy.ts';
import type { IdentityChannel } from './omni-contact.ts';

/**
 * The consent of a contact outside the tenant to be written to (ST-OMNI-003, OMNI.md 3.6, BR-NOT-07): given for a channel and a purpose, on a version of the terms, in a way that can be shown (the proof of it is kept), by someone who
 * manages the directory on the word of the person; ended by a withdrawal, once. It rests on an identity of the contact that is Verified on that channel: nobody consents to be written to at an address that was never theirs. The rules below are pure.
 */
export const CONTACT_CAPTURE_METHODS = ['IN_APP', 'WEB_FORM', 'CHANNEL_OPT_IN', 'PAPER_SCANNED'] as const;
export type ContactCaptureMethod = (typeof CONTACT_CAPTURE_METHODS)[number];

/** The ways of capture that leave something behind to show: a message of opt-in, a scanned form. The reference of it is required for them. */
const NEEDS_EVIDENCE: ReadonlySet<ContactCaptureMethod> = new Set(['CHANNEL_OPT_IN', 'PAPER_SCANNED']);

const MAX_TEXT_VERSION = 50;
const MAX_EVIDENCE = 500;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/**
 * The identity a consent on a channel rests on. A phone number carries text messages; an address, mail; a Zalo and a WhatsApp id their own channel. A push goes to a device of the tenant's own app, which a contact outside the tenant does not have:
 * there is no identity for it and no consent is taken.
 */
export function identityChannelOf(channel: ConsentChannel): IdentityChannel | undefined {
  switch (channel) {
    case 'EMAIL':
      return 'EMAIL';
    case 'SMS':
      return 'PHONE';
    case 'ZALO':
      return 'ZALO';
    case 'WHATSAPP':
      return 'WHATSAPP';
    case 'PUSH':
      return undefined;
  }
}

export interface ContactConsentDraft {
  channel: ConsentChannel;
  purpose: ConsentPurpose;
  consentTextVersion: string;
  captureMethod: ContactCaptureMethod;
  evidenceReference: string | undefined;
}

/** What a consent of a contact may carry: a channel with an identity to rest on, a purpose, the version of the terms (1 to 50), how it was taken, and the reference of the proof (required for an opt-in message and a paper form). */
export function assertContactConsent(raw: { channel?: unknown; purpose?: unknown; consent_text_version?: unknown; capture_method?: unknown; evidence_reference?: unknown }): ContactConsentDraft {
  const channel = CONSENT_CHANNELS.find((candidate) => candidate === raw.channel);
  if (channel === undefined || identityChannelOf(channel) === undefined) throw invalid('channel');
  const purpose = CONSENT_PURPOSES.find((candidate) => candidate === raw.purpose);
  if (purpose === undefined) throw invalid('purpose');
  const version = typeof raw.consent_text_version === 'string' ? raw.consent_text_version.trim() : '';
  if (version === '' || version.length > MAX_TEXT_VERSION) throw invalid('consent_text_version');
  const captureMethod = CONTACT_CAPTURE_METHODS.find((candidate) => candidate === raw.capture_method);
  if (captureMethod === undefined) throw invalid('capture_method');
  let evidenceReference: string | undefined;
  if (raw.evidence_reference !== undefined) {
    evidenceReference = typeof raw.evidence_reference === 'string' ? raw.evidence_reference.trim() : '';
    if (evidenceReference === '' || evidenceReference.length > MAX_EVIDENCE) throw invalid('evidence_reference');
  }
  if (NEEDS_EVIDENCE.has(captureMethod) && evidenceReference === undefined) throw invalid('evidence_reference');
  return { channel, purpose, consentTextVersion: version, captureMethod, evidenceReference };
}
