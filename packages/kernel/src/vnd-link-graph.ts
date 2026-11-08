import { DomainError } from './errors.ts';

/**
 * The related-party link graph of the contractors (VND-3, research V6; docs/vendor-investigation.md section 2). Two contractors are linked when they share something that independent bidders do not share: the tax code head, a
 * bank account, the legal representative, an owner, the address, the telephone number, the e-mail address, and, when the receiving officer recorded them, the origin of the submission (an address or a device) and the author
 * of a file of the proposal. Every key is a hash or a normal form made by the register (VND-1) or by the trace of a submission; this module compares keys and never sees a personal value.
 * Pure, deterministic, no clock. A link is a signal for the auditors: never a conclusion, never shown to the people who took part in the package, never shown to a contractor. A key that many contractors share (the address
 * of a public accounting firm, a switchboard) is noise and is ignored with its size recorded, so that the graph does not turn into one cluster of the whole register.
 */

export const LINK_KINDS = ['TAX_HEAD', 'BANK_ACCOUNT', 'LEGAL_REPRESENTATIVE', 'OWNER', 'ADDRESS', 'PHONE', 'EMAIL', 'SUBMISSION_ORIGIN', 'SUBMISSION_DEVICE', 'FILE_AUTHOR'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/** The weights (0 to 100) of each kind, the lowest strength of a link that is kept, the size of a cluster from which it is raised, and the largest group that can share one key before the key is noise. Rule `VENDOR_LINK_RULE`. */
export interface LinkPolicy {
  weights: Readonly<Record<LinkKind, number>>;
  link_from: number;
  cluster_from: number;
  max_group_size: number;
}

/** The keys of one contractor that are compared. */
export interface PartyKeys {
  contractorId: string;
  taxHead: string | null;
  bankAccountKeys: readonly string[];
  legalRepKey: string | null;
  ownerKeys: readonly string[];
  addressKey: string | null;
  phoneKey: string | null;
  emailKey: string | null;
  originKeys: readonly string[];
  deviceKeys: readonly string[];
  fileAuthorKeys: readonly string[];
}

export interface LinkEvidence {
  kind: LinkKind;
  /** The first eight characters of the shared key (a short fingerprint to tell two evidences apart; the key itself is never shown). */
  fingerprint: string;
  weight: number;
}

export interface PartyLink {
  /** The smaller id first, so that one pair is one link. */
  a: string;
  b: string;
  evidence: LinkEvidence[];
  /** The strength, 0 to 100: the evidences are taken as independent, so the strength is one minus the product of what each leaves unexplained. */
  strength: number;
}

export interface LinkSet {
  links: PartyLink[];
  /** Keys ignored because more contractors share them than the policy allows: kind and the size of the group. */
  ignored: Array<{ kind: LinkKind; fingerprint: string; size: number }>;
}

export interface LinkCluster {
  members: string[];
  links: PartyLink[];
  /** The strongest link inside, raised by the size of the cluster (a ring of three is more telling than a pair), capped at 100. */
  score: number;
}

const bad = (field: string): DomainError => new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, field);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const LINK_PARAM_DEFAULTS: Readonly<Record<string, number>> = {
  weight_tax_head: 90,
  weight_bank_account: 95,
  weight_legal_representative: 70,
  weight_owner: 75,
  weight_address: 35,
  weight_phone: 40,
  weight_email: 40,
  weight_submission_origin: 55,
  weight_submission_device: 60,
  weight_file_author: 65,
  link_from: 50,
  cluster_from: 80,
  max_group_size: 6,
};

export function linkPolicyOf(params: unknown): LinkPolicy {
  if (!isRecord(params)) throw bad('params');
  const whole = (field: string, min: number, max: number): number => {
    const value = params[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw bad(field);
    return value;
  };
  const weights = {} as Record<LinkKind, number>;
  for (const kind of LINK_KINDS) weights[kind] = whole(`weight_${kind.toLowerCase()}`, 0, 100);
  const policy = { weights, link_from: whole('link_from', 1, 100), cluster_from: whole('cluster_from', 1, 100), max_group_size: whole('max_group_size', 2, 100) };
  if (policy.cluster_from < policy.link_from) throw bad('cluster_from');
  return policy;
}

const fingerprintOf = (key: string): string => key.slice(0, 8);

/** The keys of one kind of a party, as a flat list of keys (a party may hold several accounts, owners, origins). */
function keysOf(party: PartyKeys, kind: LinkKind): readonly string[] {
  switch (kind) {
    case 'TAX_HEAD':
      return party.taxHead === null ? [] : [party.taxHead];
    case 'BANK_ACCOUNT':
      return party.bankAccountKeys;
    case 'LEGAL_REPRESENTATIVE':
      return party.legalRepKey === null ? [] : [party.legalRepKey];
    case 'OWNER':
      return party.ownerKeys;
    case 'ADDRESS':
      return party.addressKey === null ? [] : [party.addressKey];
    case 'PHONE':
      return party.phoneKey === null ? [] : [party.phoneKey];
    case 'EMAIL':
      return party.emailKey === null ? [] : [party.emailKey];
    case 'SUBMISSION_ORIGIN':
      return party.originKeys;
    case 'SUBMISSION_DEVICE':
      return party.deviceKeys;
    case 'FILE_AUTHOR':
      return party.fileAuthorKeys;
  }
}

export const pairOf = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);

/** One minus the product of (1 - weight/100) of the evidences, in whole points: the same evidence twice is not counted twice because a pair has one evidence per kind and key. */
export function combinedStrength(weights: readonly number[]): number {
  const unexplained = weights.reduce((product, weight) => product * (1 - Math.min(100, Math.max(0, weight)) / 100), 1);
  return Math.round((1 - unexplained) * 100);
}

/**
 * The links between the parties. For each kind the contractors that hold one key are a group; a group of two to `max_group_size` links every pair in it with that evidence; a larger group is ignored. The evidences of a pair
 * across kinds are combined; a link weaker than `link_from` is dropped. A party is never linked to itself, and a kind with weight 0 is switched off.
 */
export function buildLinks(parties: readonly PartyKeys[], policy: LinkPolicy): LinkSet {
  const evidences = new Map<string, LinkEvidence[]>();
  const ignored: LinkSet['ignored'] = [];
  for (const kind of LINK_KINDS) {
    const weight = policy.weights[kind];
    if (weight <= 0) continue;
    const groups = new Map<string, Set<string>>();
    for (const party of parties) {
      for (const key of keysOf(party, kind)) {
        const members = groups.get(key) ?? new Set<string>();
        members.add(party.contractorId);
        groups.set(key, members);
      }
    }
    for (const [key, members] of [...groups.entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
      if (members.size < 2) continue;
      if (members.size > policy.max_group_size) {
        ignored.push({ kind, fingerprint: fingerprintOf(key), size: members.size });
        continue;
      }
      const ids = [...members].sort();
      for (let i = 0; i < ids.length; i += 1) {
        for (let j = i + 1; j < ids.length; j += 1) {
          const pair = `${ids[i]}|${ids[j]}`;
          const list = evidences.get(pair) ?? [];
          list.push({ kind, fingerprint: fingerprintOf(key), weight });
          evidences.set(pair, list);
        }
      }
    }
  }
  const links: PartyLink[] = [];
  for (const [pair, evidence] of evidences) {
    const [a, b] = pair.split('|') as [string, string];
    const strength = combinedStrength(evidence.map((entry) => entry.weight));
    if (strength >= policy.link_from) links.push({ a, b, evidence: evidence.sort((x, y) => y.weight - x.weight || (x.kind < y.kind ? -1 : 1)), strength });
  }
  links.sort((x, y) => y.strength - x.strength || (x.a + x.b < y.a + y.b ? -1 : 1));
  return { links, ignored };
}

/** The connected groups of the links (two or more members), strongest first. */
export function clustersOf(links: readonly PartyLink[], policy: Pick<LinkPolicy, 'cluster_from'>): LinkCluster[] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    parent.set(id, root);
    return root;
  };
  for (const link of links) {
    for (const id of [link.a, link.b]) if (!parent.has(id)) parent.set(id, id);
    const x = find(link.a);
    const y = find(link.b);
    if (x !== y) parent.set(x < y ? y : x, x < y ? x : y);
  }
  const grouped = new Map<string, { members: Set<string>; links: PartyLink[] }>();
  for (const link of links) {
    const root = find(link.a);
    const entry = grouped.get(root) ?? { members: new Set<string>(), links: [] };
    entry.members.add(link.a);
    entry.members.add(link.b);
    entry.links.push(link);
    grouped.set(root, entry);
  }
  const clusters = [...grouped.values()].map((entry): LinkCluster => {
    const top = Math.max(...entry.links.map((link) => link.strength));
    return { members: [...entry.members].sort(), links: entry.links, score: Math.min(100, top + (entry.members.size - 2) * 5) };
  });
  return clusters.filter((cluster) => cluster.score >= policy.cluster_from || cluster.members.length > 2).sort((x, y) => y.score - x.score || (x.members.join() < y.members.join() ? -1 : 1));
}

/** The stable key of a cluster for the lead table: the members sorted, so that the same group is one lead whichever scan found it. */
export const clusterKeyOf = (members: readonly string[]): string => [...members].sort().join(',');

/** The contractors of a cluster that are under a restriction in force: a new company of a banned party ("suspected re-incorporation"). */
export function restrictedAffiliates(cluster: Pick<LinkCluster, 'members'>, restrictedIds: ReadonlySet<string>): { restricted: string[]; affiliates: string[] } {
  const restricted = cluster.members.filter((id) => restrictedIds.has(id));
  return { restricted, affiliates: restricted.length === 0 ? [] : cluster.members.filter((id) => !restrictedIds.has(id)) };
}

// -- A drawing that needs no graph library -------------------------------------------------------------------------------------------------------------------------------------------------------

export interface GraphNode {
  id: string;
  x: number;
  y: number;
}

/**
 * A deterministic layout of the members of a cluster for an accessible SVG: the contractor in focus at the centre (when it is a member), the others on a circle in the order of their strongest link to it. The same input
 * gives the same drawing, so a screenshot is a test. The numbers are rounded to one decimal.
 */
export function radialLayout(members: readonly string[], links: readonly PartyLink[], focusId: string | null, width: number, height: number): GraphNode[] {
  const centre = focusId !== null && members.includes(focusId) ? focusId : null;
  const strength = (id: string): number => (centre === null ? 0 : (links.find((link) => (link.a === centre && link.b === id) || (link.b === centre && link.a === id))?.strength ?? 0));
  const ring = members.filter((id) => id !== centre).sort((x, y) => strength(y) - strength(x) || (x < y ? -1 : 1));
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) / 2 - 36;
  const round = (value: number): number => Math.round(value * 10) / 10;
  const nodes: GraphNode[] = [];
  if (centre !== null) nodes.push({ id: centre, x: round(cx), y: round(cy) });
  ring.forEach((id, index) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / Math.max(1, ring.length);
    nodes.push({ id, x: round(cx + radius * Math.cos(angle)), y: round(cy + radius * Math.sin(angle)) });
  });
  return nodes;
}
