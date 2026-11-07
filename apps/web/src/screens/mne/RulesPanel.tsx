import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import { useSession } from '../../session/SessionContext';
import { ConfirmationLabel } from './components';
import { usePublishRule, useRules } from './hooks';
import { formStatusLabel, frequencyLabel, problemMessage, roleLabel } from './labels';
import { actionsFor, describeProblem, formulaText, lastDayOf } from './model';
import { RuleRevisionForm } from './RuleRevisionForm';
import { formStatusTone } from './tones';
import { APPROVE_CALENDAR_PERMISSION, MANAGE_CALENDAR_PERMISSION } from './types';
import type { RuleView } from './types';
import { StatusPill } from '../../ui';

/**
 * The obligation rules of MNE-02: every revision with who files which form, how often, to whom and by which formula, its legal basis and
 * confirmation label, its period and status. A rule is drafted under `mne.calendar.manage` and published by a person other than its maker
 * under `mne.calendar.approve`; the obligations of MNE-01 are generated from the rules in force. The panel reads its own list, so a failure
 * of that read does not take the catalogue of forms with it.
 */
export function RulesPanel() {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  const frozen = mode === 'READ_ONLY';
  const mayDraft = (permissions === undefined || permissions.includes(MANAGE_CALENDAR_PERMISSION)) && !frozen;
  const context = { membershipId: tenant?.membershipId, permissions, frozen, approve: APPROVE_CALENDAR_PERMISSION };
  const rules = useRules();
  const publish = usePublishRule();
  const [publishing, setPublishing] = useState<RuleView | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [done, setDone] = useState<string | undefined>(undefined);
  const refused = publish.isError ? describeProblem(publish.error) : undefined;
  const rows = rules.data ?? [];

  const openPublish = (rule: RuleView): void => {
    publish.reset();
    setDone(undefined);
    setCreating(false);
    setPublishing(rule);
  };

  const openCreate = (): void => {
    publish.reset();
    setDone(undefined);
    setPublishing(undefined);
    setCreating(true);
  };

  const confirmPublish = (event: FormEvent): void => {
    event.preventDefault();
    if (publishing === undefined || publish.isPending) return;
    const { ruleCode, revision } = publishing;
    publish.mutate(
      { ruleId: publishing.id, version: publishing.version },
      {
        onSuccess: () => {
          setPublishing(undefined);
          setDone(t('mne.rules.publish.done.notice', { code: ruleCode, revision }));
        },
      },
    );
  };

  return (
    <section className="card" aria-labelledby="rules-title" data-testid="rules-panel">
      <div className="row between gap">
        <div>
          <h2 id="rules-title">{t('mne.rules.page.title')}</h2>
          <p className="sub">{t('mne.rules.page.subtitle')}</p>
        </div>
        {mayDraft ? (
          <button type="button" onClick={openCreate}>
            {t('mne.rules.create.open.action')}
          </button>
        ) : null}
      </div>
      {done === undefined ? null : (
        <p className="callout" role="status">
          {done}
        </p>
      )}
      {rules.isLoading ? (
        <p className="muted" role="status">
          {t('mne.rules.loading.text')}
        </p>
      ) : rules.isError ? (
        <div className="callout warning" role="alert">
          {t('mne.rules.error.text')}{' '}
          <button type="button" onClick={() => void rules.refetch()}>
            {t('states.retry.action')}
          </button>
        </div>
      ) : rows.length === 0 ? (
        <p className="muted" data-testid="empty-rules">
          {t('mne.rules.empty.text')}
        </p>
      ) : (
        <div className="tablewrap">
          <table aria-label={t('mne.rules.table.aria')}>
            <thead>
              <tr>
                <th>{t('mne.rules.col.code')}</th>
                <th>{t('mne.rules.col.form')}</th>
                <th>{t('mne.rules.col.level')}</th>
                <th>{t('mne.rules.col.frequency')}</th>
                <th>{t('mne.rules.col.due')}</th>
                <th>{t('mne.rules.col.recipient')}</th>
                <th>{t('mne.rules.col.legal')}</th>
                <th>{t('mne.rules.col.period')}</th>
                <th>{t('mne.rules.col.status')}</th>
                <th>
                  <span className="sr-only">{t('mne.forms.col.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((rule) => {
                const actions = actionsFor(rule, context);
                return (
                  <tr key={rule.id} data-rule-id={rule.id} data-rule-code={rule.ruleCode} className={rule.id === publishing?.id ? 'selected' : undefined}>
                    <td>
                      <strong>{rule.ruleCode}</strong> <StatusPill tone="neutral">{t('mne.forms.revision.pill', { revision: rule.revision })}</StatusPill>
                    </td>
                    <td>{rule.formCode}</td>
                    <td>{roleLabel(t, rule.reportingRole)}</td>
                    <td>{frequencyLabel(t, rule.frequency)}</td>
                    <td>
                      <code>{formulaText(rule.dueRule)}</code>
                    </td>
                    <td>{rule.recipient}</td>
                    <td className="mne-legal">
                      <div>{rule.legalBasis}</div>
                      <div className="mne-badges">
                        <ConfirmationLabel awaiting={rule.awaitingConfirmation} cxnRefs={rule.cxnRefs} reference={rule.legalConfirmationRef} />
                      </div>
                    </td>
                    <td>
                      {rule.effectiveUntil === null
                        ? t('mne.forms.period.open', { from: rule.effectiveFrom })
                        : t('mne.forms.period.closed', { from: rule.effectiveFrom, until: lastDayOf(rule.effectiveUntil) ?? '' })}
                    </td>
                    <td>
                      <span data-lifecycle={rule.status}>
                        <StatusPill tone={formStatusTone(rule.status)}>{formStatusLabel(t, rule.status)}</StatusPill>
                      </span>
                    </td>
                    <td className="mne-actions">
                      {actions.publish ? (
                        <button type="button" aria-label={t('mne.rules.publish.label', { code: rule.ruleCode, revision: rule.revision })} onClick={() => openPublish(rule)}>
                          {t('mne.forms.publish.action')}
                        </button>
                      ) : null}
                      {actions.publishNeedsOther ? <span className="sub">{t('mne.forms.publish.other.hint')}</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {publishing === undefined || frozen ? null : (
        <form onSubmit={confirmPublish} noValidate aria-label={t('mne.rules.publish.title', { code: publishing.ruleCode, revision: publishing.revision })}>
          <h3>{t('mne.rules.publish.title', { code: publishing.ruleCode, revision: publishing.revision })}</h3>
          <p className="sub">{t('mne.rules.publish.hint')}</p>
          {refused === undefined ? null : (
            <p className="callout warning" role="alert">
              {problemMessage(t, refused)}
            </p>
          )}
          <div className="row gap">
            <button type="submit" className="ui-button ui-button--primary" disabled={publish.isPending}>
              {t('mne.forms.publish.confirm.action')}
            </button>
            <button type="button" onClick={() => setPublishing(undefined)}>
              {t('mne.forms.publish.cancel.action')}
            </button>
          </div>
        </form>
      )}
      {creating && mayDraft ? (
        <RuleRevisionForm
          onCancel={() => setCreating(false)}
          onDone={(code) => {
            setCreating(false);
            setDone(t('mne.rules.create.done.notice', { code }));
          }}
        />
      ) : null}
    </section>
  );
}
