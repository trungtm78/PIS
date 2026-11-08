import { addWorkingDays, daysInStep, medianOf, workflowDaysBetween } from './bid-workflow.ts';
import type { EntryKind, WorkflowDefinition, WorkflowStatus } from './bid-workflow.ts';
import type { WorkCalendarSource } from './working-time.ts';

/**
 * The process tree of the packages of a procurement (PRC-1, "process tree"): every package is in exactly one state, the states are the steps of the workflow of its selection method (each split into on track, late, returned and on hold),
 * plus the states a package can be in outside the steps (not started, completed, cancelled). The tree says, for every state, how many packages are in it, their total value, their share of all, the median days they have spent in it, how
 * many are late, and how many moved along each edge (from a state to another) during the period; every node also says the path from the root to it, so a click can open the packages of the node.
 *
 * Pure: the definitions, the packages and the calendars come in as arguments, so the same function answers the tree, the packages of a node (`packagesOfNode`) and the tests. Money is a decimal text of whole VND, summed exactly with BigInt.
 */

export const TREE_SUBSTATES = ['ON_HOLD', 'LATE', 'RETURNED', 'ON_TRACK'] as const;
/** A package that is in a step is in one of these, the first that applies: held; late (its due day has passed); returned (it came back to the step); on track. They do not overlap, so the four add up to the step. */
export type TreeSubstate = (typeof TREE_SUBSTATES)[number];
export const TREE_TERMINALS = ['NOT_STARTED', 'COMPLETED', 'CANCELLED'] as const;
export type TreeTerminal = (typeof TREE_TERMINALS)[number];
export const TREE_NODE_KINDS = ['ROOT', 'METHOD', 'STEP', 'SUBSTATE', 'TERMINAL'] as const;
export type TreeNodeKind = (typeof TREE_NODE_KINDS)[number];

export type TransitionKind = 'START' | 'ADVANCE' | 'RETURN' | 'CORRECTION' | 'HOLD' | 'RESUME' | 'CANCEL' | 'COMPLETE';

/** One move of a package, as the append-only history of the steps and the log of the workflow say it. `from`/`to` are step codes (null before the start and after the end). */
export interface TreeTransition {
  kind: TransitionKind;
  from: string | null;
  to: string | null;
  /** The day it happened, `YYYY-MM-DD`. */
  on: string;
}

export interface TreePackage {
  id: string;
  method: string;
  /** `NOT_STARTED` for an approved package whose workflow has not been started. */
  status: WorkflowStatus | 'NOT_STARTED';
  currentStep: string | null;
  /** The day the package entered its current step and how it got there; null when it is in no step. */
  enteredOn: string | null;
  enteredVia: EntryKind | null;
  dueOn: string | null;
  /** Whole VND as a decimal text. */
  valueVnd: string;
  transitions: readonly TreeTransition[];
}

export interface TreeNode {
  id: string;
  parentId: string | null;
  kind: TreeNodeKind;
  method: string | null;
  stepCode: string | null;
  substate: TreeSubstate | null;
  terminal: TreeTerminal | null;
  /** The name from the definition for a method or a step; null for the others (the screen names them by `substate`/`terminal`). */
  label: string | null;
  order: number | null;
  count: number;
  valueVnd: string;
  /** count / all packages and value / all value, whole numbers of ten-thousandths (1234 = 12.34%) so no float is shown as a number; 0 when there is nothing. */
  shareCountBp: number;
  shareValueBp: number;
  /** The median days the packages in the node have been in it (working days when the calendar allows, else calendar days); null for a node that has none or a terminal. */
  medianDays: number | null;
  medianBasis: 'WORKING_DAYS' | 'CALENDAR_DAYS';
  lateCount: number;
  /** The ids from the root to this node, inclusive. */
  path: readonly string[];
  /** The steps a package walks from the first one to this node (for a step or a sub-state of it), else empty. */
  route: readonly string[];
}

export interface TreeEdge {
  from: string;
  to: string;
  kind: 'ADVANCE' | 'RETURN' | 'CANCEL' | 'COMPLETE' | 'HOLD';
  /** How many moves along this edge fell inside the period. */
  count: number;
}

export interface ProcessTree {
  asOf: string;
  period: { from: string; to: string };
  totalCount: number;
  totalValueVnd: string;
  nodes: readonly TreeNode[];
  edges: readonly TreeEdge[];
}

export interface TreeOptions {
  asOf: string;
  period: { from: string; to: string };
  calendars?: WorkCalendarSource | undefined;
  /** Show a method that has no package too (the whole route of the definitions); default: only the methods that have packages. */
  includeEmptyMethods?: boolean;
}

export const treeNodeId = {
  root: 'ROOT',
  method: (method: string): string => `M:${method}`,
  step: (method: string, step: string): string => `S:${method}:${step}`,
  substate: (method: string, step: string, substate: TreeSubstate): string => `S:${method}:${step}:${substate}`,
  terminal: (method: string, terminal: TreeTerminal): string => `T:${method}:${terminal}`,
};

/** The leaf of the tree a package is in, given its method definition: a sub-state of its step, or a terminal. */
export function leafOf(pkg: TreePackage, asOf: string): string {
  if (pkg.status === 'NOT_STARTED') return treeNodeId.terminal(pkg.method, 'NOT_STARTED');
  if (pkg.status === 'COMPLETED') return treeNodeId.terminal(pkg.method, 'COMPLETED');
  if (pkg.status === 'CANCELLED') return treeNodeId.terminal(pkg.method, 'CANCELLED');
  const step = pkg.currentStep ?? '';
  return treeNodeId.substate(pkg.method, step, substateOf(pkg, asOf));
}

export function substateOf(pkg: Pick<TreePackage, 'status' | 'dueOn' | 'enteredVia'>, asOf: string): TreeSubstate {
  if (pkg.status === 'ON_HOLD') return 'ON_HOLD';
  if (pkg.dueOn !== null && asOf > pkg.dueOn) return 'LATE';
  if (pkg.enteredVia === 'RETURN' || pkg.enteredVia === 'CORRECTION') return 'RETURNED';
  return 'ON_TRACK';
}

const idsOf = (leaf: string): string[] => {
  // ROOT > M:method > S:method:step > S:method:step:SUB   |   ROOT > M:method > T:method:TERMINAL
  const parts = leaf.split(':');
  const kind = parts[0];
  const method = parts[1] as string;
  const chain: string[] = [treeNodeId.root, treeNodeId.method(method)];
  if (kind === 'T') chain.push(leaf);
  else {
    chain.push(treeNodeId.step(method, parts[2] as string));
    if (parts.length === 4) chain.push(leaf);
  }
  return chain;
};

const ancestorsOf = (leaf: string): string[] => idsOf(leaf);
const pathOf = (id: string): string[] => (id === treeNodeId.root ? [treeNodeId.root] : id.startsWith('M:') ? [treeNodeId.root, id] : idsOf(id));

const bp = (part: bigint, whole: bigint): number => (whole === 0n ? 0 : Number((part * 10_000n + whole / 2n) / whole));

interface Accumulator {
  count: number;
  value: bigint;
  days: number[];
  daysWorking: boolean;
  late: number;
}
const blank = (): Accumulator => ({ count: 0, value: 0n, days: [], daysWorking: true, late: 0 });

/** The edges of the flow the transitions of a package trace: where a move from one step to another is counted. */
function edgeOf(method: string, move: TreeTransition): { from: string; to: string; kind: TreeEdge['kind'] } | null {
  switch (move.kind) {
    case 'ADVANCE':
      return move.from === null || move.to === null ? null : { from: treeNodeId.step(method, move.from), to: treeNodeId.step(method, move.to), kind: 'ADVANCE' };
    case 'RETURN':
    case 'CORRECTION':
      return move.from === null || move.to === null ? null : { from: treeNodeId.step(method, move.from), to: treeNodeId.step(method, move.to), kind: 'RETURN' };
    case 'COMPLETE':
      return move.from === null ? null : { from: treeNodeId.step(method, move.from), to: treeNodeId.terminal(method, 'COMPLETED'), kind: 'COMPLETE' };
    case 'CANCEL':
      return move.from === null ? null : { from: treeNodeId.step(method, move.from), to: treeNodeId.terminal(method, 'CANCELLED'), kind: 'CANCEL' };
    case 'HOLD':
      return move.from === null ? null : { from: treeNodeId.step(method, move.from), to: treeNodeId.substate(method, move.from, 'ON_HOLD'), kind: 'HOLD' };
    case 'START':
      return move.to === null ? null : { from: treeNodeId.terminal(method, 'NOT_STARTED'), to: treeNodeId.step(method, move.to), kind: 'ADVANCE' };
    case 'RESUME':
      return null;
  }
}

/**
 * Builds the process tree. The definitions give the steps (a method with packages but no definition shows no step and puts its packages under the method node: a missing definition is visible, not hidden). Counts are of packages NOW in
 * the node; edges are the moves of the period; `lateCount` is the packages in the node whose due day has passed on `asOf` and that are not on hold.
 */
export function buildProcessTree(definitions: readonly WorkflowDefinition[], packages: readonly TreePackage[], options: TreeOptions): ProcessTree {
  const byMethod = new Map(definitions.map((definition) => [definition.method as string, definition]));
  const methodsWithPackages = [...new Set(packages.map((pkg) => pkg.method))];
  const methods: string[] = options.includeEmptyMethods === true ? [...new Set([...definitions.map((definition) => definition.method as string), ...methodsWithPackages])] : methodsWithPackages;
  methods.sort((left, right) => left.localeCompare(right));

  const accumulators = new Map<string, Accumulator>();
  const at = (id: string): Accumulator => {
    let found = accumulators.get(id);
    if (found === undefined) {
      found = blank();
      accumulators.set(id, found);
    }
    return found;
  };
  let totalValue = 0n;
  for (const pkg of packages) {
    const value = BigInt(pkg.valueVnd);
    totalValue += value;
    // A package under a step the definition does not have (a definition edited since) goes under its method node, not into a step that is not there.
    const definition = byMethod.get(pkg.method);
    const stepKnown = pkg.currentStep !== null && definition?.steps.some((step) => step.code === pkg.currentStep) === true;
    const stepped = pkg.status === 'IN_PROGRESS' || pkg.status === 'ON_HOLD';
    const leaf = stepped && !stepKnown ? treeNodeId.method(pkg.method) : leafOf(pkg, options.asOf);
    const chain = leaf === treeNodeId.method(pkg.method) ? [treeNodeId.root, leaf] : ancestorsOf(leaf);
    const dwell = stepped && pkg.enteredOn !== null ? daysInStep(options.calendars, pkg.enteredOn, options.asOf) : null;
    const late = stepped && pkg.status === 'IN_PROGRESS' && pkg.dueOn !== null && options.asOf > pkg.dueOn;
    for (const id of chain) {
      const accumulator = at(id);
      accumulator.count += 1;
      accumulator.value += value;
      if (late) accumulator.late += 1;
      if (dwell !== null) {
        if (dwell.workingDays === null) accumulator.daysWorking = false;
        accumulator.days.push(dwell.workingDays ?? dwell.calendarDays);
      }
    }
  }

  // When any package in a node lacks working days the node reads calendar days for all of them.
  const calendarDaysOf = (pkgsInNode: readonly TreePackage[]): number[] => pkgsInNode.map((pkg) => (pkg.enteredOn === null ? 0 : daysInStep(undefined, pkg.enteredOn, options.asOf).calendarDays));

  const total = packages.length;
  const nodes: TreeNode[] = [];
  const nodeOf = (spec: {
    id: string;
    parentId: string | null;
    kind: TreeNodeKind;
    method?: string;
    stepCode?: string;
    substate?: TreeSubstate;
    terminal?: TreeTerminal;
    label?: string | null;
    order?: number | null;
    route?: readonly string[];
    leafPredicate?: (pkg: TreePackage) => boolean;
  }): TreeNode => {
    const accumulator = accumulators.get(spec.id) ?? blank();
    let medianDays: number | null;
    let basis: TreeNode['medianBasis'] = 'WORKING_DAYS';
    if (spec.kind === 'TERMINAL' || accumulator.days.length === 0) medianDays = null;
    else if (accumulator.daysWorking) medianDays = medianOf(accumulator.days);
    else {
      const inside = packages.filter((pkg) => (pkg.status === 'IN_PROGRESS' || pkg.status === 'ON_HOLD') && spec.leafPredicate?.(pkg) === true);
      basis = 'CALENDAR_DAYS';
      medianDays = medianOf(spec.leafPredicate === undefined ? accumulator.days : calendarDaysOf(inside));
    }
    return {
      id: spec.id,
      parentId: spec.parentId,
      kind: spec.kind,
      method: spec.method ?? null,
      stepCode: spec.stepCode ?? null,
      substate: spec.substate ?? null,
      terminal: spec.terminal ?? null,
      label: spec.label ?? null,
      order: spec.order ?? null,
      count: accumulator.count,
      valueVnd: accumulator.value.toString(),
      shareCountBp: total === 0 ? 0 : Math.round((accumulator.count / total) * 10_000),
      shareValueBp: bp(accumulator.value, totalValue),
      medianDays,
      medianBasis: basis,
      lateCount: accumulator.late,
      path: pathOf(spec.id),
      route: spec.route ?? [],
    };
  };

  nodes.push(nodeOf({ id: treeNodeId.root, parentId: null, kind: 'ROOT' }));
  for (const method of methods) {
    const definition = byMethod.get(method);
    const methodId = treeNodeId.method(method);
    nodes.push(nodeOf({ id: methodId, parentId: treeNodeId.root, kind: 'METHOD', method, label: definition?.name ?? null }));
    nodes.push(nodeOf({ id: treeNodeId.terminal(method, 'NOT_STARTED'), parentId: methodId, kind: 'TERMINAL', method, terminal: 'NOT_STARTED' }));
    const route: string[] = [];
    for (const step of definition?.steps ?? []) {
      route.push(step.code);
      const stepId = treeNodeId.step(method, step.code);
      const inStep = (pkg: TreePackage): boolean => (pkg.status === 'IN_PROGRESS' || pkg.status === 'ON_HOLD') && pkg.currentStep === step.code && pkg.method === method;
      nodes.push(nodeOf({ id: stepId, parentId: methodId, kind: 'STEP', method, stepCode: step.code, label: step.name, order: step.order, route: [...route], leafPredicate: inStep }));
      for (const substate of TREE_SUBSTATES) {
        nodes.push(
          nodeOf({
            id: treeNodeId.substate(method, step.code, substate),
            parentId: stepId,
            kind: 'SUBSTATE',
            method,
            stepCode: step.code,
            substate,
            order: step.order,
            route: [...route],
            leafPredicate: (pkg) => inStep(pkg) && substateOf(pkg, options.asOf) === substate,
          }),
        );
      }
    }
    nodes.push(nodeOf({ id: treeNodeId.terminal(method, 'COMPLETED'), parentId: methodId, kind: 'TERMINAL', method, terminal: 'COMPLETED' }));
    nodes.push(nodeOf({ id: treeNodeId.terminal(method, 'CANCELLED'), parentId: methodId, kind: 'TERMINAL', method, terminal: 'CANCELLED' }));
  }

  const edgeCounts = new Map<string, TreeEdge>();
  for (const pkg of packages) {
    for (const move of pkg.transitions) {
      if (move.on < options.period.from || move.on > options.period.to) continue;
      const edge = edgeOf(pkg.method, move);
      if (edge === null) continue;
      const key = `${edge.from}>${edge.to}>${edge.kind}`;
      const found = edgeCounts.get(key);
      if (found === undefined) edgeCounts.set(key, { ...edge, count: 1 });
      else found.count += 1;
    }
  }
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = [...edgeCounts.values()].filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to)).sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to) || left.kind.localeCompare(right.kind));

  return { asOf: options.asOf, period: options.period, totalCount: total, totalValueVnd: totalValue.toString(), nodes, edges };
}

/** Whether a package is in a node (the node itself or any node under it): the rule the list of a node uses, the same as the one the tree counts with. */
export function packageInNode(pkg: TreePackage, nodeId: string, asOf: string, definitions: readonly WorkflowDefinition[]): boolean {
  if (nodeId === treeNodeId.root) return true;
  const definition = definitions.find((one) => one.method === pkg.method);
  const stepped = pkg.status === 'IN_PROGRESS' || pkg.status === 'ON_HOLD';
  const stepKnown = pkg.currentStep !== null && definition?.steps.some((step) => step.code === pkg.currentStep) === true;
  const leaf = stepped && !stepKnown ? treeNodeId.method(pkg.method) : leafOf(pkg, asOf);
  const chain = leaf === treeNodeId.method(pkg.method) ? [treeNodeId.root, leaf] : ancestorsOf(leaf);
  return chain.includes(nodeId);
}

export const packagesOfNode = (packages: readonly TreePackage[], nodeId: string, asOf: string, definitions: readonly WorkflowDefinition[]): TreePackage[] => packages.filter((pkg) => packageInNode(pkg, nodeId, asOf, definitions));

/** A node id is well formed: the root, `M:method`, `S:method:step`, `S:method:step:SUB`, or `T:method:TERMINAL`. */
export function isTreeNodeId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value === treeNodeId.root) return true;
  const parts = value.split(':');
  const code = /^[A-Z][A-Z0-9_]{1,39}$/;
  if (parts[0] === 'M') return parts.length === 2 && code.test(parts[1] as string);
  if (parts[0] === 'T') return parts.length === 3 && code.test(parts[1] as string) && (TREE_TERMINALS as readonly string[]).includes(parts[2] as string);
  if (parts[0] === 'S') return (parts.length === 3 || parts.length === 4) && code.test(parts[1] as string) && code.test(parts[2] as string) && (parts.length === 3 || (TREE_SUBSTATES as readonly string[]).includes(parts[3] as string));
  return false;
}

/** The due day of a step entered on `enteredOn`: working days on the calendar; `undefined` when a year has no published calendar. Re-exported here so the store counts the due of a visit exactly as the tree reads it. */
export const stepDueOn = (calendars: WorkCalendarSource | undefined, enteredOn: string, standardWorkingDays: number): string | undefined => addWorkingDays(calendars, enteredOn, standardWorkingDays);
export const daysLate = (dueOn: string, today: string): number => Math.max(0, workflowDaysBetween(dueOn, today));
