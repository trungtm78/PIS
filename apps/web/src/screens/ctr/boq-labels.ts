import type { useTranslation } from '../../i18n';
import type { FileProblem, ImportMode, ImportProblem, RoundingRule } from './boq-model';

type Translate = ReturnType<typeof useTranslation>['t'];

/** The rule by which the amount of a line is rounded to whole VND (BR-CTR-02). */
export function roundingLabel(t: Translate, rule: RoundingRule): string {
  switch (rule) {
    case 'HALF_UP':
      return t('ctr.boq.rounding.halfUp.label');
    case 'DOWN':
      return t('ctr.boq.rounding.down.label');
    case 'UP':
      return t('ctr.boq.rounding.up.label');
  }
}

/** How an import treats the lines the revision already has. */
export function modeLabel(t: Translate, mode: ImportMode): string {
  switch (mode) {
    case 'REPLACE':
      return t('ctr.boq.mode.replace.label');
    case 'APPEND':
      return t('ctr.boq.mode.append.label');
  }
}

/** The name of a field of a line, as the person sees it in the grid; one the screen has no word for is shown as the server named it. */
export function fieldLabel(t: Translate, field: string): string {
  switch (field) {
    case 'business_key':
      return t('ctr.boq.field.businessKey.label');
    case 'description':
      return t('ctr.boq.field.description.label');
    case 'unit_code':
      return t('ctr.boq.field.unitCode.label');
    case 'quantity':
      return t('ctr.boq.field.quantity.label');
    case 'unit_price':
      return t('ctr.boq.field.unitPrice.label');
    case 'rounding_rule':
      return t('ctr.boq.field.roundingRule.label');
    case 'retention_pct':
      return t('ctr.boq.field.retentionPct.label');
    case 'milestone_code':
      return t('ctr.boq.field.milestoneCode.label');
    case 'milestone_due_on':
      return t('ctr.boq.field.milestoneDueOn.label');
    case 'party_contractor_id':
      return t('ctr.boq.field.party.label');
    case 'row':
      return t('ctr.boq.field.row.label');
    default:
      return field;
  }
}

/** Why a row was refused, in a sentence; a reason the screen has no sentence for is the general one. */
export function faultLabel(t: Translate, reason: string): string {
  switch (reason) {
    case 'notAnObject':
      return t('ctr.boq.fault.notAnObject.error');
    case 'notAllowed':
      return t('ctr.boq.fault.notAllowed.error');
    case 'required':
      return t('ctr.boq.fault.required.error');
    case 'tooLong':
      return t('ctr.boq.fault.tooLong.error');
    case 'invalidText':
      return t('ctr.boq.fault.invalidText.error');
    case 'invalidNumber':
      return t('ctr.boq.fault.invalidNumber.error');
    case 'tooPrecise':
      return t('ctr.boq.fault.tooPrecise.error');
    case 'tooLarge':
      return t('ctr.boq.fault.tooLarge.error');
    case 'invalidRounding':
      return t('ctr.boq.fault.invalidRounding.error');
    case 'invalidPercent':
      return t('ctr.boq.fault.invalidPercent.error');
    case 'invalidDate':
      return t('ctr.boq.fault.invalidDate.error');
    case 'invalidId':
      return t('ctr.boq.fault.invalidId.error');
    case 'duplicateKey':
      return t('ctr.boq.fault.duplicateKey.error');
    case 'amountTooLarge':
      return t('ctr.boq.fault.amountTooLarge.error');
    case 'unitUnknown':
      return t('ctr.boq.fault.unitUnknown.error');
    case 'unitChanged':
      return t('ctr.boq.fault.unitChanged.error');
    case 'partyUnknown':
      return t('ctr.boq.fault.partyUnknown.error');
    default:
      return t('ctr.boq.fault.general.error');
  }
}

/** Why a file cannot be imported from this screen. */
export function fileProblemMessage(t: Translate, problem: FileProblem, column?: string): string {
  switch (problem) {
    case 'empty':
      return t('ctr.boq.file.empty.error');
    case 'unreadable':
      return t('ctr.boq.file.unreadable.error');
    case 'tooLarge':
      return t('ctr.boq.file.tooLarge.error');
    case 'tooMany':
      return t('ctr.boq.file.tooMany.error');
    case 'notCsv':
      return t('ctr.boq.file.notCsv.error');
    case 'unknownColumn':
      return t('ctr.boq.file.unknownColumn.error', { column: column ?? '' });
    case 'missingColumn':
      return t('ctr.boq.file.missingColumn.error', { column: column ?? '' });
  }
}

/** The sentence for a refusal of the import. `format` groups an amount in VND; the rows themselves are listed apart. */
export function importProblemMessage(t: Translate, problem: ImportProblem, format: (amount: string) => string = (amount) => amount): string {
  switch (problem.reason) {
    case 'rows':
      return t('ctr.boq.problem.rows.error', { count: problem.faultRows });
    case 'totalMismatch':
      return problem.figures === undefined
        ? t('ctr.boq.problem.totalMismatchUnknown.error')
        : t('ctr.boq.problem.totalMismatch.error', { lines: format(problem.figures.linesTotal), value: format(problem.figures.revisionAmount) });
    case 'duplicate':
      return t('ctr.boq.problem.duplicate.error', { rows: problem.duplicateRows.join(', ') });
    case 'notDraft':
      return t('ctr.boq.problem.notDraft.error');
    case 'stateInvalid':
      return t('ctr.boq.problem.stateInvalid.error');
    case 'versionConflict':
      return t('ctr.boq.problem.versionConflict.error');
    case 'fileNotClean':
      return t('ctr.boq.problem.fileNotClean.error');
    case 'fileType':
      return t('ctr.boq.problem.fileType.error');
    case 'tooLarge':
      return t('ctr.boq.problem.tooLarge.error');
    case 'validation':
      return problem.field === undefined ? t('ctr.boq.problem.validation.error') : t('ctr.boq.problem.validationField.error', { field: problem.field });
    case 'notFound':
      return t('ctr.boq.problem.notFound.error');
    case 'denied':
      return t('ctr.boq.problem.denied.error');
    case 'general':
      return t('ctr.boq.problem.general.error');
  }
}
