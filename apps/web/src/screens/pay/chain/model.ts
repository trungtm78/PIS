import { acceptanceLink } from '../../ctr/acceptance/model';
import { workspaceLink as contractLink } from '../../ctr/model';
import { measurementLink } from '../../ctr/measurement/model';
import { workspaceLink as projectLink } from '../../prj/model';
import { paymentLink } from '../payment/model';
import { boardLink } from '../recon/model';
import { settlementLink } from '../settlement/model';

export const READ_PERMISSION = 'payment.chain.read';
export const PROJECT_READ_PERMISSION = 'project.read';
export const CONTRACT_READ_PERMISSION = 'contract.read';

export const CHAIN_PATH = '/pay/pay-17';

/** The trace of a payment (PAY-17) for a project, and for one of its contracts when one is named. */
export const chainLink = (projectId: string, contractId?: string): string =>
  `${CHAIN_PATH}?${new URLSearchParams({ project: projectId, ...(contractId === undefined ? {} : { contract: contractId }) }).toString()}`;

export const NODE_TYPES = ['project', 'contract', 'measurement', 'acceptance', 'payment_request', 'treasury_transaction', 'settlement_revision'] as const;
export type NodeType = (typeof NODE_TYPES)[number];

const AMOUNT = /^(0|[1-9][0-9]{0,23})$/;

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const nullableWhole = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) ? value : null);

export type Fact = string | number | boolean | null;

export interface ChainNode {
  type: NodeType;
  id: string;
  version: number | null;
  revision: number | null;
  status: string | null;
  label: string;
  contractId: string | null;
  amountVnd: string | null;
  superseded: boolean;
  facts: Record<string, Fact>;
}

export interface ChainEdge {
  from: string;
  to: string;
  relation: string;
}

export interface Chain {
  projectId: string;
  contractId: string | null;
  nodes: ChainNode[];
  edges: ChainEdge[];
  countedRequests: number;
  countedGrossVnd: string;
  settledGrossVnd: string;
  truncated: NodeType[];
  asOf: string;
}

function toNode(raw: unknown): ChainNode | undefined {
  const row = asRecord(raw);
  const type = NODE_TYPES.find((candidate) => candidate === row?.type);
  const id = text(row?.id);
  if (row === undefined || type === undefined || id === undefined) return undefined;
  const facts: Record<string, Fact> = {};
  for (const [name, value] of Object.entries(asRecord(row.facts) ?? {})) {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') facts[name] = value;
  }
  const amount = text(row.amount_vnd);
  return {
    type,
    id,
    version: nullableWhole(row.version),
    revision: nullableWhole(row.revision),
    status: nullableText(row.status),
    label: text(row.label) ?? id,
    contractId: nullableText(row.contract_id),
    amountVnd: amount !== undefined && AMOUNT.test(amount) ? amount : null,
    superseded: row.superseded === true,
    facts,
  };
}

function toEdge(raw: unknown): ChainEdge | undefined {
  const row = asRecord(raw);
  const from = text(row?.from);
  const to = text(row?.to);
  const relation = text(row?.relation);
  return from === undefined || to === undefined || relation === undefined ? undefined : { from, to, relation };
}

export function toChain(raw: unknown): Chain | undefined {
  const row = asRecord(raw);
  const projectId = text(row?.project_id);
  const totals = asRecord(row?.totals);
  if (row === undefined || projectId === undefined || !Array.isArray(row.nodes) || totals === undefined) return undefined;
  const counted = text(totals.counted_gross_vnd);
  const settled = text(totals.settled_gross_vnd);
  const requests = nullableWhole(totals.counted_requests);
  if (counted === undefined || !AMOUNT.test(counted) || settled === undefined || !AMOUNT.test(settled) || requests === null) return undefined;
  return {
    projectId,
    contractId: nullableText(row.contract_id),
    nodes: row.nodes.flatMap((node) => toNode(node) ?? []),
    edges: Array.isArray(row.edges) ? row.edges.flatMap((edge) => toEdge(edge) ?? []) : [],
    countedRequests: requests,
    countedGrossVnd: counted,
    settledGrossVnd: settled,
    truncated: Array.isArray(row.truncated) ? row.truncated.flatMap((type) => NODE_TYPES.find((candidate) => candidate === type) ?? []) : [],
    asOf: text(row.as_of) ?? '',
  };
}

/** The nodes of one type, in the order the server gave them. */
export const nodesOf = (chain: Chain, type: NodeType): ChainNode[] => chain.nodes.filter((node) => node.type === type);

/** The nodes a node leads to, by the relations of the chain. */
export const childrenOf = (chain: Chain, id: string): ChainNode[] => {
  const targets = new Set(chain.edges.filter((edge) => edge.from === id && edge.relation !== 'CORRECTS').map((edge) => edge.to));
  return chain.nodes.filter((node) => targets.has(node.id));
};

/** The measurement a measurement corrects, when it is a correction. */
export const correctsOf = (node: ChainNode): string | null => (typeof node.facts.corrects === 'string' ? node.facts.corrects : null);

/** Where a node is read and worked on: each leads to the screen of its own module, and the Treasury transaction to the board that matches it. */
export function nodeLink(node: ChainNode): string | undefined {
  switch (node.type) {
    case 'project':
      return projectLink(node.id);
    case 'contract':
      return contractLink(node.id);
    case 'measurement':
      return node.contractId === null ? undefined : measurementLink(node.contractId);
    case 'acceptance':
      return node.contractId === null ? undefined : acceptanceLink(node.contractId);
    case 'payment_request':
      return paymentLink(node.id);
    case 'treasury_transaction':
      return boardLink();
    case 'settlement_revision':
      return settlementLink(node.id);
  }
}

export const vndText = (value: string, locale: string): string => (AMOUNT.test(value) ? new Intl.NumberFormat(locale).format(BigInt(value)) : value);
