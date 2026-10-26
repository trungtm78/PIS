/** The permissions that decide what the member screens offer; the server still decides every request (x-permission in openapi.json). */
export const PERMISSION_READ = 'membership.read';
export const PERMISSION_INVITE = 'iam.member.invite';
export const PERMISSION_MANAGE = 'iam.member.manage';
export const PERMISSION_INVITE_GUEST = 'iam.guest.invite';
/** The permission to read the seats of the subscription (getMyUsage). */
export const PERMISSION_USAGE = 'subscription.read';

export const MEMBERSHIP_TYPES = ['STAFF', 'GUEST_CONTRACTOR', 'SERVICE_ACCOUNT'] as const;
export type MembershipType = (typeof MEMBERSHIP_TYPES)[number];
export const MEMBERSHIP_STATUSES = ['Invited', 'Active', 'Suspended', 'Ended', 'Expired'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];
export const INVITATION_STATUSES = ['Pending', 'Accepted', 'Expired', 'Revoked'] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

/** The least a reason must have (ReasonOnly in openapi.json). */
export const MIN_REASON_LENGTH = 10;
export const MAX_REASON_LENGTH = 2000;
export const MAX_NAME_LENGTH = 120;
/** How long after the latest end of the contracts a guest may stay (BR-IAM-08, the design's assumption). */
export const GUEST_GRACE_DAYS = 365;
export const PAGE_SIZE = 50;

/** One membership of the directory, as `get_resources_membership` lists it (CR-ADM-07 added the last six fields). */
export interface Member {
  id: string;
  displayName: string;
  email: string;
  status: MembershipStatus;
  organizationId: string;
  membershipType: MembershipType;
  validUntil: string | null;
  /** The value `If-Match` carries for suspend, reactivate and end. */
  version: number;
  roleCodes: string[];
  invitationStatus: InvitationStatus | null;
  contractorId: string | null;
  contractorName: string | null;
  contracts: Array<{ id: string; code: string }>;
  /** What the server says about the lifecycle commands on this member (BR-IAM-05: the reader's unit reaches them and the reader outranks the member); undefined when it says nothing. */
  canManage: boolean | undefined;
}

export interface MemberPage {
  items: Member[];
  nextCursor: string | undefined;
}

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined => allowed.find((candidate) => candidate === value);

export function toMember(raw: unknown): Member {
  const row: Raw = isRecord(raw) ? raw : {};
  return {
    id: text(row.id),
    displayName: text(row.display_name),
    email: text(row.email),
    status: oneOf(row.status, MEMBERSHIP_STATUSES) ?? 'Invited',
    organizationId: text(row.organization_id),
    membershipType: oneOf(row.membership_type, MEMBERSHIP_TYPES) ?? 'STAFF',
    validUntil: nullableText(row.valid_until),
    version: count(row.version),
    roleCodes: Array.isArray(row.role_codes) ? row.role_codes.filter((code): code is string => typeof code === 'string') : [],
    invitationStatus: oneOf(row.invitation_status, INVITATION_STATUSES) ?? null,
    contractorId: nullableText(row.contractor_id),
    contractorName: nullableText(row.contractor_name),
    contracts: Array.isArray(row.contracts)
      ? row.contracts.flatMap((contract) => (isRecord(contract) && typeof contract.id === 'string' ? [{ id: contract.id, code: text(contract.code) }] : []))
      : [],
    canManage: typeof row.can_manage === 'boolean' ? row.can_manage : undefined,
  };
}

export function toMemberPage(raw: unknown): MemberPage {
  const page: Raw = isRecord(raw) ? raw : {};
  return {
    items: Array.isArray(page.items) ? page.items.map(toMember) : [],
    nextCursor: typeof page.next_cursor === 'string' ? page.next_cursor : undefined,
  };
}

/** The seats in use against what the licence or the plan allows; `limit` is undefined when nothing caps them. */
export interface SeatCount {
  used: number;
  limit: number | undefined;
}

export interface SeatUsage {
  staff: SeatCount;
  guests: SeatCount;
}

function toSeatCount(raw: unknown): SeatCount {
  const row: Raw = isRecord(raw) ? raw : {};
  return { used: count(row.used), limit: typeof row.limit === 'number' && Number.isFinite(row.limit) ? row.limit : undefined };
}

/** The seats of `getMyUsage` (SAS BR-SAS-09): staff seats and guest seats, each used out of its limit. */
export function toSeatUsage(raw: unknown): SeatUsage {
  const row: Raw = isRecord(raw) ? raw : {};
  return { staff: toSeatCount(row.seats), guests: toSeatCount(row.guest_seats) };
}

/** A unit of the tenant, as the invitation picks the unit of the new member. */
export interface UnitOption {
  id: string;
  code: string;
  name: string;
}

export function toUnitOption(raw: unknown): UnitOption[] {
  const row: Raw = isRecord(raw) ? raw : {};
  return typeof row.id === 'string' ? [{ id: row.id, code: text(row.code), name: text(row.name) }] : [];
}

/** The statuses of a contract that a guest may be given (BR-IAM-08: the contract is in force). */
export const GUEST_CONTRACT_STATUSES: readonly string[] = ['SIGNED', 'ACTIVE', 'SUSPENDED', 'COMPLETED'];

/** One contract of the picker of ADM-17 (`get_resources_contract`, CR-ADM-07). */
export interface ContractOption {
  id: string;
  code: string;
  status: string;
  contractorId: string;
  contractorName: string;
  /** Planned completion, `YYYY-MM-DD`; null when none is set. */
  completionDue: string | null;
}

export function toContractOption(raw: unknown): ContractOption[] {
  const row: Raw = isRecord(raw) ? raw : {};
  if (typeof row.id !== 'string' || typeof row.contractor_id !== 'string') return [];
  return [
    {
      id: row.id,
      code: text(row.code),
      status: text(row.status),
      contractorId: row.contractor_id,
      contractorName: text(row.contractor_name) || row.contractor_id,
      completionDue: nullableText(row.completion_due),
    },
  ];
}

/** The lifecycle commands a member row may offer. */
export type Lifecycle = 'suspend' | 'reactivate' | 'end';

/** What each lifecycle command may start from (the TRANSITIONS table of the server). */
export function lifecycleOptions(status: MembershipStatus): readonly Lifecycle[] {
  switch (status) {
    case 'Active':
      return ['suspend', 'end'];
    case 'Suspended':
      return ['reactivate', 'end'];
    case 'Invited':
      return ['end'];
    case 'Ended':
    case 'Expired':
      return [];
  }
}
