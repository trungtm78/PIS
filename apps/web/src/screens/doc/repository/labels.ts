import type { Translator } from '../../../i18n';
import { camel, describeProblem } from './model';
import type { CompareEntry, DocumentSummary, ReviewRound, ReviewStage, Reviewer, TextUnit, VersionView } from './model';

type T = Translator['t'];

/** The words of the enumerations of the repository. Each family is looked up by a template key (`doc.repo.class.${...}`), so the i18n check counts every key of the family as in use. */
export const classLabel = (t: T, value: string): string => t(`doc.repo.class.${camel(value)}`);
export const securityLabel = (t: T, value: DocumentSummary['security_class']): string => t(`doc.repo.security.${camel(value)}`);
export const effectiveLabel = (t: T, value: DocumentSummary['effective_state']): string => t(`doc.repo.effective.${camel(value)}`);
export const versionStatusLabel = (t: T, value: VersionView['status']): string => t(`doc.repo.versionStatus.${camel(value)}`);
export const reviewStatusLabel = (t: T, value: ReviewRound['status'] | 'NONE'): string => t(`doc.repo.reviewStatus.${camel(value)}`);
export const extractionLabel = (t: T, value: VersionView['extraction_status']): string => t(`doc.repo.extraction.${camel(value)}`);
export const formatLabel = (t: T, value: VersionView['format']): string => t(`doc.repo.format.${camel(value)}`);
export const stageLabel = (t: T, value: ReviewStage['state']): string => t(`doc.repo.stage.${camel(value)}`);
export const reviewerLabel = (t: T, value: Reviewer['state']): string => t(`doc.repo.reviewer.${camel(value)}`);
export const eventLabel = (t: T, value: string): string => t(`doc.repo.event.${camel(value)}`);
export const opLabel = (t: T, value: CompareEntry['op']): string => t(`doc.repo.compareOp.${camel(value)}`);
export const unitKindLabel = (t: T, value: TextUnit['kind']): string => t(`doc.repo.unitKind.${camel(value)}`);

/** The sentence of a refused command: the word `describeProblem` chose, said in the locale. */
export const problemText = (t: T, error: unknown): string => t(`doc.repo.problem.${describeProblem(error)}`);

/** A place of a unit as a person reads it: a page and a paragraph, a table cell, or a sheet and a cell. */
export function placeLabel(t: T, unit: TextUnit): string {
  if (unit.sheet !== null && unit.cell !== null) return t('doc.repo.place.cell', { sheet: unit.sheet, cell: unit.cell });
  if (unit.page !== null && unit.paragraph !== null) return t('doc.repo.place.page', { page: unit.page, paragraph: unit.paragraph });
  if (unit.paragraph !== null) return t('doc.repo.place.paragraph', { paragraph: unit.paragraph });
  return unit.label;
}
