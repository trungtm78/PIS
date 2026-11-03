import { DomainError, isProductionEnvironment } from '@machvon/kernel';
import type { TableMeasure } from '@machvon/kernel';
import type { MeasuredTenant } from './placement-measure.ts';

/** The move the worker carries out: which tenant, from which placement to which. */
export interface MoveRef {
  migrationId: string;
  tenantId: string;
  fromPlacementId: string;
  toPlacementId: string;
}

/** What the original holds right now. A mover that replicates by itself (logical replication with a filter on the tenant) ignores it; the stand-in uses it to make its copy. */
export interface MoveSource {
  measure(): Promise<MeasuredTenant>;
}

/**
 * The data path of a promotion (SAS.md 3.3, the work of `PlacementMigrationWorkflow`): it copies the rows of the tenant and the objects under its prefix to the database of the target placement, keeps the copy in step with the
 * original, tells what the copy holds in the same terms as the original is measured (`measureTarget`), destroys the copy of a migration that did not complete and deletes the old data of one that did. Every operation is
 * idempotent by the move, and a copy that is asked for again carries on. There is no real mover until the replication on the chosen cloud is confirmed (spike R2, D02); see `docs/sas-silo-promotion.md`.
 */
export interface PlacementMover {
  /** The first copy of the data of the tenant. */
  copy(move: MoveRef, source: MoveSource): Promise<void>;
  /** Brings the copy up to date with the original (while the cutover waits, and the last difference once writes are frozen). */
  sync(move: MoveRef, source: MoveSource): Promise<void>;
  /** What the copy holds, measured the way the original is. */
  measureTarget(move: MoveRef): Promise<TableMeasure[]>;
  /** Destroys the copy: the migration ended without a switch. */
  discardTarget(move: MoveRef): Promise<void>;
  /** Deletes the old data of the tenant at the placement it left: the migration completed and its days are over. */
  purgeSource(move: MoveRef): Promise<void>;
}

/** The mover of an environment that has none: every operation is refused, so a migration stays where it is and nothing is claimed to have moved. */
export class UnboundPlacementMover implements PlacementMover {
  copy(): Promise<void> {
    return this.refuse();
  }

  sync(): Promise<void> {
    return this.refuse();
  }

  measureTarget(): Promise<TableMeasure[]> {
    return this.refuse();
  }

  discardTarget(): Promise<void> {
    return this.refuse();
  }

  purgeSource(): Promise<void> {
    return this.refuse();
  }

  private refuse(): Promise<never> {
    return Promise.reject(new DomainError('PLACEMENT_MOVER_UNAVAILABLE', 503));
  }
}

const keyOf = (move: Pick<MoveRef, 'tenantId' | 'toPlacementId'>): string => `${move.tenantId}:${move.toPlacementId}`;
const cloneTables = (tables: readonly TableMeasure[]): TableMeasure[] => tables.map((table) => ({ ...table, money: { ...table.money } }));

/**
 * The stand-in for a mover: its "silo" is kept in the memory of the process, a copy is a picture of what the original measures at the moment, and `measureTarget` answers that picture. It is what the development stack and the
 * tests run against until a real mover is bound (D02). It moves no data and so it proves nothing about a real replication; what it lets the platform exercise is everything around it: the state machine, the comparison, the four-eyes
 * approval, the freeze, the switch, the observation, the rollback. Tests alter the picture (`tamper`) to stand for a copy with one row different, or make an operation fail (`failNext`).
 */
export class MockPlacementMover implements PlacementMover {
  private readonly silos = new Map<string, TableMeasure[]>();
  private readonly purged = new Set<string>();
  private altering: ((tables: TableMeasure[]) => void) | undefined;
  private failing: { operation: string; error: Error } | undefined;
  /** The calls made, in order, as `operation:tenant`. */
  readonly calls: string[] = [];

  copy(move: MoveRef, source: MoveSource): Promise<void> {
    return this.begin('copy', move) ?? this.picture(move, source);
  }

  sync(move: MoveRef, source: MoveSource): Promise<void> {
    return this.begin('sync', move) ?? this.picture(move, source);
  }

  measureTarget(move: MoveRef): Promise<TableMeasure[]> {
    const failure = this.begin('measureTarget', move);
    if (failure !== undefined) return failure;
    return Promise.resolve(cloneTables(this.silos.get(keyOf(move)) ?? []));
  }

  discardTarget(move: MoveRef): Promise<void> {
    const failure = this.begin('discardTarget', move);
    if (failure !== undefined) return failure;
    this.silos.delete(keyOf(move));
    return Promise.resolve();
  }

  purgeSource(move: MoveRef): Promise<void> {
    const failure = this.begin('purgeSource', move);
    if (failure !== undefined) return failure;
    this.purged.add(move.tenantId);
    return Promise.resolve();
  }

  /** Whether the copy of the tenant at the target exists. */
  holds(move: Pick<MoveRef, 'tenantId' | 'toPlacementId'>): boolean {
    return this.silos.has(keyOf(move));
  }

  /** Whether the old data of the tenant was deleted. */
  purgedSource(tenantId: string): boolean {
    return this.purged.has(tenantId);
  }

  /** Changes what the copy holds, to stand for rows that differ. */
  tamper(move: Pick<MoveRef, 'tenantId' | 'toPlacementId'>, change: (tables: TableMeasure[]) => void): void {
    const tables = this.silos.get(keyOf(move));
    if (tables !== undefined) change(tables);
  }

  /** The next copy or sync leaves the copy altered like this (once), to stand for a copy that has a row different until the replication catches up. */
  tamperAfterNext(change: (tables: TableMeasure[]) => void): void {
    this.altering = change;
  }

  /** The next call of the operation fails with this error (once). */
  failNext(operation: 'copy' | 'sync' | 'measureTarget' | 'discardTarget' | 'purgeSource', error: Error): void {
    this.failing = { operation, error };
  }

  // Records the call; a call that was set to fail is answered with its failure.
  private begin(operation: string, move: MoveRef): Promise<never> | undefined {
    this.calls.push(`${operation}:${move.tenantId}`);
    if (this.failing?.operation !== operation) return undefined;
    const { error } = this.failing;
    this.failing = undefined;
    return Promise.reject(error);
  }

  private async picture(move: MoveRef, source: MoveSource): Promise<void> {
    const tables = cloneTables((await source.measure()).tables);
    this.altering?.(tables);
    this.altering = undefined;
    this.silos.set(keyOf(move), tables);
  }
}

let shared: MockPlacementMover | undefined;

/** One stand-in for the process: the commands that check a switched migration and the worker see the same silo. */
export function sharedMockPlacementMover(): MockPlacementMover {
  shared ??= new MockPlacementMover();
  return shared;
}

/** The mover of an environment: the stand-in everywhere except production, where there is none until the replication is confirmed (D02), so no migration claims to have copied anything. */
export function defaultPlacementMover(environment: string | undefined): PlacementMover {
  return isProductionEnvironment(environment) ? new UnboundPlacementMover() : sharedMockPlacementMover();
}
