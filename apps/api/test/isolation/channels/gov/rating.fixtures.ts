import type { TenantName } from '../../suite';
import { fixtureId } from './support';
import type { Marker } from './support';

/** The group digit of the contract rating fragment (CA-3) in the ids of its fixtures. */
const GROUP = 8;

const FAMILY = {
  read: 0x01,
  notify: 0x02,
  respond: 0x03,
  adopt: 0x04,
  withdraw: 0x05,
} as const;

const LABEL: Readonly<Record<TenantName, string>> = { 'TNT-A': 'Alpha', 'TNT-B': 'Beta' };
const UPPER: Readonly<Record<TenantName, string>> = { 'TNT-A': 'ALPHA', 'TNT-B': 'BETA' };
const HEX: Readonly<Record<TenantName, string>> = { 'TNT-A': 'a8', 'TNT-B': 'b8' };

/** One proposal of a rating the foreign commands aim at: each command has a proposal of its own, so what the owner does in the control run never takes the object of another case away. */
export interface RatingProposalFixture {
  id: string;
  /** Distinct for each proposal: one live proposal per contract, kind and period. */
  periodLabel: string;
  state: 'PROPOSED' | 'NOTIFIED' | 'RESPONDED';
  note: string;
  digest: string;
}

export interface RatingFixture {
  read: RatingProposalFixture;
  notify: RatingProposalFixture;
  respond: RatingProposalFixture;
  adopt: RatingProposalFixture;
  withdraw: RatingProposalFixture;
}

function ratingOf(tenant: TenantName): RatingFixture {
  const label = LABEL[tenant];
  const upper = UPPER[tenant];
  const make = (family: keyof typeof FAMILY, state: RatingProposalFixture['state'], serial: number): RatingProposalFixture => ({
    id: fixtureId(tenant, GROUP, FAMILY[family]),
    periodLabel: `${upper}-RT-${serial}`,
    state,
    note: `${label} tenant proposal of the rating of the contractor that is ${state.toLowerCase()} number ${serial}`,
    digest: `${HEX[tenant]}${String(serial).padStart(2, '0')}`.repeat(16),
  });
  return {
    read: make('read', 'PROPOSED', 1),
    notify: make('notify', 'PROPOSED', 2),
    respond: make('respond', 'NOTIFIED', 3),
    adopt: make('adopt', 'RESPONDED', 4),
    withdraw: make('withdraw', 'PROPOSED', 5),
  };
}

export const RATING_FIXTURES: Readonly<Record<TenantName, RatingFixture>> = { 'TNT-A': ratingOf('TNT-A'), 'TNT-B': ratingOf('TNT-B') };

/** Every id and every distinctive text of the fixtures of a tenant: none of them may appear in an answer given to the other tenant. */
export function ratingMarkers(tenant: TenantName): Marker[] {
  const fixture = RATING_FIXTURES[tenant];
  return (Object.entries(fixture) as Array<[string, RatingProposalFixture]>).flatMap(([name, one]) => [
    { kind: `rating proposal ${name} id`, value: one.id },
    { kind: `rating proposal ${name} period`, value: one.periodLabel },
    { kind: `rating proposal ${name} note`, value: one.note },
    { kind: `rating proposal ${name} digest`, value: one.digest },
  ]);
}
