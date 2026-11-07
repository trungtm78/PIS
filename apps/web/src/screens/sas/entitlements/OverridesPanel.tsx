import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { featureLabel, toneClass } from '../tenants/labels';
import { useDecideOverride, useOverrides, useRequestOverride, useRevokeOverride } from './hooks';
import { decisionConfirm, decisionTitle, doneNotice, overrideFieldMessage, overrideProblemMessage, overrideStatusLabel, overrideStatusTone } from './labels';
import type { OverrideAction } from './labels';
import {
  EMPTY_OVERRIDE_FORM,
  MAX_OVERRIDE_REASON,
  MIN_OVERRIDE_REASON,
  OVERRIDE_FEATURES,
  describeOverrideProblem,
  mayDecide,
  mayRevoke,
  overrideBody,
  validateOverrideForm,
} from './model';
import type { OverrideEntry, OverrideField, OverrideFieldProblem, OverrideForm } from './model';
import { KitTable } from '../../adm/KitTable';
import '../../adm/adm-kit.css';
import { StatusPill } from '../../../ui';
import { toneOfPill } from '../../adm/kit-tone';

interface Pending {
  entry: OverrideEntry;
  action: OverrideAction;
}

interface Props {
  /** The tenant whose overrides are shown; the panel waits until there is one. */
  tenantId: string | undefined;
  /** Whether the person may ask for, decide and end overrides (`system.billing.manage`); otherwise the panel only shows them. */
  canManage: boolean;
  /** The membership of the person: the overrides they asked for cannot be decided by them. */
  membershipId: string | undefined;
}

/**
 * The overrides of the tenant of SAS-25 (ST-SAS-009): the exceptions to its plan, who asked for each and who approved it, the time it holds and its state. An
 * administrator asks for one with a reason and a window; a second administrator approves or rejects it (the one who asked cannot: the screen offers them nothing to
 * decide and the server and the database refuse it too); either may end one early. An approved override is what the table above shows as the source of its feature.
 */
export function OverridesPanel({ tenantId, canManage, membershipId }: Props) {
  const { t, locale } = useTranslation();
  const list = useOverrides(tenantId, true);
  const requesting = useRequestOverride();
  const deciding = useDecideOverride();
  const revoking = useRevokeOverride();
  const [form, setForm] = useState<OverrideForm>(EMPTY_OVERRIDE_FORM);
  const [problems, setProblems] = useState<Partial<Record<OverrideField, OverrideFieldProblem>>>({});
  const [pending, setPending] = useState<Pending | undefined>(undefined);
  const [reason, setReason] = useState('');
  const [reasonShort, setReasonShort] = useState(false);
  const [notice, setNotice] = useState<'requested' | OverrideAction | undefined>(undefined);

  const items = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  const state = useScreenState({
    isLoading: list.isLoading,
    error: list.error,
    data: tenantId === undefined ? undefined : list.data,
    isEmpty: () => false,
  });
  const failure = requesting.isError ? requesting : deciding.isError ? deciding : revoking.isError ? revoking : undefined;
  const problem = failure === undefined ? undefined : describeOverrideProblem(failure.error);
  const dateTime = (value: string): string => new Date(value).toLocaleString(locale, { timeZone: 'UTC' });
  const person = (id: string): string => (membershipId !== undefined && id.toLowerCase() === membershipId.toLowerCase() ? t('sas.overrides.people.you') : id.slice(0, 8));

  const change = <K extends keyof OverrideForm>(field: K, value: OverrideForm[K]): void => {
    setForm((current) => ({ ...current, [field]: value }));
    setProblems({});
    setNotice(undefined);
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (requesting.isPending || tenantId === undefined) return;
    const found = validateOverrideForm(form, new Date());
    setProblems(found);
    if (Object.keys(found).length > 0) return;
    deciding.reset();
    revoking.reset();
    requesting.mutate(
      { tenantId, body: overrideBody(form) },
      {
        onSuccess: () => {
          setForm(EMPTY_OVERRIDE_FORM);
          setNotice('requested');
        },
      },
    );
  };

  const choose = (entry: OverrideEntry, action: OverrideAction): void => {
    setPending({ entry, action });
    setReason('');
    setReasonShort(false);
    setNotice(undefined);
    requesting.reset();
    deciding.reset();
    revoking.reset();
  };

  const confirm = (event: FormEvent): void => {
    event.preventDefault();
    if (pending === undefined || deciding.isPending || revoking.isPending) return;
    if (reason.trim().length < MIN_OVERRIDE_REASON) {
      setReasonShort(true);
      return;
    }
    const done = (action: OverrideAction) => ({
      onSuccess: () => {
        setNotice(action);
        setPending(undefined);
      },
      // A refused decision is not tried again on the same screen of the list: the list is read again and the person looks at what is there now.
      onError: () => setPending(undefined),
    });
    if (pending.action === 'revoke')
      revoking.mutate(
        {
          overrideId: pending.entry.id,
          version: pending.entry.version,
          reason: reason.trim(),
        },
        done('revoke'),
      );
    else
      deciding.mutate(
        {
          overrideId: pending.entry.id,
          version: pending.entry.version,
          decision: pending.action,
          reason: reason.trim(),
        },
        done(pending.action),
      );
  };

  const fieldError = (field: OverrideField) =>
    problems[field] === undefined ? null : (
      <small role="alert" className="field-error">
        {overrideFieldMessage(t, problems[field])}
      </small>
    );

  return (
    <div className="card sas-overrides" data-testid="overrides">
      <h2>{t('sas.overrides.title')}</h2>
      <p className="sub">{t('sas.overrides.subtitle')}</p>

      {canManage ? (
        <form onSubmit={submit} noValidate aria-label={t('sas.overrides.form.aria')} className="sas-override-form">
          <h3>{t('sas.overrides.form.title')}</h3>
          <div className="formgrid">
            <div className="field">
              <label htmlFor="override-feature">{t('sas.overrides.field.feature')}</label>
              <select
                id="override-feature"
                value={form.featureCode}
                aria-invalid={problems.featureCode !== undefined}
                onChange={(event) => change('featureCode', event.target.value)}
              >
                <option value="">{t('sas.overrides.feature.choose')}</option>
                {OVERRIDE_FEATURES.map((code) => (
                  <option key={code} value={code}>
                    {featureLabel(t, code)}
                  </option>
                ))}
              </select>
              {fieldError('featureCode')}
            </div>
            <div className="field">
              <label className="check" htmlFor="override-enabled">
                <input id="override-enabled" type="checkbox" checked={form.enabled} onChange={(event) => change('enabled', event.target.checked)} />
                {t('sas.overrides.field.enabled')}
              </label>
            </div>
            <div className="field">
              <label htmlFor="override-limit">{t('sas.overrides.field.limit')}</label>
              <input
                id="override-limit"
                inputMode="decimal"
                value={form.limitValue}
                aria-invalid={problems.limitValue !== undefined}
                onChange={(event) => change('limitValue', event.target.value)}
              />
              {fieldError('limitValue')}
            </div>
            <div className="field">
              <label htmlFor="override-from">{t('sas.overrides.field.from')}</label>
              <input
                id="override-from"
                type="datetime-local"
                value={form.validFrom}
                aria-invalid={problems.validFrom !== undefined}
                onChange={(event) => change('validFrom', event.target.value)}
              />
              {fieldError('validFrom')}
            </div>
            <div className="field">
              <label htmlFor="override-until">{t('sas.overrides.field.until')}</label>
              <input
                id="override-until"
                type="datetime-local"
                value={form.validUntil}
                aria-invalid={problems.validUntil !== undefined}
                onChange={(event) => change('validUntil', event.target.value)}
              />
              {fieldError('validUntil')}
            </div>
          </div>
          <div className="field">
            <label htmlFor="override-reason">{t('sas.overrides.field.reason')}</label>
            <textarea
              id="override-reason"
              rows={2}
              maxLength={MAX_OVERRIDE_REASON}
              value={form.reason}
              aria-invalid={problems.reason !== undefined}
              onChange={(event) => change('reason', event.target.value)}
            />
            {fieldError('reason')}
          </div>
          <button type="submit" className="ui-button ui-button--primary" disabled={requesting.isPending || tenantId === undefined}>
            {t('sas.overrides.request.action')}
          </button>
        </form>
      ) : (
        <p className="callout warning" role="status">
          {t('sas.overrides.form.denied')}
        </p>
      )}

      {notice === undefined ? null : (
        <p className="callout" role="status">
          {doneNotice(t, notice)}
        </p>
      )}
      {problem === undefined ? null : (
        <div className="callout warning" role="alert">
          <p>{overrideProblemMessage(t, problem)}</p>
        </div>
      )}

      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        {items.length === 0 ? (
          <p className="sub" role="status" data-overrides-empty>
            {t('sas.overrides.empty')}
          </p>
        ) : (
            <KitTable caption={t('w2sas.overrides.table.caption')} aria-label={t('sas.overrides.title')}>
              <thead>
                <tr>
                  <th>{t('sas.overrides.col.feature')}</th>
                  <th>{t('sas.overrides.col.setting')}</th>
                  <th>{t('sas.overrides.col.window')}</th>
                  <th>{t('sas.overrides.col.status')}</th>
                  <th>{t('sas.overrides.col.people')}</th>
                  {canManage ? <th>{t('sas.overrides.col.actions')}</th> : null}
                </tr>
              </thead>
              <tbody>
                {items.map((entry) => (
                  <tr key={entry.id} data-override-id={entry.id} data-status={entry.status} data-version={entry.version}>
                    <td>
                      <b>{featureLabel(t, entry.featureCode)}</b>
                      <div className="sub">{entry.featureCode}</div>
                      <div className="sub">{entry.reason}</div>
                    </td>
                    <td>
                      {!entry.enabled
                        ? t('sas.overrides.setting.off')
                        : entry.limitValue === undefined
                          ? t('sas.overrides.setting.on')
                          : t('sas.overrides.setting.onLimit', {
                              limit: entry.limitValue,
                            })}
                    </td>
                    <td>
                      {t('sas.overrides.window.text', {
                        from: dateTime(entry.validFrom),
                        until: dateTime(entry.validUntil),
                      })}
                    </td>
                    <td>
                      <StatusPill tone={toneOfPill(toneClass(overrideStatusTone(entry.status)))}>{overrideStatusLabel(t, entry.status)}</StatusPill>
                    </td>
                    <td>
                      <div>
                        {t('sas.overrides.people.requested', {
                          person: person(entry.requestedBy),
                        })}
                      </div>
                      {entry.approvedBy === undefined ? null : (
                        <div>
                          {t('sas.overrides.people.approved', {
                            person: person(entry.approvedBy),
                          })}
                        </div>
                      )}
                    </td>
                    {canManage ? (
                      <td>
                        <div className="row gap">
                          {mayDecide(entry, membershipId) ? (
                            <>
                              <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => choose(entry, 'approve')}>
                                {t('sas.overrides.approve.action')}
                              </button>
                              <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => choose(entry, 'reject')}>
                                {t('sas.overrides.reject.action')}
                              </button>
                            </>
                          ) : entry.status === 'PendingApproval' ? (
                            <small className="sub" data-self-request>
                              {t('sas.overrides.self.notice')}
                            </small>
                          ) : null}
                          {mayRevoke(entry) ? (
                            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => choose(entry, 'revoke')}>
                              {t('sas.overrides.revoke.action')}
                            </button>
                          ) : null}
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </KitTable>
        )}
        {list.hasNextPage ? (
          <button type="button" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
            {t('sas.overrides.more.action')}
          </button>
        ) : null}
      </StateBoundary>

      {pending === undefined ? null : (
        <form onSubmit={confirm} noValidate aria-label={t('sas.overrides.decision.aria')} className="sas-override-decision" data-testid="decision">
          <h3>{decisionTitle(t, pending.action, featureLabel(t, pending.entry.featureCode))}</h3>
          <div className="field">
            <label htmlFor="override-decision-reason">{t('sas.overrides.decision.reason')}</label>
            <textarea
              id="override-decision-reason"
              rows={2}
              maxLength={MAX_OVERRIDE_REASON}
              value={reason}
              aria-invalid={reasonShort}
              onChange={(event) => {
                setReason(event.target.value);
                setReasonShort(false);
              }}
            />
            {reasonShort ? (
              <small role="alert" className="field-error">
                {overrideFieldMessage(t, 'reasonLength')}
              </small>
            ) : null}
          </div>
          <div className="row gap">
            <button type="submit" className="ui-button ui-button--primary" disabled={deciding.isPending || revoking.isPending}>
              {decisionConfirm(t, pending.action)}
            </button>
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setPending(undefined)}>
              {t('sas.overrides.decision.cancel.action')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
