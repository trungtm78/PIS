import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { routeById } from '../../routes/registry';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { instantText } from '../adm/audit/SealBanner';
import { useOrgUnits } from '../adm/org-tree/hooks';
import './delivery/delivery.css';
import { useCampaigns, useCreateCampaign, usePreviewCampaign } from './campaign/hooks';
import { exclusionLabel, formProblemMessage, problemMessage, purposeLabel, statusLabel } from './campaign/labels';
import { EXCLUSIONS, MANAGE_PERMISSION, PURPOSES, READ_PERMISSION, campaignBody, campaignProblems, describeProblem, emptyForm, excludedTotal, reasonProblem, shortHash } from './campaign/model';
import type { Campaign, CampaignForm, CampaignProblem, Preview } from './campaign/model';
import { useTemplates } from './template/hooks';

/**
 * NOT-09: the recipient group of a broadcast campaign. A campaign is made as a draft with its group (units within the scope of whoever makes it, roles, and the guest contractors when the group says so); the preview then says how
 * many people would get it and, for the people left out, how many for each reason (they turned the channel off, have no consent, are not active, or are reached twice) with a hash of the set. The group runs in the tenant and the scope of
 * the person who makes it. A campaign cannot be sent to approval (NOT-10) before it is previewed.
 */
export default function SegmentScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The form belongs to one membership: switching tenant starts the screen over, so nothing typed for one is sent to the other.
  return <SegmentContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function SegmentContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const canManage = (permissions === undefined || permissions.includes(MANAGE_PERMISSION)) && mode !== 'READ_ONLY';
  const canRead = permissions === undefined || permissions.includes(READ_PERMISSION) || permissions.includes(MANAGE_PERMISSION);
  const campaigns = useCampaigns(undefined, canRead);
  const queryState = useScreenState({ isLoading: campaigns.isLoading, error: campaigns.error, data: campaigns.data, isEmpty: () => false });
  const state = canRead || canManage ? queryState : 'denied';
  const [created, setCreated] = useState(false);
  const open = (campaigns.data ?? []).filter((campaign) => campaign.status === 'Draft' || campaign.status === 'Previewed');
  const schedulePath = routeById('NOT-10')?.path ?? '/not/not-10';
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="not-queue">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('not.segment.page.title')}</h1>
          <p>{t('not.segment.page.subtitle')}</p>
        </div>
        <Link to={schedulePath}>{t('not.segment.schedule.link')}</Link>
      </div>
      <div className="card">
        <p className="sub">{t('not.segment.rule.text')}</p>
        {created ? (
          <p className="callout" role="status" data-created>
            {t('not.segment.done.created')}
          </p>
        ) : null}
        {canManage ? <CreateForm onCreated={() => setCreated(true)} /> : null}
        <StateBoundary state={state} onRetry={() => void campaigns.refetch()}>
          <h2>{t('not.segment.list.title')}</h2>
          {open.length === 0 ? (
            <p className="sub" role="status">
              {t('not.segment.list.none')}
            </p>
          ) : (
            <ul data-campaigns>
              {open.map((campaign) => (
                <CampaignRow key={campaign.id} campaign={campaign} canManage={canManage} />
              ))}
            </ul>
          )}
        </StateBoundary>
      </div>
    </section>
  );
}

function CreateForm({ onCreated }: { onCreated(): void }) {
  const { t } = useTranslation();
  const create = useCreateCampaign();
  const templates = useTemplates(true);
  const units = useOrgUnits();
  // Every page of the templates is read, so a template that is not among the newest is there to choose.
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = templates;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  const [form, setForm] = useState<CampaignForm>(emptyForm);
  const [shown, setShown] = useState<readonly CampaignProblem[]>([]);
  const problem = create.isError ? describeProblem(create.error) : undefined;
  const update = (change: Partial<CampaignForm>): void => setForm((current) => ({ ...current, ...change }));
  // Only an Active template can carry a campaign, without variables (a campaign has no event to take values from), and not the inbox, which is delivered by the insert itself and has no time to wait for.
  const active = (templates.data?.pages ?? []).flatMap((page) => page.items).filter((template) => template.status === 'Active' && template.channel !== 'IN_APP' && template.variables.length === 0);

  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (create.isPending) return;
    const found = campaignProblems(form, new Date());
    setShown(found);
    if (found.length > 0) return;
    create.reset();
    create.mutate(campaignBody(form), {
      onSuccess: () => {
        setForm(emptyForm());
        onCreated();
      },
    });
  };

  return (
    <form onSubmit={save} noValidate aria-label={t('not.segment.form.aria')} className="card" data-campaign-form>
      {problem === undefined ? null : (
        <p className="callout warning" role="alert" data-problem>
          {problemMessage(t, problem)}
        </p>
      )}
      {shown.map((item) => (
        <p key={item} className="callout warning" role="alert" data-form-problem={item}>
          {formProblemMessage(t, item)}
        </p>
      ))}
      <div className="field">
        <label htmlFor="campaign-name">{t('not.segment.form.name.label')}</label>
        <input id="campaign-name" value={form.name} onChange={(event) => update({ name: event.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="campaign-purpose">{t('not.segment.form.purpose.label')}</label>
        <select id="campaign-purpose" value={form.purpose} onChange={(event) => update({ purpose: event.target.value as CampaignForm['purpose'] })}>
          {PURPOSES.map((purpose) => (
            <option key={purpose} value={purpose}>
              {purposeLabel(t, purpose)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="campaign-template">{t('not.segment.form.template.label')}</label>
        <select id="campaign-template" value={form.templateId} onChange={(event) => update({ templateId: event.target.value })}>
          <option value="">{t('not.segment.form.template.none')}</option>
          {active.map((template) => (
            <option key={template.id} value={template.id}>
              {t('not.segment.form.template.option', { code: template.code, channel: template.channel, locale: template.locale, revision: template.revision })}
            </option>
          ))}
        </select>
      </div>
      <fieldset className="field">
        <legend>{t('not.segment.form.units.label')}</legend>
        {units.data === undefined || units.data.length === 0 ? (
          <p className="sub" data-no-units>
            {t('not.segment.form.units.none')}
          </p>
        ) : (
          units.data.map((unit) => (
            <label key={unit.id} style={{ display: 'block', paddingLeft: `${unit.depth}rem` }}>
              <input
                type="checkbox"
                checked={form.unitIds.includes(unit.id)}
                onChange={(event) => update({ unitIds: event.target.checked ? [...form.unitIds, unit.id] : form.unitIds.filter((id) => id !== unit.id) })}
              />{' '}
              {unit.name}
            </label>
          ))
        )}
      </fieldset>
      <div className="field">
        <label htmlFor="campaign-roles">{t('not.segment.form.roles.label')}</label>
        <input id="campaign-roles" value={form.roles} onChange={(event) => update({ roles: event.target.value })} />
        <small>{t('not.segment.form.roles.help')}</small>
      </div>
      <div className="field">
        <label>
          <input type="checkbox" checked={form.includeGuests} onChange={(event) => update({ includeGuests: event.target.checked })} /> {t('not.segment.form.guests.label')}
        </label>
      </div>
      <div className="field">
        <label htmlFor="campaign-schedule">{t('not.segment.form.schedule.label')}</label>
        <input id="campaign-schedule" type="datetime-local" value={form.scheduledAt} onChange={(event) => update({ scheduledAt: event.target.value })} />
        <small>{t('not.segment.form.schedule.help')}</small>
      </div>
      <div className="row gap">
        <button type="submit" className="primary" disabled={create.isPending}>
          {t('not.segment.form.submit.action')}
        </button>
      </div>
    </form>
  );
}

function CampaignRow({ campaign, canManage }: { campaign: Campaign; canManage: boolean }) {
  const { t, locale } = useTranslation();
  const preview = usePreviewCampaign();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [result, setResult] = useState<Preview | undefined>(undefined);
  const problem = preview.isError ? describeProblem(preview.error) : undefined;
  // What the screen shows is the last preview: the one just made, or the one the campaign holds.
  const count = result?.recipientCount ?? campaign.recipientCount;
  const excluded = result?.excluded ?? campaign.excluded;
  const hash = result?.hash ?? campaign.previewHash;

  const run = (event: FormEvent): void => {
    event.preventDefault();
    if (preview.isPending) return;
    if (reasonProblem(reason)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    preview.reset();
    preview.mutate({ campaign, reason: reason.trim() }, { onSuccess: (made) => { setResult(made); setAsking(false); setReason(''); } });
  };

  return (
    <li data-campaign-id={campaign.id}>
      <strong>{campaign.name}</strong> · {purposeLabel(t, campaign.purpose)} · {campaign.templateCode} ({campaign.templateChannel}) ·{' '}
      <span className="pill" data-status={campaign.status}>
        {statusLabel(t, campaign.status)}
      </span>
      {campaign.scheduledAt === undefined ? null : <span data-time> · {instantText(locale, campaign.scheduledAt)}</span>}
      {count === undefined ? (
        <p className="sub" data-no-preview>
          {t('not.segment.preview.none')}
        </p>
      ) : (
        <div data-preview>
          <p>
            <strong data-count>{t('not.segment.preview.count', { count })}</strong>
            {hash === undefined ? null : (
              <>
                {' · '}
                {t('not.segment.preview.hash')} <code data-hash>{shortHash(hash)}</code>
              </>
            )}
          </p>
          {excluded === undefined ? null : (
            <>
              <p className="sub">{t('not.segment.preview.excluded', { count: excludedTotal(excluded) })}</p>
              <ul data-excluded>
                {EXCLUSIONS.map((reasonCode) => (
                  <li key={reasonCode} data-reason={reasonCode}>
                    {exclusionLabel(t, reasonCode)}: <strong>{excluded[reasonCode]}</strong>
                  </li>
                ))}
              </ul>
            </>
          )}
          {result === undefined || result.samples.length === 0 ? null : (
            <p className="sub" data-samples>
              {t('not.segment.preview.samples', { names: result.samples.join(', ') })}
            </p>
          )}
        </div>
      )}
      {canManage ? (
        <>
          <button type="button" onClick={() => setAsking(!asking)}>
            {t('not.segment.preview.action')}
          </button>
          {asking ? (
            <form onSubmit={run} noValidate aria-label={t('not.segment.preview.form.aria', { name: campaign.name })} data-preview-form>
              {problem === undefined ? null : (
                <p className="callout warning" role="alert" data-problem>
                  {problemMessage(t, problem)}
                </p>
              )}
              {invalid ? (
                <p className="callout warning" role="alert" data-reason-problem>
                  {t('not.segment.preview.reason.invalid')}
                </p>
              ) : null}
              <label htmlFor={`preview-reason-${campaign.id}`}>{t('not.segment.preview.reason.label')}</label>
              <textarea id={`preview-reason-${campaign.id}`} value={reason} onChange={(event) => setReason(event.target.value)} />
              <button type="submit" className="primary" disabled={preview.isPending}>
                {t('not.segment.preview.run.action')}
              </button>
            </form>
          ) : null}
        </>
      ) : null}
    </li>
  );
}
