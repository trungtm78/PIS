import { ApiError } from '@machvon/api-client';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, SectionCard, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { pathOfAlert } from '../../ui/alerts/AlertRow';
import { Banner, DefectList, FigureInfo, RuleNote, momentText, problemText } from './components';
import { useMyDigest, useMyProfile, useSaveProfile } from './hooks';
import { channelText, sectionText, severityText } from './labels';
import { CHANNELS, HOME_PERMISSION, INTERRUPTING, SEVERITIES, defectsOf } from './model';
import type { AlertSeverity, Channel, Digest, ProfileInput, ProfileView, QuietHours } from './model';

type T = Translator['t'];
type Choice = Record<AlertSeverity, Channel[]>;

interface Form {
  channelsOwn: boolean;
  channels: Choice;
  quietOwn: boolean;
  quiet: QuietHours;
  digestEnabled: boolean;
  digestAt: string;
  pushMin: '' | 'URGENT' | 'ACTION';
  cap: string;
  group: '' | 'true' | 'false';
}

const asChannels = (list: readonly string[] | undefined): Channel[] => CHANNELS.filter((channel) => channel !== 'IN_APP' && (list ?? []).includes(channel));

/** The form as the person saw it when it was read: what they chose themselves is theirs, the rest stays on the policy. */
function formOf(view: ProfileView): Form {
  const own = view.profile;
  const source = own.channels ?? view.effective.channels;
  return {
    channelsOwn: own.channels !== null,
    channels: { URGENT: asChannels(source.URGENT), ACTION: asChannels(source.ACTION), WATCH: asChannels(source.WATCH) },
    quietOwn: own.quiet !== null,
    quiet: own.quiet ?? view.effective.quiet,
    digestEnabled: own.digestEnabled,
    digestAt: own.digestAt ?? '',
    pushMin: own.pushMinSeverity ?? '',
    cap: own.pushCapPerDay === null ? '' : String(own.pushCapPerDay),
    group: own.groupSameRoot === null ? '' : own.groupSameRoot ? 'true' : 'false',
  };
}

const capOf = (form: Form): number | null | undefined => {
  if (form.cap.trim() === '') return null;
  return /^\d{1,3}$/.test(form.cap.trim()) ? Number(form.cap.trim()) : undefined;
};

function inputOf(form: Form): ProfileInput | undefined {
  const cap = capOf(form);
  if (cap === undefined) return undefined;
  return {
    channels: form.channelsOwn ? { URGENT: ['IN_APP', ...form.channels.URGENT], ACTION: ['IN_APP', ...form.channels.ACTION], WATCH: ['IN_APP', ...form.channels.WATCH] } : null,
    quiet: form.quietOwn ? form.quiet : null,
    digestEnabled: form.digestEnabled,
    digestAt: form.digestAt === '' ? null : form.digestAt,
    pushMinSeverity: form.pushMin === '' ? null : form.pushMin,
    pushCapPerDay: cap,
    groupSameRoot: form.group === '' ? null : form.group === 'true',
  };
}

const policyNumber = (view: ProfileView, key: string): number => (typeof view.rule.params[key] === 'number' ? (view.rule.params[key] as number) : 0);
const policyText = (view: ProfileView, key: string): string => (typeof view.rule.params[key] === 'string' ? (view.rule.params[key] as string) : '');

interface EffectiveRow {
  key: string;
  label: string;
  value: string;
  own: boolean;
}

function effectiveRows(t: T, view: ProfileView): EffectiveRow[] {
  const effective = view.effective;
  return [
    ...SEVERITIES.map((severity) => ({ key: `channels-${severity}`, label: t('alertgov.profile.effective.channels', { severity: severityText(t, severity) }), value: effective.channels[severity].map((channel) => channelText(t, channel)).join(', '), own: effective.own.channels })),
    { key: 'quiet', label: t('alertgov.profile.effective.quiet'), value: t('alertgov.profile.effective.quiet.value', { from: effective.quiet.from, to: effective.quiet.to, zone: effective.quiet.timeZone }) + (effective.quiet.weekends ? ` · ${t('alertgov.profile.effective.weekends')}` : ''), own: effective.own.quiet },
    { key: 'digest', label: t('alertgov.profile.effective.digest'), value: effective.digestEnabled ? effective.digestAt : t('alertgov.profile.effective.digestOff'), own: effective.own.digestAt },
    { key: 'min', label: t('alertgov.profile.effective.min'), value: severityText(t, effective.pushMinSeverity), own: effective.own.pushMinSeverity },
    { key: 'cap', label: t('alertgov.profile.effective.cap'), value: String(effective.pushCapPerDay), own: effective.own.pushCapPerDay },
    { key: 'group', label: t('alertgov.profile.effective.group'), value: effective.groupSameRoot ? t('alertgov.profile.yes.text') : t('alertgov.profile.no.text'), own: effective.own.groupSameRoot },
  ];
}

function DigestCard({ digest }: { digest: Digest }) {
  const { t } = useTranslation();
  return (
    <div data-testid="digest">
      <p className="alertgov-sub">{t('alertgov.profile.digest.summary', { total: digest.total, at: digest.digestAt })}</p>
      {digest.unavailableSources.length === 0 ? null : (
        <Banner tone="warning" testId="digest-partial">
          <span>{t('alertgov.profile.digest.partial', { sources: digest.unavailableSources.join(', ') })}</span>
        </Banner>
      )}
      {digest.total === 0 ? <p data-testid="digest-empty">{t('alertgov.profile.digest.empty')}</p> : null}
      {digest.sections
        .filter((section) => section.count > 0)
        .map((section) => (
          <section key={section.code} aria-label={sectionText(t, section.code)} data-testid={`section-${section.code}`}>
            <h3>
              {sectionText(t, section.code)} ({section.count})
            </h3>
            <ul className="alertgov-list">
              {section.lines.map((line) => {
                const path = pathOfAlert({ target: line.action });
                return (
                  <li key={`${line.source}:${line.id}`} className="alertgov-line">
                    <span>
                      <StatusPill tone={line.severity === 'URGENT' ? 'danger' : line.severity === 'ACTION' ? 'warning' : 'neutral'}>{severityText(t, line.severity)}</StatusPill> <strong>{line.title}</strong>
                    </span>
                    {line.onBehalfOf === null ? null : <span className="alertgov-sub">{t('alertgov.profile.digest.onBehalf', { name: line.onBehalfOf })}</span>}
                    {line.consequence === null ? <span className="alertgov-sub">{t('alertgov.profile.digest.noConsequence')}</span> : <span className="alertgov-sub">{t('alertgov.profile.digest.consequence', { text: line.consequence })}</span>}
                    {path === undefined ? null : <Link to={path}>{t('alertgov.profile.digest.act')}</Link>}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      {digest.omitted > 0 ? <p className="alertgov-sub">{t('alertgov.profile.digest.omitted', { count: digest.omitted })}</p> : null}
    </div>
  );
}

function ProfileForm({ view, onReload }: { view: ProfileView; onReload: () => void }) {
  const { t } = useTranslation();
  const save = useSaveProfile();
  const [form, setForm] = useState<Form>(() => formOf(view));
  const [checked, setChecked] = useState(false);
  const policyCap = policyNumber(view, 'push_cap_per_day');
  const cap = capOf(form);
  const capError = cap === undefined || (cap !== null && cap > policyCap);
  const failure = save.error;
  const defects = failure instanceof ApiError ? defectsOf(failure.extensions) : [];
  const fieldBad = (name: string): boolean => defects.some((defect) => defect.field === name || defect.field.startsWith(`${name}.`));
  const conflict = failure instanceof ApiError && failure.code === 'VERSION_CONFLICT';
  const set = (patch: Partial<Form>): void => {
    setForm((current) => ({ ...current, ...patch }));
    setChecked(false);
    save.reset();
  };
  const toggle = (severity: AlertSeverity, channel: Channel, on: boolean): void => set({ channelsOwn: true, channels: { ...form.channels, [severity]: on ? [...form.channels[severity], channel] : form.channels[severity].filter((one) => one !== channel) } });

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setChecked(true);
    const input = inputOf(form);
    if (input === undefined || capError) return;
    save.mutate({ profile: input, version: view.version });
  };

  return (
    <form className="alertgov-form" onSubmit={submit} noValidate aria-label={t('alertgov.profile.form.label')} data-testid="profile-form">
      <fieldset>
        <legend>{t('alertgov.profile.channels.legend')}</legend>
        <label className="alertgov-row">
          <input type="checkbox" checked={!form.channelsOwn} onChange={(event) => set({ channelsOwn: !event.target.checked })} data-testid="channels-policy" /> {t('alertgov.profile.channels.policy')}
        </label>
        {SEVERITIES.map((severity) => (
          <div key={severity} className="alertgov-row" role="group" aria-label={severityText(t, severity)} aria-invalid={fieldBad(`channels.${severity}`)}>
            <strong>{severityText(t, severity)}</strong>
            <label>
              <input type="checkbox" checked disabled aria-label={t('alertgov.profile.bell.label', { severity: severityText(t, severity) })} data-testid={`bell-${severity}`} /> {channelText(t, 'IN_APP')}
            </label>
            {CHANNELS.filter((channel) => channel !== 'IN_APP').map((channel) => {
              const locked = severity === 'WATCH' && INTERRUPTING.includes(channel);
              return (
                <label key={channel}>
                  <input type="checkbox" checked={form.channels[severity].includes(channel)} disabled={locked} onChange={(event) => toggle(severity, channel, event.target.checked)} data-testid={`channel-${severity}-${channel}`} /> {channelText(t, channel)}
                </label>
              );
            })}
          </div>
        ))}
        <span className="alertgov-sub">{t('alertgov.profile.channels.hint')}</span>
      </fieldset>

      <fieldset>
        <legend>{t('alertgov.profile.quiet.legend')}</legend>
        <label className="alertgov-row">
          <input type="checkbox" checked={!form.quietOwn} onChange={(event) => set({ quietOwn: !event.target.checked })} data-testid="quiet-policy" /> {t('alertgov.profile.quiet.policy')}
        </label>
        <div className="alertgov-row">
          <div className="field">
            <label htmlFor="alertgov-quiet-from">{t('alertgov.profile.quiet.from')}</label>
            <input id="alertgov-quiet-from" type="time" value={form.quiet.from} disabled={!form.quietOwn} aria-invalid={fieldBad('quiet.from')} onChange={(event) => set({ quiet: { ...form.quiet, from: event.target.value } })} data-testid="quiet-from" />
          </div>
          <div className="field">
            <label htmlFor="alertgov-quiet-to">{t('alertgov.profile.quiet.to')}</label>
            <input id="alertgov-quiet-to" type="time" value={form.quiet.to} disabled={!form.quietOwn} aria-invalid={fieldBad('quiet.to')} onChange={(event) => set({ quiet: { ...form.quiet, to: event.target.value } })} data-testid="quiet-to" />
          </div>
          <div className="field">
            <label htmlFor="alertgov-quiet-zone">{t('alertgov.profile.quiet.zone')}</label>
            <input id="alertgov-quiet-zone" type="text" value={form.quiet.timeZone} disabled={!form.quietOwn} aria-invalid={fieldBad('quiet.time_zone')} onChange={(event) => set({ quiet: { ...form.quiet, timeZone: event.target.value } })} data-testid="quiet-zone" />
          </div>
          <label>
            <input type="checkbox" checked={form.quiet.weekends} disabled={!form.quietOwn} onChange={(event) => set({ quiet: { ...form.quiet, weekends: event.target.checked } })} data-testid="quiet-weekends" /> {t('alertgov.profile.quiet.weekends')}
          </label>
        </div>
        <span className="alertgov-sub">{t('alertgov.profile.quiet.hint')}</span>
      </fieldset>

      <fieldset>
        <legend>{t('alertgov.profile.digest.legend')}</legend>
        <label className="alertgov-row">
          <input type="checkbox" checked={form.digestEnabled} onChange={(event) => set({ digestEnabled: event.target.checked })} data-testid="digest-enabled" /> {t('alertgov.profile.digest.enabled')}
        </label>
        <div className="field">
          <label htmlFor="alertgov-digest-at">{t('alertgov.profile.digest.at')}</label>
          <input id="alertgov-digest-at" type="time" value={form.digestAt} aria-invalid={fieldBad('digest_at')} onChange={(event) => set({ digestAt: event.target.value })} data-testid="digest-at" />
          <span className="alertgov-sub">{t('alertgov.profile.digest.atHint', { value: policyText(view, 'digest_at') })}</span>
        </div>
      </fieldset>

      <fieldset>
        <legend>{t('alertgov.profile.push.legend')}</legend>
        <div className="alertgov-row">
          <div className="field">
            <label htmlFor="alertgov-push-min">{t('alertgov.profile.push.min')}</label>
            <select id="alertgov-push-min" value={form.pushMin} aria-invalid={fieldBad('push_min_severity')} onChange={(event) => set({ pushMin: event.target.value === 'URGENT' ? 'URGENT' : event.target.value === 'ACTION' ? 'ACTION' : '' })} data-testid="push-min">
              <option value="">{t('alertgov.profile.policy.option')}</option>
              <option value="URGENT">{severityText(t, 'URGENT')}</option>
              <option value="ACTION">{severityText(t, 'ACTION')}</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="alertgov-cap">{t('alertgov.profile.push.cap')}</label>
            <input id="alertgov-cap" type="number" min={0} max={policyCap} value={form.cap} aria-invalid={(checked && capError) || fieldBad('push_cap_per_day')} aria-describedby="alertgov-cap-hint" onChange={(event) => set({ cap: event.target.value })} data-testid="cap" />
            <span className="alertgov-sub" id="alertgov-cap-hint">
              {t('alertgov.profile.push.capHint', { max: policyCap })}
            </span>
            {checked && capError ? (
              <span className="alertgov-error" data-testid="cap-error">
                {t('alertgov.profile.push.capError', { max: policyCap })}
              </span>
            ) : null}
          </div>
          <div className="field">
            <label htmlFor="alertgov-group">{t('alertgov.profile.push.group')}</label>
            <select id="alertgov-group" value={form.group} onChange={(event) => set({ group: event.target.value === 'true' ? 'true' : event.target.value === 'false' ? 'false' : '' })} data-testid="group">
              <option value="">{t('alertgov.profile.policy.option')}</option>
              <option value="true">{t('alertgov.profile.yes.text')}</option>
              <option value="false">{t('alertgov.profile.no.text')}</option>
            </select>
          </div>
        </div>
        <span className="alertgov-sub">{t('alertgov.profile.push.hint')}</span>
      </fieldset>

      {failure === null ? null : (
        <Banner tone="danger" role="alert" testId="save-error">
          <div>
            <p>{problemText(t, failure)}</p>
            <DefectList defects={defects} />
          </div>
          {conflict ? (
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onReload} data-testid="reload">
              {t('alertgov.profile.reload.action')}
            </button>
          ) : null}
        </Banner>
      )}
      {save.isSuccess ? <p className="alertgov-ok" role="status" data-testid="saved">{t('alertgov.profile.saved.text')}</p> : null}
      <div className="alertgov-actions">
        <button type="submit" className="ui-button ui-button--primary" disabled={save.isPending} data-testid="save">
          {save.isPending ? t('alertgov.profile.save.pending') : t('alertgov.profile.save.action')}
        </button>
      </div>
    </form>
  );
}

/**
 * NOT-18: how I am reached about alerts (G2-5). The bell of the application is always on and cannot be switched off; the channels that interrupt (push, SMS, Zalo) are for what is urgent or to be acted on, keep my quiet hours and my cap, and an
 * item to be watched only goes in the morning digest. What I leave on the policy is the policy's (shown with its version and, when nobody confirmed the numbers, saying so); what I set is mine and is shown as mine. The digest card is previewed here. A push
 * carries no amount and no name, only a count and a link.
 */
export default function ProfileScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <ProfileContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ProfileContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, permissions } = useSession();
  const may = permissions === undefined || permissions.includes(HOME_PERMISSION);
  const profile = useMyProfile(may);
  const digest = useMyDigest(may);
  const queryState = useScreenState({ isLoading: profile.isLoading, error: profile.data === undefined ? profile.error : undefined, data: profile.data, isEmpty: () => false });
  const state = may ? queryState : 'denied';
  const view = profile.data;
  const columns: DataTableColumn<EffectiveRow>[] = [
    { key: 'setting', header: t('alertgov.profile.effective.setting'), render: (row) => row.label },
    { key: 'value', header: t('alertgov.profile.effective.value'), render: (row) => row.value },
    { key: 'whose', header: t('alertgov.profile.effective.whose'), render: (row) => <StatusPill tone={row.own ? 'info' : 'neutral'}>{row.own ? t('alertgov.profile.whose.own') : t('alertgov.profile.whose.policy')}</StatusPill> },
  ];
  const digestState = useScreenState({ isLoading: digest.isLoading, error: digest.data === undefined ? digest.error : undefined, data: digest.data, isEmpty: () => false });

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('alertgov.profile.title')}</h1>
          <p>{t('alertgov.profile.subtitle')}</p>
        </div>
      </div>
      <ContextBar items={[{ label: t('alertgov.ctx.scope'), value: tenant?.name ?? t('alertgov.ctx.scopeAll') }]} {...(view === undefined ? {} : { asOf: momentText(view.asOf) })} />
      <StateBoundary state={state} onRetry={() => void profile.refetch()}>
        {view === undefined ? null : (
          <div className="alertgov-stack">
            {profile.isError ? (
              <Banner tone="warning" testId="stale">
                <span>{t('alertgov.profile.stale.text')}</span>
              </Banner>
            ) : null}
            <ProfileForm key={view.version} view={view} onReload={() => void profile.refetch()} />
            <div className="alertgov-pair">
              <SectionCard title={t('alertgov.profile.effective.title')}>
                <DataTable<EffectiveRow> caption={t('alertgov.profile.effective.caption')} columns={columns} rows={effectiveRows(t, view)} rowKey={(row) => row.key} />
              </SectionCard>
              <SectionCard title={t('alertgov.profile.policy.title')} actions={<FigureInfo name={t('alertgov.profile.policy.title')} formula={view.rule.formula} source={view.rule.source} asOf={view.asOf} rule={view.rule} />}>
                <RuleNote rule={view.rule} />
                <ul className="alertgov-meta" data-testid="policy-numbers">
                  <li>{t('alertgov.profile.policy.quiet', { from: policyText(view, 'quiet_from'), to: policyText(view, 'quiet_to') })}</li>
                  <li>{t('alertgov.profile.policy.cap', { count: policyNumber(view, 'push_cap_per_day') })}</li>
                  <li>{t('alertgov.profile.policy.digest', { at: policyText(view, 'digest_at') })}</li>
                  <li>{t('alertgov.profile.policy.group', { count: policyNumber(view, 'urgent_group_after_per_hour') })}</li>
                </ul>
              </SectionCard>
            </div>
            <SectionCard title={t('alertgov.profile.digest.title')}>
              <StateBoundary state={digestState} onRetry={() => void digest.refetch()}>
                {digest.data === undefined ? null : <DigestCard digest={digest.data} />}
              </StateBoundary>
            </SectionCard>
          </div>
        )}
      </StateBoundary>
    </section>
  );
}
