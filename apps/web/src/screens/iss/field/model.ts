import { EMPTY_FORM, ISSUE_CREATE_PERMISSION, TEXT_MAX_LENGTH, TITLE_MAX_LENGTH, toCreateBody, validateForm } from '../issue-model';
import type { CreateBody, FormErrors, IssueForm } from '../issue-model';
import type { Severity } from '../model';
import { toInspectionLine } from '../../qms/inspection/model';
import type { ChecklistRow, InspectionLine, ResultForm } from '../../qms/inspection/model';

export { ISSUE_CREATE_PERMISSION };

/** The permissions of ISS-05 (x-permission of the operations in openapi.json); the server judges each command again, with the scope of the contract. */
export const READ_PERMISSION = 'inspection.read';
export const RECORD_PERMISSION = 'inspection.record';

/** Whether the permission is held, or not yet known: the screen asks for nothing it may not read, and the server judges the scope again. */
export const holds = (permissions: readonly string[] | undefined, permission: string): boolean => permissions === undefined || permissions.includes(permission);

/** An inspection with the project its contract belongs to (an issue is opened under a project). */
export interface SiteCheck {
  line: InspectionLine;
  projectId: string;
}

export function toSiteCheck(raw: unknown): SiteCheck | undefined {
  const line = toInspectionLine(raw);
  const projectId = (raw as { project_id?: unknown } | null)?.project_id;
  return line === undefined || typeof projectId !== 'string' || projectId === '' ? undefined : { line, projectId };
}

export function toSiteChecks(raw: unknown): SiteCheck[] {
  const items = (raw as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? items.flatMap((item) => toSiteCheck(item) ?? []) : [];
}

/** The items of a checklist that failed, as the server keeps them once the result is recorded. */
export const failedItems = (line: InspectionLine): ChecklistRow[] => line.checklist.filter((item) => item.outcome === 'FAIL');

/**
 * The inspections this screen works on: one that is scheduled and that the caller may record, and one whose result is recorded with failed items (the issues of which may still have to be raised, for the
 * recording and the raising are two commands and the second can be left unfinished).
 */
export const isWorkable = (check: SiteCheck): boolean => (check.line.status === 'SCHEDULED' && check.line.canRecord) || (check.line.status === 'RESULT_RECORDED' && failedItems(check.line).length > 0);

/** A failed item that one issue is raised for. */
export interface RaiseItem {
  code: string;
  label: string;
  note: string;
}

/** The items the form marks as failed, with the words the inspector wrote for each. */
export function itemsFromForm(form: ResultForm, items: readonly ChecklistRow[]): RaiseItem[] {
  return items.flatMap((item) => {
    const answer = form.answers[item.code];
    return answer?.outcome === 'FAIL' ? [{ code: item.code, label: item.label, note: answer.note.trim() }] : [];
  });
}

export const itemsFromRecorded = (line: InspectionLine): RaiseItem[] => failedItems(line).map((item) => ({ code: item.code, label: item.label, note: item.note?.trim() ?? '' }));

// ---- the issues to raise ------------------------------------------------------------------------------------------------------

/** What every issue of one inspection shares: the unit and the category that answer for it, the severity and the position (only with the consent of the person who gives it, BR-ISS-06). */
export interface RaiseForm {
  ownerUnitId: string;
  categoryVersionId: string;
  severity: Severity;
  geoConsent: boolean;
  geoLat: string;
  geoLng: string;
  geoAccuracy: string;
}

export const EMPTY_RAISE: RaiseForm = { ownerUnitId: '', categoryVersionId: '', severity: 'MEDIUM', geoConsent: false, geoLat: '', geoLng: '', geoAccuracy: '' };

/** The form of ISS-02 for one failed item: the title names the inspection and the item, the words are the inspector's own or else the item. */
export function issueFormOf(check: SiteCheck, item: RaiseItem, raise: RaiseForm): IssueForm {
  return {
    ...EMPTY_FORM,
    ...raise,
    projectId: check.projectId,
    title: `${check.line.inspectionNo} · ${item.label}`.slice(0, TITLE_MAX_LENGTH),
    description: (item.note === '' ? item.label : item.note).slice(0, TEXT_MAX_LENGTH),
  };
}

/** What is wrong with the shared fields, by the rules of ISS-02 (the unit, the category, the position and its consent). */
export function validateRaise(check: SiteCheck, items: readonly RaiseItem[], raise: RaiseForm): FormErrors {
  const first = items[0];
  return first === undefined ? {} : validateForm(issueFormOf(check, first, raise));
}

/** Withdrawing the consent takes the position with it: nothing the person typed or fetched is kept without it. */
export const withConsent = (raise: RaiseForm, given: boolean): RaiseForm => (given ? { ...raise, geoConsent: true } : { ...raise, geoConsent: false, geoLat: '', geoLng: '', geoAccuracy: '' });

export interface RaiseBody extends CreateBody {
  contract_id: string;
  source_module: 'QMS';
  source_ref_id: string;
}

/**
 * The body of createIssue for one failed item. The source is the quality module and the object is the item of the inspection (derived from both, so that a second item of the same inspection is another
 * source and a repeated send of the same item is the same issue). The position travels only with the consent that keeps it.
 */
export function raiseBody(check: SiteCheck, item: RaiseItem, raise: RaiseForm, ids: ItemIds): RaiseBody {
  return { ...toCreateBody(issueFormOf(check, item, raise), ids.operationId), contract_id: check.line.contract.id, source_module: 'QMS', source_ref_id: ids.sourceRefId };
}

export interface ItemIds {
  sourceRefId: string;
  operationId: string;
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** A UUID made from a name (version 5 layout over SHA-256): the same inspection and item always give the same one. */
async function uuidOf(name: string): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(name))).slice(0, 16);
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const text = hex(digest);
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

/** The source object and the operation of the issue of one item of one inspection. */
export async function idsOf(inspectionId: string, code: string): Promise<ItemIds> {
  return { sourceRefId: await uuidOf(`qms.inspection.item:${inspectionId}:${code}`), operationId: await uuidOf(`iss.field.raise:${inspectionId}:${code}`) };
}

/** Where one item stands once the screen has tried to raise its issue. */
export type ItemState = 'raised' | 'existing' | 'failed';
