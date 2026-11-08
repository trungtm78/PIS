import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { SectionCard, StatusPill } from '../../../ui';
import { KitTable } from '../KitTable';
import { ReasonDialog, ScopeDialog } from './dialogs';
import { useLiftPeriodScope, usePeriodScopes } from './hooks';
import { scopeStatusLabel, scopeStatusTone } from './labels';
import { GRANT_PERMISSION, GRANT_READ } from './model';
import type { PeriodScopeView } from './model';
import '../adm-kit.css';
import './authority.css';

/**
 * ADM-27: the limit of a role grant to report periods (IAM-2). A person who holds a role only for some periods (a reporter of the third quarter, an assistant for one year) uses it only on the reports of those periods; a role
 * grant without a limit is as it always was. Setting or lifting a limit is judged as the grant is: the one who does it has to hold the role's permissions over its scope and outrank the holder, and is never the holder; lifting
 * widens authority, so it says why. The periods are written as the report layout writes them (2026-M03, 2026-Q3, 2026-H1, 2026) and a period covers every period inside it.
 */
export default function PeriodScopeScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <ScopeContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ScopeContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const [status, setStatus] = useState<'Active' | 'Lifted'>('Active');
  const [creating, setCreating] = useState(false);
  const [lifting, setLifting] = useState<PeriodScopeView | undefined>(undefined);
  const mayRead = permissions === undefined || permissions.includes(GRANT_READ);
  const mayGrant = (permissions === undefined || permissions.includes(GRANT_PERMISSION)) && mode !== 'READ_ONLY';
  const scopes = usePeriodScopes(status, mayRead);
  const queryState = useScreenState({ isLoading: scopes.isLoading, error: scopes.error, data: scopes.data });
  const state = mayRead ? queryState : 'denied';
  const moment = (iso: string): string => new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(iso));

  return (
    <section className="adm-authority" data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('adm.authority.scopes.title')}</h1>
          <p>{t('adm.authority.scopes.subtitle')}</p>
        </div>
        {mayGrant ? (
          <button type="button" className="ui-button ui-button--primary" data-action="new" onClick={() => setCreating(true)}>
            {t('adm.authority.scopes.new.action')}
          </button>
        ) : null}
      </div>
      <div className="adm-authority-tabs" role="tablist" aria-label={t('adm.authority.scopes.tabs')}>
        {(['Active', 'Lifted'] as const).map((name) => (
          <button key={name} type="button" className="ui-button ui-button--outline" role="tab" aria-selected={status === name} data-tab={name} onClick={() => setStatus(name)}>
            {scopeStatusLabel(t, name)}
          </button>
        ))}
      </div>
      <StateBoundary state={state} onRetry={() => void scopes.refetch()}>
        <SectionCard title={scopeStatusLabel(t, status)}>
          <KitTable caption={t('adm.authority.scopes.table.caption')} testId="scopes">
            <thead>
              <tr>
                <th scope="col">{t('adm.authority.scopes.column.member')}</th>
                <th scope="col">{t('adm.authority.scopes.column.role')}</th>
                <th scope="col">{t('adm.authority.scopes.column.periods')}</th>
                <th scope="col">{t('adm.authority.column.reason')}</th>
                <th scope="col">{t('adm.authority.scopes.column.set')}</th>
                <th scope="col">{t('adm.authority.column.status')}</th>
                <th scope="col">{t('adm.authority.column.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {(scopes.data ?? []).map((row) => (
                <tr key={row.id} data-scope={row.id} data-status={row.status}>
                  <td>{row.memberName === '' ? row.memberId.slice(0, 8) : row.memberName}</td>
                  <td>{row.roleCode}</td>
                  <td>
                    {row.periodCodes.map((code) => (
                      <code key={code} className="authority-chip">
                        {code}
                      </code>
                    ))}
                  </td>
                  <td>{row.status === 'Lifted' && row.liftReason !== null ? row.liftReason : row.reason}</td>
                  <td>{moment(row.setAt)}</td>
                  <td>
                    <span data-testid="status">
                      <StatusPill tone={scopeStatusTone(row.status)}>{scopeStatusLabel(t, row.status)}</StatusPill>
                    </span>
                    {row.liftedAt === null ? null : <span className="adm-kit-sub">{moment(row.liftedAt)}</span>}
                  </td>
                  <td>
                    {row.mayLift && mode !== 'READ_ONLY' ? (
                      <button type="button" className="ui-button ui-button--outline ui-button--small" data-action="lift" onClick={() => setLifting(row)}>
                        {t('adm.authority.scopes.lift.action')}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </KitTable>
        </SectionCard>
        <p className="sub" data-testid="scopes-note">
          {t('adm.authority.scopes.note')}
        </p>
      </StateBoundary>
      {creating ? <ScopeDialog onClose={() => setCreating(false)} /> : null}
      {lifting === undefined ? null : <LiftDialog scope={lifting} onClose={() => setLifting(undefined)} />}
    </section>
  );
}

function LiftDialog({ scope, onClose }: { scope: PeriodScopeView; onClose: () => void }) {
  const { t } = useTranslation();
  const lift = useLiftPeriodScope();
  return (
    <ReasonDialog
      title={t('adm.authority.scopes.lift.title')}
      text={t('adm.authority.scopes.lift.text', { name: scope.memberName === '' ? scope.memberId.slice(0, 8) : scope.memberName, role: scope.roleCode })}
      submitLabel={t('adm.authority.scopes.lift.submit')}
      pending={lift.isPending}
      refusal={lift.isError ? lift.error : undefined}
      onSubmit={(reason) => lift.mutate({ id: scope.id, version: scope.version, reason }, { onSuccess: onClose })}
      onClose={onClose}
    />
  );
}
