import type { Translator } from '../../i18n';
import type { FieldProblem, GenerationProblem, Phase, ProblemView } from './model';
import type { Progress } from './progress-model';
import type { DocStage, ReportProblem } from './report-model';
import type { AdapterStatus, ExportTarget, FieldSource, Frequency, PackageFormat, FormStatus, ReportKind, PackageStatus, ReportStatus, ReportingRole } from './types';

type T = Translator['t'];

// Every key is written out so the i18n check can see it is in use.
export function reportKindLabel(t: T, kind: ReportKind): string {
  switch (kind) {
    case 'OVERALL_SEMIANNUAL':
      return t('mne.forms.kind.overallSemiannual');
    case 'OVERALL_ANNUAL':
      return t('mne.forms.kind.overallAnnual');
    case 'PROJECT_START':
      return t('mne.forms.kind.projectStart');
    case 'PROJECT_ADJUST':
      return t('mne.forms.kind.projectAdjust');
    case 'PROJECT_COMPLETION':
      return t('mne.forms.kind.projectCompletion');
    case 'PROJECT_PERIODIC':
      return t('mne.forms.kind.projectPeriodic');
    case 'EVALUATION':
      return t('mne.forms.kind.evaluation');
    case 'WEEKLY_QUICK':
      return t('mne.forms.kind.weeklyQuick');
  }
}

export function formStatusLabel(t: T, status: FormStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('mne.forms.state.draft');
    case 'PUBLISHED':
      return t('mne.forms.state.published');
    case 'RETIRED':
      return t('mne.forms.state.retired');
  }
}

export function phaseLabel(t: T, phase: Phase): string {
  switch (phase) {
    case 'draft':
      return t('mne.forms.phase.draft');
    case 'scheduled':
      return t('mne.forms.phase.scheduled');
    case 'inForce':
      return t('mne.forms.phase.inForce');
    case 'ended':
      return t('mne.forms.phase.ended');
  }
}

export function roleLabel(t: T, role: ReportingRole): string {
  switch (role) {
    case 'INVESTOR':
      return t('mne.calendar.role.investor');
    case 'PROJECT_OWNER_AGENCY':
      return t('mne.calendar.role.projectOwnerAgency');
    case 'PROVINCIAL_PEOPLE_COMMITTEE':
      return t('mne.calendar.role.provincialPeopleCommittee');
    case 'PLANNING_AGENCY':
      return t('mne.calendar.role.planningAgency');
  }
}

export function frequencyLabel(t: T, frequency: Frequency): string {
  switch (frequency) {
    case 'WEEKLY':
      return t('mne.rules.frequency.weekly');
    case 'SEMIANNUAL':
      return t('mne.rules.frequency.semiannual');
    case 'ANNUAL':
      return t('mne.rules.frequency.annual');
    case 'EVENT':
      return t('mne.rules.frequency.event');
  }
}

export function reportStatusLabel(t: T, status: ReportStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('mne.calendar.status.draft');
    case 'IN_REVIEW':
      return t('mne.calendar.status.inReview');
    case 'APPROVED':
      return t('mne.calendar.status.approved');
    case 'ISSUING':
      return t('mne.calendar.status.issuing');
    case 'ISSUED':
      return t('mne.calendar.status.issued');
    case 'EXPORTED':
      return t('mne.calendar.status.exported');
    case 'SUBMITTED_EXTERNAL':
      return t('mne.calendar.status.submittedExternal');
    case 'RETURNED':
      return t('mne.calendar.status.returned');
    case 'SUPERSEDED':
      return t('mne.calendar.status.superseded');
  }
}

export function fieldProblemMessage(t: T, problem: FieldProblem): string {
  switch (problem) {
    case 'required':
      return t('mne.forms.field.required');
    case 'tooShort':
      return t('mne.forms.field.tooShort');
    case 'tooLong':
      return t('mne.forms.field.tooLong');
    case 'format':
      return t('mne.forms.field.format');
    case 'date':
      return t('mne.forms.field.date');
    case 'order':
      return t('mne.forms.field.order');
    case 'json':
      return t('mne.forms.field.json');
    case 'formats':
      return t('mne.forms.field.formats');
  }
}

export function problemMessage(t: T, problem: ProblemView): string {
  switch (problem.reason) {
    case 'conflict':
      return t('mne.forms.problem.conflict.text');
    case 'selfApproval':
      return t('mne.forms.problem.selfApproval.text');
    case 'stateInvalid':
      return t('mne.forms.problem.stateInvalid.text');
    case 'rangeOverlap':
      return t('mne.forms.problem.rangeOverlap.text');
    case 'templateMissing':
      return t('mne.forms.problem.templateMissing.text');
    case 'formNotEffective':
      return t('mne.rules.problem.formNotEffective.text');
    case 'invalid':
      return t('mne.forms.problem.invalid.text');
    case 'notFound':
      return t('mne.forms.problem.notFound.text');
    case 'denied':
      return t('mne.forms.problem.denied.text');
    case 'session':
      return t('mne.forms.problem.session.text');
    case 'general':
      return t('mne.forms.problem.general.text');
  }
}

export function generationMessage(t: T, problem: GenerationProblem): string {
  switch (problem) {
    case 'noRule':
      return t('mne.calendar.problem.noRule.text');
    case 'formNotEffective':
      return t('mne.calendar.problem.formNotEffective.text');
    case 'calendar':
      return t('mne.calendar.problem.calendar.text');
    case 'scopeDenied':
      return t('mne.calendar.problem.scopeDenied.text');
    case 'invalid':
      return t('mne.calendar.problem.invalid.text');
    case 'session':
      return t('mne.calendar.problem.session.text');
    case 'general':
      return t('mne.calendar.problem.general.text');
  }
}

export function sourceLabel(t: T, source: FieldSource): string {
  const detail = source.detail ?? '';
  switch (source.kind) {
    case 'SNAPSHOT_METRIC':
      return t('mne.report.source.snapshotMetric', { detail });
    case 'PROJECT_COUNT':
      return t('mne.report.source.projectCount', { detail });
    case 'WARNING_COUNT':
      return t('mne.report.source.warningCount', { detail });
    case 'APPROPRIATION_TOTAL':
      return t('mne.report.source.appropriationTotal', { detail });
    case 'SLOW_PROJECTS':
      return t('mne.report.source.slowProjects', { detail });
  }
}

/** What a failed command on a report says; the cells the server named are listed by their labels. */
export function reportProblemMessage(t: T, problem: ReportProblem, labelOf: (key: string) => string): string {
  const fields = problem.fields.map(labelOf).join(', ');
  switch (problem.reason) {
    case 'conflict':
      return t('mne.report.problem.conflict');
    case 'receiptRequired':
      return t('mne.export.problem.receiptRequired');
    case 'notIssued':
      return t('mne.export.problem.notIssued');
    case 'formatUnsupported':
      return t('mne.export.problem.formatUnsupported');
    case 'packageState':
      return t('mne.export.problem.packageState');
    case 'selfApproval':
      return t('mne.report.problem.selfApproval');
    case 'templateMissing':
      return t('mne.report.problem.templateMissing');
    case 'stateInvalid':
      return t('mne.report.problem.stateInvalid');
    case 'snapshotRequired':
      return t('mne.report.problem.snapshotRequired');
    case 'snapshotNotFrozen':
      return t('mne.report.problem.snapshotNotFrozen');
    case 'locked':
      return t('mne.report.problem.locked', { fields });
    case 'missing':
      return t('mne.report.problem.missing', { fields });
    case 'formNotEffective':
      return t('mne.report.problem.formNotEffective');
    case 'exists':
      return t('mne.report.problem.exists');
    case 'invalid':
      return t('mne.report.problem.invalid');
    case 'notFound':
      return t('mne.report.problem.notFound');
    case 'denied':
      return t('mne.report.problem.denied');
    case 'session':
      return t('mne.report.problem.session');
    case 'general':
      return t('mne.report.problem.general');
  }
}

export function docStageLabel(t: T, stage: DocStage): string {
  switch (stage) {
    case 'none':
      return t('mne.approval.doc.none');
    case 'drafting':
      return t('mne.approval.doc.drafting');
    case 'awaitingSignature':
      return t('mne.approval.doc.awaitingSignature');
    case 'numbered':
      return t('mne.approval.doc.numbered');
    case 'published':
      return t('mne.approval.doc.published');
    case 'withdrawn':
      return t('mne.approval.doc.withdrawn');
  }
}

export function targetLabel(t: T, target: ExportTarget): string {
  switch (target) {
    case 'NATIONAL_PIM_SYSTEM':
      return t('mne.export.target.national');
    case 'RECIPIENT_AGENCY':
      return t('mne.export.target.recipient');
    case 'LGSP':
      return t('mne.export.target.lgsp');
  }
}

export function packageStatusLabel(t: T, status: PackageStatus): string {
  switch (status) {
    case 'GENERATED':
      return t('mne.export.status.generated');
    case 'DOWNLOADED':
      return t('mne.export.status.downloaded');
    case 'SUBMISSION_CONFIRMED':
      return t('mne.export.status.confirmed');
    case 'REJECTED':
      return t('mne.export.status.rejected');
    case 'EXPIRED':
      return t('mne.export.status.expired');
  }
}

/** The badge of how far the way to the target goes: while it is only proposed, the file is filed by hand. */
export function adapterLabel(t: T, status: AdapterStatus): string {
  switch (status) {
    case 'VERIFIED':
      return t('mne.export.adapter.verified');
    case 'PROPOSED':
      return t('mne.export.adapter.proposed');
    case 'MOCK':
      return t('mne.export.adapter.mock');
    case 'MISSING':
      return t('mne.export.adapter.missing');
  }
}

export function formatLabel(t: T, format: PackageFormat): string {
  switch (format) {
    case 'XLSX':
      return t('mne.export.format.xlsx');
    case 'PDF':
      return t('mne.export.format.pdf');
    case 'CSV':
      return t('mne.export.format.csv');
    case 'DOCX':
      return t('mne.export.format.docx');
  }
}

/** What the progress says of an obligation, in words and with the number of days (BR-MNE-04). */
export function progressLabel(t: T, progress: Progress): string {
  switch (progress.kind) {
    case 'ON_TIME':
      return t('mne.progress.status.onTime');
    case 'LATE':
      return progress.days === null ? t('mne.progress.status.lateUnknown') : t('mne.progress.status.late', { days: progress.days });
    case 'OPEN_LATE':
      return t('mne.progress.status.openLate', { days: progress.days ?? 0 });
    case 'OPEN':
      return t('mne.progress.status.open');
  }
}
