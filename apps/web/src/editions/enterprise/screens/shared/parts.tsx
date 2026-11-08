import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from '../../../../i18n';
import type { Translator } from '../../../../i18n';
import { ConfirmDialog, DataTable, InfoFormula, SectionCard, StatusPill } from '../../../../ui';
import type { DataTableColumn, InfoFormulaLabels } from '../../../../ui';
import { MIN_REASON, dayText, failureCode, reasonProblem, vietnamStamp } from './format';

type T = Translator['t'];

/** The widgets the two connections of the enterprise edition share: the "waiting for" list, the history of the switch, the "i" of a rule, the switch dialog, the words of a refusal. */

export interface PendingItem {
  code: string;
  what: string;
  owner: string;
  consequence: string;
}

export interface HistoryEntry {
  id: string;
  action: string;
  reason: string | null;
  actor_name: string | null;
  version: number;
  occurred_at: string;
}

export interface RuleReading {
  source: 'RULE' | 'DEFAULT';
  version: number;
  unverified: boolean;
  legal_status: string | null;
  formula: string | null;
  source_text: string | null;
  as_of: string | null;
}

/** One labelled fact of a card. */
export function Fact({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <div className="ent2-fact" data-testid={testId}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** The word that every result built on a working assumption carries (R18): it cannot be accepted until the recipient confirms it. */
export function AcceptanceBadge({ acceptance }: { acceptance: string }) {
  const { t } = useTranslation();
  return acceptance === 'PENDING_EXTERNAL' ? (
    <StatusPill tone="warning" icon="⏳">
      {t('ent.acceptance.pending.badge')}
    </StatusPill>
  ) : (
    <StatusPill tone="success" icon="✓">
      {t('ent.acceptance.accepted.badge')}
    </StatusPill>
  );
}

function infoLabels(t: T, name: string): InfoFormulaLabels {
  return {
    open: t('ent.info.open.label', { name }),
    close: t('ent.info.close.label'),
    formula: t('ent.info.formula.label'),
    numerator: t('ent.info.numerator.label'),
    denominator: t('ent.info.denominator.label'),
    exclusions: t('ent.info.exclusions.label'),
    source: t('ent.info.source.label'),
    asOf: t('ent.info.asOf.label'),
    owner: t('ent.info.owner.label'),
    version: t('ent.info.version.label'),
    unverified: t('ent.info.unverified.text'),
  };
}

/** The "i" of a computed number: formula, source, the day it is as of, the owner and the version of the rule the server applied (a starting value nobody confirmed says so). */
export function RuleFigure({ name, rule, asOf, fallbackFormula, fallbackSource }: { name: string; rule: RuleReading; asOf: string; fallbackFormula: string; fallbackSource: string }) {
  const { t } = useTranslation();
  const unverified = rule.unverified || rule.legal_status === 'UNVERIFIED';
  const legal = unverified ? t('ent.info.legal.unverified') : (rule.legal_status ?? t('ent.info.legal.none'));
  return (
    <InfoFormula
      name={name}
      formula={rule.formula ?? fallbackFormula}
      source={rule.source_text ?? fallbackSource}
      asOf={rule.as_of === null ? asOf : dayText(rule.as_of)}
      owner={t('ent.info.owner.text')}
      version={t('ent.info.version.text', { version: rule.version, source: rule.source === 'RULE' ? t('ent.info.rule.tenant') : t('ent.info.rule.default'), legal })}
      unverified={unverified}
      labels={infoLabels(t, name)}
    />
  );
}

/** What each connection waits for from outside (R18): what, who gives it and what it blocks until then. */
export function PendingSection({ items }: { items: readonly PendingItem[] }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('ent.pending.section.title')} status={<StatusPill tone="warning">{t('ent.acceptance.pending.badge')}</StatusPill>}>
      {items.length === 0 ? (
        <p className="ent2-none">{t('ent.pending.empty.text')}</p>
      ) : (
        <ul className="ent2-pending" data-testid="pending-list">
          {items.map((item) => (
            <li key={item.code} data-testid={`pending-${item.code}`}>
              <strong>{item.what}</strong>
              <span>
                {t('ent.pending.owner.label')}: {item.owner}
              </span>
              <span>
                {t('ent.pending.consequence.label')}: {item.consequence}
              </span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function historyAction(t: T, action: string): string {
  switch (action) {
    case 'CREATED':
      return t('ent.history.action.created');
    case 'ENABLED':
      return t('ent.history.action.enabled');
    case 'DISABLED':
      return t('ent.history.action.disabled');
    default:
      return action;
  }
}

/** Who switched the connection and why: the history is append-only on the server. */
export function HistorySection({ history }: { history: readonly HistoryEntry[] }) {
  const { t } = useTranslation();
  const columns: DataTableColumn<HistoryEntry>[] = [
    { key: 'action', header: t('ent.history.column.action'), render: (row) => historyAction(t, row.action) },
    { key: 'actor', header: t('ent.history.column.actor'), render: (row) => row.actor_name ?? '–' },
    { key: 'time', header: t('ent.history.column.time'), render: (row) => vietnamStamp(row.occurred_at) },
    { key: 'reason', header: t('ent.history.column.reason'), render: (row) => row.reason ?? '–' },
  ];
  return (
    <SectionCard title={t('ent.history.section.title')}>
      {history.length === 0 ? <p className="ent2-none">{t('ent.history.empty.text')}</p> : <DataTable caption={t('ent.history.section.title')} columns={columns} rows={[...history]} rowKey={(row) => row.id} />}
    </SectionCard>
  );
}

/** The refusal of a command in the words of the person: the codes every command can meet. A code the caller handled first never gets here. */
export function commonErrorText(t: T, error: unknown): string {
  switch (failureCode(error)) {
    case 'VERSION_CONFLICT':
      return t('ent.error.versionConflict.text');
    case 'SCOPE_DENIED':
      return t('ent.error.scopeDenied.text');
    case 'SELF_APPROVAL_DENIED':
      return t('ent.error.selfApproval.text');
    case 'VALIDATION_FAILED':
      return t('ent.error.validation.text');
    case 'RESOURCE_NOT_FOUND':
      return t('ent.error.notFound.text');
    case 'HASH_MISMATCH':
      return t('ent.error.hashMismatch.text');
    default:
      return t('ent.error.generic.text');
  }
}

export interface SwitchMutation {
  mutateAsync(input: { enabled: boolean; reason: string; version: number }): Promise<unknown>;
  isPending: boolean;
}

/** Switches the connection on or off with a reason: the dialog keeps the button off until the reason is long enough and says a conflict of versions inside itself. */
export function SwitchDialog({
  connectorCode,
  enabled,
  version,
  mutation,
  onClose,
  onDone,
  onReload,
}: {
  connectorCode: string;
  enabled: boolean;
  version: number;
  mutation: SwitchMutation;
  onClose: () => void;
  onDone: (enabled: boolean) => void;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | undefined>(undefined);
  const target = !enabled;
  return (
    <ConfirmDialog
      open
      title={target ? t('ent.switch.enable.title') : t('ent.switch.disable.title')}
      context={[
        { label: t('ent.switch.context.connector.label'), value: connectorCode },
        { label: t('ent.switch.context.effect.label'), value: target ? t('ent.switch.enable.effect') : t('ent.switch.disable.effect') },
      ]}
      confirmLabel={target ? t('ent.switch.enable.confirm') : t('ent.switch.disable.confirm')}
      cancelLabel={t('ent.switch.cancel.action')}
      reason={{ label: t('ent.switch.reason.label'), required: true, minLength: MIN_REASON, hint: t('ent.switch.reason.hint', { min: MIN_REASON }) }}
      pending={mutation.isPending}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={(reason) => {
        const text = reason ?? '';
        if (reasonProblem(text) !== null) {
          setError(t('ent.error.validation.text'));
          return;
        }
        setError(undefined);
        mutation.mutateAsync({ enabled: target, reason: text, version }).then(
          () => onDone(target),
          (failure: unknown) => {
            setError(commonErrorText(t, failure));
            if (failureCode(failure) === 'VERSION_CONFLICT') onReload();
          },
        );
      }}
    />
  );
}

/** The note that tells why an action is not offered. */
export function ReadonlyNote({ block }: { block: 'MODE' | 'RIGHT' }) {
  const { t } = useTranslation();
  return (
    <p className="callout" data-testid="readonly-note">
      {block === 'MODE' ? t('ent.readonly.mode.text') : t('ent.readonly.right.text')}
    </p>
  );
}

/** A labelled control of a dialog with the word of its problem under it (a field that is wrong is said, never only coloured). */
export function Field({ id, label, problem, hint, children }: { id: string; label: string; problem?: 'REQUIRED' | 'FORMAT' | undefined; hint?: string | undefined; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="ent2-field" data-invalid={problem === undefined ? undefined : 'true'}>
      <label htmlFor={id}>{label}</label>
      {children}
      {hint !== undefined && (
        <span className="ent2-field__hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
      {problem !== undefined && (
        <span className="ent2-field__problem" role="alert" id={`${id}-problem`}>
          {problem === 'REQUIRED' ? t('ent.field.required.text') : t('ent.field.format.text')}
        </span>
      )}
    </div>
  );
}

/** The level of an alert in words. */
export function severityLabel(t: T, severity: 'URGENT' | 'ACTION' | 'WATCH'): string {
  switch (severity) {
    case 'URGENT':
      return t('ent.severity.urgent.name');
    case 'ACTION':
      return t('ent.severity.action.name');
    case 'WATCH':
      return t('ent.severity.watch.name');
  }
}
