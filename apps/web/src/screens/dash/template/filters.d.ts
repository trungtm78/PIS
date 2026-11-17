import type { DashboardDb } from '../db';

export type FilterKind = 'inv' | 'gov';
export type FilterKey = 'year' | 'period' | 'source' | 'sector' | 'unit' | 'origin' | 'theme' | 'actor' | 'due';
/** What each filter is set to; null is "not set" (every row, the year of the tables, the closing month). */
export interface FilterState { year: null; period: number | null; source: string | null; sector: string | null; unit: string | null; origin: string | null; theme: string | null; actor: string | null; due: string | null }
export interface FilterOption { value: string | number; label: string; count: number | null }

export const FILTERS: Readonly<Record<FilterKind, readonly FilterKey[]>>;
export const CHIP_FILTER: Readonly<Record<FilterKind, Readonly<Record<string, FilterKey>>>>;
export function kindOf(key: FilterKey): FilterKind;
export function emptyFilters(): FilterState;
export function isSet(state: FilterState, kind: FilterKind): boolean;
export function periodOf(db: DashboardDb, state: FilterState): number;
export function applyFilters(db: DashboardDb, state: FilterState): DashboardDb;
export function optionsOf(db: DashboardDb, state: FilterState, key: FilterKey): FilterOption[];
export function allLabel(key: FilterKey): string | null;
export function chipText(db: DashboardDb, state: FilterState, key: FilterKey): string;
export function engineFor<T extends { invest(db: DashboardDb, period?: number): Record<string, unknown> }>(engine: T, db: DashboardDb, state: FilterState): T;
export function withFilter(db: DashboardDb, state: FilterState, key: FilterKey, value: string | number | null): FilterState;
export function cleared(state: FilterState, kind: FilterKind): FilterState;
export function scoped(state: FilterState, kind: FilterKind): FilterState;
export function computable(engine: unknown, db: DashboardDb, state: FilterState, kind: FilterKind): boolean;
export function chosen(db: DashboardDb, state: FilterState, key: FilterKey): string | number | null;
