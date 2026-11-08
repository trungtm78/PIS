import type { ReactNode } from 'react';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import { ConfirmDialog, InfoFormula, StatusPill } from '../../ui';
import { REASON_MIN, agentTone, incidentTone, outcomeTone, refusalOf, severityTone, statusTone, vietnamDateTime, word } from './model';
import type { Agent, Incident, Kpi, Run, Status, Summary } from './model';

/** The one sentence a refused command is answered with: each refusal the hub can give has its own words, the rest say the command could not be done. */
export function refusalText(t: Translator['t'], error: unknown): string {
  const refusal = refusalOf(error);
  switch (refusal.code) {
    case 'VERSION_CONFLICT':
      return t('hub.error.versionConflict');
    case 'SCOPE_DENIED':
      return t('hub.error.scope');
    case 'SELF_APPROVAL_DENIED':
      return t('hub.error.selfApproval');
    case 'HUB_INCIDENT_STATE_INVALID':
      return t('hub.error.incidentState');
    case 'HUB_MAPPING_STATE_INVALID':
      return t('hub.error.mappingState');
    case 'HUB_MAPPING_VERSION_TAKEN':
      return t('hub.error.mappingTaken');
    case 'HUB_MAPPING_NOT_APPROVED':
      return t('hub.error.mappingNotApproved');
    case 'HUB_REJECT_STATE_INVALID':
      return t('hub.error.rejectState');
    case 'HUB_PIPELINE_NOT_WIRED':
      return t('hub.error.notWired');
    case 'VALIDATION_FAILED':
      return refusal.detail === 'reason' || refusal.detail === 'resolution' ? t('hub.error.reason') : refusal.detail === 'corrections' ? t('hub.error.stillRejected') : t('hub.error.validation');
    default:
      return t('hub.error.generic');
  }
}

export function StatusBadge({ status }: { status: Status }) {
  const { t } = useTranslation();
  return (
    <StatusPill tone={statusTone(status)}>
      <span data-testid={`status-${status}`}>{t(`hub.status.${word(status)}`)}</span>
    </StatusPill>
  );
}

/** What the data rests on: a working assumption waits for the other side and says so, always visible beside the status. */
export function AcceptanceBadge({ acceptance }: { acceptance: Summary['acceptance'] }) {
  const { t } = useTranslation();
  if (acceptance === 'NOT_APPLICABLE') return null;
  return (
    <StatusPill tone={acceptance === 'PENDING_EXTERNAL' ? 'warning' : 'success'}>
      <span data-testid={`acceptance-${acceptance}`}>{t(`hub.acceptance.${word(acceptance)}`)}</span>
    </StatusPill>
  );
}

export const OutcomePill = ({ outcome }: { outcome: Run['outcome'] }) => {
  const { t } = useTranslation();
  return <StatusPill tone={outcomeTone(outcome)}>{t(`hub.outcome.${word(outcome)}`)}</StatusPill>;
};

export const IncidentPill = ({ state }: { state: Incident['state'] }) => {
  const { t } = useTranslation();
  return <StatusPill tone={incidentTone(state)}>{t(`hub.incident.state.${word(state)}`)}</StatusPill>;
};

export const SeverityPill = ({ severity }: { severity: Incident['severity'] }) => {
  const { t } = useTranslation();
  return <StatusPill tone={severityTone(severity)}>{t(`hub.severity.${word(severity)}`)}</StatusPill>;
};

export const AgentPill = ({ health }: { health: Agent['health'] }) => {
  const { t } = useTranslation();
  return <StatusPill tone={agentTone(health)}>{t(`hub.agent.health.${word(health)}`)}</StatusPill>;
};

/** The "i" of a KPI figure: formula, numerator, denominator, exclusions, source and the time it is as of, from the definition of the register; the flag says the numbers are not confirmed. */
export function KpiInfo({ kpi }: { kpi: Kpi }) {
  const { t } = useTranslation();
  return (
    <InfoFormula
      name={kpi.name}
      formula={kpi.formula}
      numerator={kpi.numerator}
      denominator={kpi.denominator}
      exclusions={kpi.exclusions}
      source={kpi.source}
      asOf={vietnamDateTime(kpi.as_of)}
      owner={kpi.owner}
      version={t('hub.info.version', { version: kpi.rule_version })}
      unverified={kpi.unverified}
      labels={{
        open: t('hub.info.open', { name: kpi.name }),
        close: t('hub.info.close'),
        formula: t('hub.info.formula'),
        numerator: t('hub.info.numerator'),
        denominator: t('hub.info.denominator'),
        exclusions: t('hub.info.exclusions'),
        source: t('hub.info.source'),
        asOf: t('hub.info.asOf'),
        owner: t('hub.info.owner'),
        version: t('hub.info.versionLabel'),
        unverified: t('hub.info.unverified'),
      }}
    />
  );
}

export interface ReasonDialogProps {
  title: string;
  context: { label: string; value: string }[];
  confirmLabel: string;
  pending: boolean;
  error: string | undefined;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
  children?: ReactNode;
}

/** A serious action with its reason: the button stays off until the reason has the length the server asks for. */
export function ReasonDialog({ title, context, confirmLabel, pending, error, onCancel, onConfirm, children }: ReasonDialogProps) {
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      open
      title={title}
      context={context}
      confirmLabel={confirmLabel}
      cancelLabel={t('hub.dialog.cancel')}
      pending={pending}
      reason={{ label: t('hub.dialog.reason.label'), required: true, minLength: REASON_MIN, hint: t('hub.dialog.reason.hint', { min: REASON_MIN }) }}
      {...(error === undefined ? {} : { error })}
      onCancel={onCancel}
      onConfirm={(reason) => onConfirm((reason ?? '').trim())}
    >
      {children}
    </ConfirmDialog>
  );
}
