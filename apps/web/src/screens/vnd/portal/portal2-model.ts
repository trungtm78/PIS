import type { components } from '@machvon/contracts';
import type { Tone } from '../../../ui';

/**
 * VND-23 (invitations of contractors to the portal through the registry) and VND-24 (the files of the contractor on the portal), lane PORTAL-2. The shapes are the contract's; nothing here is invented.
 */
type S = components['schemas'];
export type InvitationLine = S['PortalInvitationLine'];
export type InvitationPage = S['PortalInvitationPage'];
export type AttachmentLine = S['PortalAttachment'];
export type AttachmentPage = S['PortalAttachmentPage'];

export type InvitationStatus = InvitationLine['status'];
export type ContactBasis = InvitationLine['contact_basis'];
export type UploadPurpose = AttachmentLine['purpose'];

export const PORTAL2_PERMISSION = {
  manage: 'vnd.portal.manage',
  invite: 'vnd.portal.invite',
  approve: 'vnd.portal.invite.approve',
  revoke: 'vnd.portal.invite.revoke',
  read: 'vnd.portal.read',
  upload: 'vnd.portal.upload',
} as const;

export const INVITATION_STATUSES: readonly InvitationStatus[] = ['PROPOSED', 'APPROVED', 'REJECTED', 'EXPIRED', 'REVOKED'];
export const CONTACT_BASES: readonly ContactBasis[] = ['REGISTRY_EMAIL', 'REPRESENTATIVE_LETTER', 'TAX_AUTHORITY_RECORD', 'OTHER_EVIDENCE'];
export const UPLOAD_PURPOSES: readonly UploadPurpose[] = ['REQUEST_RESPONSE', 'CERTIFICATE', 'REMEDIATION_EVIDENCE', 'OTHER'];
export const UPLOAD_MIMES: readonly string[] = ['application/pdf', 'image/png', 'image/jpeg'];

const STATUS_TONE: Readonly<Record<InvitationStatus, Tone>> = { PROPOSED: 'info', APPROVED: 'success', REJECTED: 'neutral', EXPIRED: 'warning', REVOKED: 'danger' };
const STATUS_ICON: Readonly<Record<InvitationStatus, string>> = { PROPOSED: '○', APPROVED: '✓', REJECTED: '⊘', EXPIRED: '⌛', REVOKED: '⛔' };
export const invitationTone = (status: InvitationStatus): Tone => STATUS_TONE[status];
export const invitationIcon = (status: InvitationStatus): string => STATUS_ICON[status];

/** A proof that is a named paper needs its reference; the registry e-mail needs none (the server compares the address with the entry). */
export const basisNeedsReference = (basis: string): boolean => basis !== '' && basis !== 'REGISTRY_EMAIL';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isEmail = (value: string): boolean => EMAIL.test(value.trim()) && value.trim().length >= 5 && value.trim().length <= 254;

export type UploadProblem = 'EMPTY' | 'TOO_LARGE' | 'TYPE';

/** The checks the browser can make before it sends a file: not empty, not above the limit of the rule, one of the types the server accepts. The server judges the bytes again. */
export function uploadProblem(file: { size: number; type: string }, limits: { max_bytes: number; mimes: readonly string[] }): UploadProblem | null {
  if (file.size <= 0) return 'EMPTY';
  if (file.size > limits.max_bytes) return 'TOO_LARGE';
  if (!limits.mimes.includes(file.type)) return 'TYPE';
  return null;
}

/** The size in the unit a person reads: kilobytes below a megabyte, else megabytes with one decimal. */
export function sizeText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(Math.round((bytes * 10) / (1024 * 1024)) / 10).toFixed(1)} MB`;
}

/** The title offered for a chosen file: its name without the extension, cut to the 200 characters of the contract. */
export function titleOfFile(name: string): string {
  const dot = name.lastIndexOf('.');
  const base = (dot > 0 ? name.slice(0, dot) : name).trim();
  return (base === '' ? name.trim() : base).slice(0, 200);
}
