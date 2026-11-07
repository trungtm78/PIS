import { useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { useDecideSupport, useGrantsInForce, useRequestSupport, useRevokeSupport, useSupportGrants } from './support/hooks';
import { modeLabel, problemMessage, statusLabel, statusTone } from './support/labels';
import { DECIDE_PERMISSION, DEFAULT_MINUTES, MAX_MINUTES, MAX_REASON, MIN_MINUTES, MODULE_CODES, READ_PERMISSION, REQUEST_PERMISSION, approvalsGiven, approvalsNeeded, canDecide, canRevoke, describeProblem, isMinutesValid, isReasonValid, isTenantIdValid } from './support/model';
import type { AccessMode, GrantView } from './support/model';
import { toneClass } from './tenants/labels';
import { SectionCard, StatusPill } from '../../ui';
import { KitTable } from '../adm/KitTable';
import '../adm/adm-kit.css';
import './tenants/sas.css';
import './billing/billing.css';
import { toneOfPill } from '../adm/kit-tone';

type Action = 'approve' | 'reject' | 'revoke';

interface Acting {
  grant: GrantView;
  action: Action;
  reason: string;
  startsAt: string;
  tooShort: boolean;
}

interface Asking {
  tenantId: string;
  ticket: string;
  modules: string[];
  mode: AccessMode;
  minutes: string;
  reason: string;
  invalid: ReadonlySet<'tenant' | 'ticket' | 'modules' | 'minutes' | 'reason'>;
}

const EMPTY: ReadonlySet<never> = new Set();

/**
 * SAS-19: controlled support access (BR-SAS-16). The Support Operator asks, with the ticket, for a few hours of access to the data of one tenant, in the modules they name, to read or to read and write; the request gives
 * nothing. The people of the tenant who hold the right see the requests of their own tenant, approve or reject them (a write needs two different people), and revoke a grant at any time. While a grant is in force a banner
 * says who is in and until when. There is no button to extend an access: a new request is how it is extended, and it asks the tenant again.
 */
export default function SupportAccessScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The forms and the notices belong to one membership: a switch starts the screen over.
  return <SupportContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function SupportContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, tenant } = useSession();
  const [params] = useSearchParams();
  const canRequest = permissions === undefined || permissions.includes(REQUEST_PERMISSION);
  const canDecideHere = permissions === undefined || permissions.includes(DECIDE_PERMISSION);
  const canRead = permissions === undefined || permissions.includes(READ_PERMISSION) || permissions.includes(DECIDE_PERMISSION);
  const grants = useSupportGrants(canRead);
  const live = useGrantsInForce(canRead);
  const request = useRequestSupport();
  const decide = useDecideSupport();
  const revoke = useRevokeSupport();
  const [asking, setAsking] = useState<Asking>({ tenantId: params.get('tenant') ?? '', ticket: '', modules: [], mode: 'READ_ONLY', minutes: String(DEFAULT_MINUTES), reason: '', invalid: EMPTY });
  const [acting, setActing] = useState<Acting | undefined>(undefined);
  const [sent, setSent] = useState(false);
  const [done, setDone] = useState<Action | undefined>(undefined);

  const state = useScreenState({ isLoading: grants.isLoading, error: grants.error, data: grants.data, isEmpty: () => false });
  const items = (grants.data?.pages ?? []).flatMap((page) => page.items);
  const inForce = live.data?.items ?? [];
  const day = (value: string): string => new Date(value).toLocaleString(locale, { timeZone: 'UTC' });
  const failure = request.isError ? describeProblem(request.error) : decide.isError ? describeProblem(decide.error) : revoke.isError ? describeProblem(revoke.error) : undefined;

  const toggleModule = (code: string): void => setAsking({ ...asking, modules: asking.modules.includes(code) ? asking.modules.filter((module) => module !== code) : [...asking.modules, code], invalid: EMPTY });

  const submitRequest = (event: FormEvent): void => {
    event.preventDefault();
    if (request.isPending || !canRequest) return;
    const minutes = Number(asking.minutes);
    const invalid = new Set<'tenant' | 'ticket' | 'modules' | 'minutes' | 'reason'>();
    if (!isTenantIdValid(asking.tenantId)) invalid.add('tenant');
    if (asking.ticket.trim().length < 3) invalid.add('ticket');
    if (asking.modules.length === 0) invalid.add('modules');
    if (!isMinutesValid(minutes)) invalid.add('minutes');
    if (!isReasonValid(asking.reason)) invalid.add('reason');
    if (invalid.size > 0) {
      setAsking({ ...asking, invalid });
      return;
    }
    setSent(false);
    request.mutate(
      { tenantId: asking.tenantId.trim(), ticketReference: asking.ticket.trim(), modules: asking.modules, accessMode: asking.mode, durationMinutes: minutes, reason: asking.reason.trim() },
      {
        onSuccess: () => {
          setSent(true);
          setAsking({ ...asking, ticket: '', modules: [], mode: 'READ_ONLY', minutes: String(DEFAULT_MINUTES), reason: '', invalid: EMPTY });
        },
      },
    );
  };

  const open = (grant: GrantView, action: Action): void => {
    setDone(undefined);
    decide.reset();
    revoke.reset();
    setActing({ grant, action, reason: '', startsAt: '', tooShort: false });
  };

  const submitAction = (event: FormEvent): void => {
    event.preventDefault();
    if (acting === undefined || decide.isPending || revoke.isPending || !canDecideHere) return;
    if (!isReasonValid(acting.reason)) {
      setActing({ ...acting, tooShort: true });
      return;
    }
    const finish = {
      onSuccess: () => {
        setDone(acting.action);
        setActing(undefined);
      },
    };
    if (acting.action === 'revoke') revoke.mutate({ grantId: acting.grant.id, version: acting.grant.version, reason: acting.reason.trim() }, finish);
    else decide.mutate({ grantId: acting.grant.id, version: acting.grant.version, decision: acting.action, reason: acting.reason.trim(), ...(acting.startsAt === '' ? {} : { startsAt: new Date(acting.startsAt).toISOString() }) }, finish);
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="sas-billing">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('sas.support.page.title')}</h1>
          <p>{t('sas.support.page.subtitle')}</p>
        </div>
      </div>
      {inForce.length === 0 ? null : (
        <div className="callout warning" role="status" data-support-banner>
          <p>
            <strong>{t('sas.support.banner.title')}</strong>
          </p>
          <ul>
            {inForce.map((grant) => (
              <li key={grant.id} data-grant-id={grant.id}>
                {t('sas.support.banner.item', { operator: grant.operatorId, mode: modeLabel(t, grant.accessMode), modules: grant.modules.join(', '), until: day(grant.expiresAt) })}
              </li>
            ))}
          </ul>
        </div>
      )}
      {failure === undefined ? null : (
        <div className="callout warning" role="alert">
          <p>{problemMessage(t, failure)}</p>
        </div>
      )}
      {canRequest ? (
        <SectionCard title={t('sas.support.request.title')}>
          <p className="sub">{t('sas.support.request.rule')}</p>
          {sent ? (
            <p className="callout" role="status">
              {t('sas.support.request.done')}
            </p>
          ) : null}
          <form onSubmit={submitRequest} noValidate aria-label={t('sas.support.request.aria')} className="billing-issue">
            <div className="field">
              <label htmlFor="support-tenant">{t('sas.support.request.tenant.label')}</label>
              <input id="support-tenant" value={asking.tenantId} aria-invalid={asking.invalid.has('tenant')} onChange={(event) => setAsking({ ...asking, tenantId: event.target.value, invalid: EMPTY })} />
              {asking.invalid.has('tenant') ? (
                <small role="alert" className="field-error">
                  {t('sas.support.request.tenant.invalid')}
                </small>
              ) : null}
            </div>
            <div className="field">
              <label htmlFor="support-ticket">{t('sas.support.request.ticket.label')}</label>
              <input id="support-ticket" value={asking.ticket} aria-invalid={asking.invalid.has('ticket')} onChange={(event) => setAsking({ ...asking, ticket: event.target.value, invalid: EMPTY })} />
              {asking.invalid.has('ticket') ? (
                <small role="alert" className="field-error">
                  {t('sas.support.request.ticket.invalid')}
                </small>
              ) : null}
            </div>
            <fieldset className="field">
              <legend>{t('sas.support.request.modules.legend')}</legend>
              <div className="row gap">
                {MODULE_CODES.map((code) => (
                  <label key={code}>
                    <input type="checkbox" checked={asking.modules.includes(code)} onChange={() => toggleModule(code)} /> {code}
                  </label>
                ))}
              </div>
              {asking.invalid.has('modules') ? (
                <small role="alert" className="field-error">
                  {t('sas.support.request.modules.invalid')}
                </small>
              ) : null}
            </fieldset>
            <fieldset className="field">
              <legend>{t('sas.support.request.mode.legend')}</legend>
              <label>
                <input type="radio" name="support-mode" checked={asking.mode === 'READ_ONLY'} onChange={() => setAsking({ ...asking, mode: 'READ_ONLY' })} /> {t('sas.support.mode.readOnly')}
              </label>{' '}
              <label>
                <input type="radio" name="support-mode" checked={asking.mode === 'READ_WRITE'} onChange={() => setAsking({ ...asking, mode: 'READ_WRITE' })} /> {t('sas.support.mode.readWrite')}
              </label>
              {asking.mode === 'READ_WRITE' ? <small className="sub">{t('sas.support.request.mode.writeNote')}</small> : null}
            </fieldset>
            <div className="field">
              <label htmlFor="support-minutes">{t('sas.support.request.minutes.label', { min: MIN_MINUTES, max: MAX_MINUTES })}</label>
              <input id="support-minutes" type="number" inputMode="numeric" value={asking.minutes} aria-invalid={asking.invalid.has('minutes')} onChange={(event) => setAsking({ ...asking, minutes: event.target.value, invalid: EMPTY })} />
              {asking.invalid.has('minutes') ? (
                <small role="alert" className="field-error">
                  {t('sas.support.request.minutes.invalid', { min: MIN_MINUTES, max: MAX_MINUTES })}
                </small>
              ) : null}
            </div>
            <div className="field">
              <label htmlFor="support-reason">{t('sas.support.request.reason.label')}</label>
              <textarea id="support-reason" rows={2} maxLength={MAX_REASON} value={asking.reason} aria-invalid={asking.invalid.has('reason')} onChange={(event) => setAsking({ ...asking, reason: event.target.value, invalid: EMPTY })} />
              {asking.invalid.has('reason') ? (
                <small role="alert" className="field-error">
                  {t('sas.support.request.reason.tooShort')}
                </small>
              ) : null}
            </div>
            <div className="row gap">
              <button type="submit" className="ui-button ui-button--primary" disabled={request.isPending}>
                {t('sas.support.request.submit.action')}
              </button>
            </div>
          </form>
        </SectionCard>
      ) : null}
      {canRead ? (
        <StateBoundary state={state} onRetry={() => void grants.refetch()}>
          <SectionCard title={t('sas.support.grants.title')}>
            {done === undefined ? null : (
              <p className="callout" role="status">
                {done === 'revoke' ? t('sas.support.done.revoked') : done === 'reject' ? t('sas.support.done.rejected') : t('sas.support.done.approved')}
              </p>
            )}
            {items.length === 0 ? (
              <p className="sub" role="status">
                {t('sas.support.grants.none')}
              </p>
            ) : (
              <KitTable caption={t('w2sas.support.table.caption')} data-grants>
                <thead>
                  <tr>
                    <th scope="col">{t('sas.support.column.ticket')}</th>
                    <th scope="col">{t('sas.support.column.operator')}</th>
                    <th scope="col">{t('sas.support.column.scope')}</th>
                    <th scope="col">{t('sas.support.column.window')}</th>
                    <th scope="col">{t('sas.support.column.status')}</th>
                    <th scope="col">{t('sas.support.column.approvals')}</th>
                    <th scope="col">
                      <span className="visually-hidden">{t('sas.support.column.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((grant) => (
                    <tr key={grant.id} data-grant-id={grant.id} data-status={grant.status} data-mode={grant.accessMode}>
                      <td>
                        <code>{grant.ticketReference}</code>
                        <br />
                        <small className="sub">{t('sas.support.detail.reason', { reason: grant.requestReason })}</small>
                      </td>
                      <td>
                        <code>{grant.operatorId}</code>
                      </td>
                      <td>
                        {modeLabel(t, grant.accessMode)}
                        <br />
                        <small className="sub">{grant.modules.join(', ')}</small>
                      </td>
                      <td>{grant.startsAt === undefined ? t('sas.support.window.minutes', { minutes: grant.durationMinutes }) : t('sas.support.window.range', { from: day(grant.startsAt), until: day(grant.expiresAt) })}</td>
                      <td>
                        <StatusPill tone={toneOfPill(toneClass(statusTone(grant.status)))}>{statusLabel(t, grant.status)}</StatusPill>
                      </td>
                      <td data-approvals>{t('sas.support.approvals.count', { given: approvalsGiven(grant), needed: approvalsNeeded(grant) })}</td>
                      <td>
                        {canDecideHere && canDecide(grant, tenant?.membershipId) ? (
                          <>
                            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => open(grant, 'approve')}>
                              {t('sas.support.approve.action')}
                            </button>{' '}
                            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => open(grant, 'reject')}>
                              {t('sas.support.reject.action')}
                            </button>{' '}
                          </>
                        ) : null}
                        {canDecideHere && canRevoke(grant) ? (
                          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => open(grant, 'revoke')}>
                            {t('sas.support.revoke.action')}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </KitTable>
            )}
            {grants.hasNextPage ? (
              <div className="row gap">
                <button type="button" disabled={grants.isFetchingNextPage} onClick={() => void grants.fetchNextPage()}>
                  {t('sas.support.grants.more.action')}
                </button>
              </div>
            ) : null}
            {acting === undefined ? null : (
              <form onSubmit={submitAction} noValidate aria-label={t('sas.support.act.aria')} className="billing-issue">
                <p className="callout">{acting.action === 'revoke' ? t('sas.support.act.revoke.rule') : acting.action === 'reject' ? t('sas.support.act.reject.rule') : acting.grant.accessMode === 'READ_WRITE' ? t('sas.support.act.approve.writeRule') : t('sas.support.act.approve.rule')}</p>
                {acting.action === 'approve' && (acting.grant.accessMode === 'READ_ONLY' || approvalsGiven(acting.grant) === 1) ? (
                  <div className="field">
                    <label htmlFor="support-starts">{t('sas.support.act.starts.label')}</label>
                    <input id="support-starts" type="datetime-local" value={acting.startsAt} onChange={(event) => setActing({ ...acting, startsAt: event.target.value })} />
                    <small className="sub">{t('sas.support.act.starts.hint')}</small>
                  </div>
                ) : null}
                <div className="field">
                  <label htmlFor="support-act-reason">{t('sas.support.act.reason.label')}</label>
                  <textarea id="support-act-reason" rows={2} maxLength={MAX_REASON} value={acting.reason} aria-invalid={acting.tooShort} onChange={(event) => setActing({ ...acting, reason: event.target.value, tooShort: false })} />
                  {acting.tooShort ? (
                    <small role="alert" className="field-error">
                      {t('sas.support.act.reason.tooShort')}
                    </small>
                  ) : null}
                </div>
                <div className="row gap">
                  <button type="submit" className="ui-button ui-button--primary" disabled={decide.isPending || revoke.isPending}>
                    {t('sas.support.act.confirm.action')}
                  </button>
                  <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setActing(undefined)}>
                    {t('sas.support.act.abort.action')}
                  </button>
                </div>
              </form>
            )}
          </SectionCard>
        </StateBoundary>
      ) : null}
    </section>
  );
}
