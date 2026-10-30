import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { instantText } from '../adm/audit/SealBanner';
import './delivery/delivery.css';
import { useCampaigns, useDecideCampaign } from './campaign/hooks';
import { exclusionLabel, problemMessage, purposeLabel } from './campaign/labels';
import { APPROVE_PERMISSION, EXCLUSIONS, READ_PERMISSION, describeProblem, excludedTotal, reasonProblem, shortHash } from './campaign/model';
import type { Campaign } from './campaign/model';

/**
 * NOT-16: the approval of a broadcast campaign. Whoever approves sees what they approve: the group, the template, the number of people, the people left out for each reason, the hash of the preview and who made the campaign. The
 * approval is for the set that was previewed: when the people changed since, it is refused and the campaign is previewed again. The person who made the campaign cannot approve it, nor send it back or reject it.
 */
export default function CampaignApprovalScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <ApprovalContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ApprovalContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  const canApprove = (permissions === undefined || permissions.includes(APPROVE_PERMISSION)) && mode !== 'READ_ONLY';
  const canRead = permissions === undefined || permissions.includes(APPROVE_PERMISSION) || permissions.includes(READ_PERMISSION);
  const campaigns = useCampaigns('PendingApproval', canRead);
  const queryState = useScreenState({ isLoading: campaigns.isLoading, error: campaigns.error, data: campaigns.data, isEmpty: (data: unknown) => (data as Campaign[]).length === 0 });
  const state = canRead ? queryState : 'denied';
  const [done, setDone] = useState<'approve' | 'return' | 'reject' | undefined>(undefined);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="not-queue">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('not.approval.page.title')}</h1>
          <p>{t('not.approval.page.subtitle')}</p>
        </div>
      </div>
      <div className="card">
        <p className="sub">{t('not.approval.rule.text')}</p>
        {done === undefined ? null : (
          <p className="callout" role="status" data-done={done}>
            {done === 'approve' ? t('not.approval.done.approve') : done === 'return' ? t('not.approval.done.return') : t('not.approval.done.reject')}
          </p>
        )}
        <StateBoundary state={state} onRetry={() => void campaigns.refetch()}>
          <ul data-campaigns>
            {(campaigns.data ?? []).map((campaign) => (
              <ApprovalCard key={campaign.id} campaign={campaign} canApprove={canApprove} mine={campaign.createdBy === tenant?.membershipId} onDone={setDone} />
            ))}
          </ul>
        </StateBoundary>
      </div>
    </section>
  );
}

function ApprovalCard({ campaign, canApprove, mine, onDone }: { campaign: Campaign; canApprove: boolean; mine: boolean; onDone(decision: 'approve' | 'return' | 'reject'): void }) {
  const { t, locale } = useTranslation();
  const decide = useDecideCampaign();
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState(false);
  const problem = decide.isError ? describeProblem(decide.error) : undefined;

  const take = (decision: 'approve' | 'return' | 'reject'): void => {
    if (decide.isPending) return;
    if (reasonProblem(reason)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    decide.reset();
    decide.mutate({ campaign, decision, reason: reason.trim() }, { onSuccess: () => { setReason(''); onDone(decision); } });
  };
  const submit = (event: FormEvent): void => event.preventDefault();

  return (
    <li data-campaign-id={campaign.id} data-mine={mine ? 'true' : 'false'}>
      <h2>{campaign.name}</h2>
      <dl>
        <dt>{t('not.approval.field.scope')}</dt>
        <dd data-scope>
          {t('not.approval.scope.text', { units: campaign.unitIds.length, roles: campaign.roleCodes.join(', ') || '—', guests: campaign.includeGuests ? t('not.approval.guests.yes') : t('not.approval.guests.no') })}
          <ul data-units>
            {campaign.unitIds.map((unitId) => {
              const unit = campaign.units.find((candidate) => candidate.id === unitId);
              return (
                <li key={unitId} data-unit-id={unitId}>
                  {unit === undefined ? unitId : `${unit.name} (${unit.code})`}
                </li>
              );
            })}
          </ul>
        </dd>
        <dt>{t('not.approval.field.template')}</dt>
        <dd data-template>
          {campaign.templateCode} ({campaign.templateChannel}) · {purposeLabel(t, campaign.purpose)}
        </dd>
        <dt>{t('not.approval.field.time')}</dt>
        <dd data-time>{campaign.scheduledAt === undefined ? t('not.schedule.time.asap') : instantText(locale, campaign.scheduledAt)}</dd>
        <dt>{t('not.approval.field.recipients')}</dt>
        <dd data-recipients>{campaign.recipientCount ?? 0}</dd>
        <dt>{t('not.approval.field.excluded')}</dt>
        <dd data-excluded-total>
          {excludedTotal(campaign.excluded)}
          {campaign.excluded === undefined ? null : (
            <ul data-excluded>
              {EXCLUSIONS.map((code) => (
                <li key={code} data-reason={code}>
                  {exclusionLabel(t, code)}: <strong>{campaign.excluded?.[code] ?? 0}</strong>
                </li>
              ))}
            </ul>
          )}
        </dd>
        <dt>{t('not.approval.field.hash')}</dt>
        <dd>
          <code data-hash>{shortHash(campaign.previewHash)}</code>
        </dd>
        <dt>{t('not.approval.field.creator')}</dt>
        <dd data-creator>{campaign.createdBy}</dd>
      </dl>
      {mine ? (
        <p className="callout warning" role="note" data-self>
          {t('not.approval.self.notice')}
        </p>
      ) : null}
      {problem === undefined ? null : (
        <p className="callout warning" role="alert" data-problem>
          {problemMessage(t, problem)}
        </p>
      )}
      {canApprove ? (
        <form onSubmit={submit} noValidate aria-label={t('not.approval.form.aria', { name: campaign.name })} data-decision-form>
          {invalid ? (
            <p className="callout warning" role="alert" data-reason-problem>
              {t('not.approval.reason.invalid')}
            </p>
          ) : null}
          <label htmlFor={`decision-reason-${campaign.id}`}>{t('not.approval.reason.label')}</label>
          <textarea id={`decision-reason-${campaign.id}`} value={reason} onChange={(event) => setReason(event.target.value)} />
          <div className="row gap">
            <button type="button" className="primary" disabled={mine || decide.isPending} onClick={() => take('approve')}>
              {t('not.approval.approve.action')}
            </button>
            <button type="button" disabled={mine || decide.isPending} onClick={() => take('return')}>
              {t('not.approval.return.action')}
            </button>
            <button type="button" disabled={mine || decide.isPending} onClick={() => take('reject')}>
              {t('not.approval.reject.action')}
            </button>
          </div>
        </form>
      ) : null}
    </li>
  );
}
