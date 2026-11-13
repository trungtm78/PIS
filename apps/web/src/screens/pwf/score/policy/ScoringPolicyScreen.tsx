import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../../i18n';
import type { ScreenProps } from '../../../../routes/types';
import { useSession } from '../../../../session/SessionContext';
import { StateBoundary } from '../../../../states/StateBoundary';
import { useScreenState } from '../../../../states/useScreenState';
import { SectionCard } from '../../../../ui';
import { useCatalogue, useEffective } from '../../../adm/governance/hooks';
import { FigureInfo, UnverifiedLabel } from '../../components';
import { roleWord, priorityWord } from '../../labels';
import { PATHS, PERMISSIONS, RULE_PERMISSIONS, holds } from '../../model';
import { RuleSavePanel, RuleVersionList } from '../../templates/store';
import { SupportNotice } from '../components';
import { useScoreCacheGuard } from '../hooks';
import { SCORE_PATHS } from '../model';
import { RuleField, RuleSelect } from './RuleField';
import { CANCEL_CHOICES, DEFAULT_POLICY_CODE, MAX_BANDS, PERIOD_KINDS, POLICY_RULE_TYPE, PRIORITIES, ROLES, addBand, blankForm, formOf, paramsOf, problemsOf, removeBand, updateBand } from './policy-model';
import type { PolicyForm } from './policy-model';
import { CODE } from './rule-model';
import '../../pwf.css';
import '../../templates/templates.css';
import '../score.css';

/**
 * PWF-10: the scoring policy. How the scores of the tasks become the score of a person in a period: the factor of each role, the weight of each priority, the thresholds of a small sample, the bands, the swing of an adjustment, the window of
 * response and how long the data is kept. A draft goes into the rule store and a different person approves it. Nothing here makes a score lead to a reward, a penalty or a dismissal: the score supports the decision of a person who has the authority.
 */
export default function ScoringPolicyScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <PolicyContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function PolicyContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [params, setParams] = useSearchParams();
  useScoreCacheGuard();
  const code = params.get('code') ?? DEFAULT_POLICY_CODE;
  const codeValid = CODE.test(code);
  const mayRead = holds(permissions, PERMISSIONS.read);
  const writable = mode !== 'READ_ONLY';
  const canStore = writable && (permissions === undefined || permissions.includes(RULE_PERMISSIONS.manage));
  const canApprove = writable && (permissions === undefined || permissions.includes(RULE_PERMISSIONS.approve));
  const effective = useEffective(POLICY_RULE_TYPE, codeValid ? code : undefined, undefined, mayRead && codeValid);
  const catalogue = useCatalogue(mayRead);
  const [edited, setEdited] = useState<PolicyForm | undefined>(undefined);
  const [attempted, setAttempted] = useState(false);
  const base = useMemo(() => (effective.data === null || effective.data === undefined ? blankForm() : formOf(effective.data.params)), [effective.data]);
  const form = edited ?? base;
  const problems = useMemo(() => problemsOf(form), [form]);
  const show = attempted || edited !== undefined;
  const state = useScreenState({ isLoading: effective.isLoading, error: effective.error, data: effective.isLoading ? undefined : true, isEmpty: () => false });
  const screenState = !mayRead ? 'denied' : state;
  const set = (next: PolicyForm): void => setEdited(next);
  const unverified = effective.data?.unverified === true;
  const known = catalogue.data?.find((entry) => entry.ruleType === POLICY_RULE_TYPE)?.codes.map((entry) => entry.code) ?? [];
  const baseNote = effective.data === null || effective.data === undefined ? t('pwfs.policy.base.blank') : effective.data.source === 'RULE' ? t('pwfs.policy.base.rule', { version: effective.data.version }) : t('pwfs.policy.base.default');
  const common = { problems, show, disabled: !canStore };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pwfs.policy.title.text')}</h1>
          <p>{t('pwfs.policy.subtitle.text')}</p>
        </div>
      </div>
      <SupportNotice />
      <StateBoundary state={screenState} onRetry={() => void effective.refetch()}>
        {canStore ? null : (
          <p className="callout" role="status" data-testid="read-only">
            {t('pwfs.policy.readOnly.text')}
          </p>
        )}
        <SectionCard title={t('pwfs.policy.code.title')} status={unverified ? <UnverifiedLabel /> : undefined}>
          <div className="pwf-tpl-row">
            <RuleField
              label={t('pwfs.policy.code.label')}
              path="code"
              value={code}
              disabled={false}
              show
              problems={codeValid ? [] : [{ path: 'code', kind: 'pattern' }]}
              suggestions={known}
              onChange={(value) => {
                setParams({ code: value.trim().toUpperCase() });
                setEdited(undefined);
                setAttempted(false);
              }}
            />
            <RuleSelect label={t('pwfs.policy.period.label')} path="period_kind" value={form.periodKind} disabled={!canStore} options={PERIOD_KINDS.map((value) => ({ value, label: value === 'MONTH' ? t('pwfs.policy.period.month.option') : value === 'QUARTER' ? t('pwfs.policy.period.quarter.option') : t('pwfs.policy.period.year.option') }))} onChange={(periodKind) => set({ ...form, periodKind })} />
          </div>
          <p className="adm-kit-sub" data-testid="base-note">
            {baseNote}
          </p>
          {unverified ? (
            <p className="callout warning" role="status" data-testid="unverified-note">
              {t('pwfs.policy.unverified.hint')}
            </p>
          ) : null}
        </SectionCard>
        <StateBoundary state={effective.isLoading ? 'loading' : 'default'}>
          <SectionCard title={t('pwfs.policy.roles.title')}>
            <p className="adm-kit-sub">{t('pwfs.policy.roles.hint')}</p>
            <div className="pwf-tpl-row">
              {ROLES.map((role) => (
                <RuleField key={role} label={roleWord(t, role)} path={`role_factors.${role}`} value={form.roleFactors[role]} inputMode="decimal" onChange={(value) => set({ ...form, roleFactors: { ...form.roleFactors, [role]: value } })} {...common} />
              ))}
            </div>
          </SectionCard>
          <SectionCard title={t('pwfs.policy.priorities.title')}>
            <p className="adm-kit-sub">{t('pwfs.policy.priorities.hint')}</p>
            <div className="pwf-tpl-row">
              {PRIORITIES.map((priority) => (
                <RuleField key={priority} label={priorityWord(t, priority)} path={`priority_weights.${priority}`} value={form.priorityWeights[priority]} inputMode="decimal" onChange={(value) => set({ ...form, priorityWeights: { ...form.priorityWeights, [priority]: value } })} {...common} />
              ))}
            </div>
            <label className="pwf-field">
              <span>
                <input type="checkbox" checked={form.weightByPlannedDays} disabled={!canStore} data-testid="field-weight_by_planned_days" onChange={(event) => set({ ...form, weightByPlannedDays: event.target.checked })} /> {t('pwfs.policy.plannedDays.label')}
              </span>
              <span className="gova1-hint">{t('pwfs.policy.plannedDays.hint')}</span>
            </label>
            <RuleSelect
              label={t('pwfs.policy.cancelled.label')}
              path="cancelled_unapproved"
              value={form.cancelledUnapproved}
              disabled={!canStore}
              hint={t('pwfs.policy.cancelled.hint')}
              options={CANCEL_CHOICES.map((value) => ({ value, label: value === 'COUNT_AS_MISSED' ? t('pwfs.policy.cancelled.missed.option') : t('pwfs.policy.cancelled.ignore.option') }))}
              onChange={(cancelledUnapproved) => set({ ...form, cancelledUnapproved })}
            />
          </SectionCard>
          <SectionCard title={t('pwfs.policy.sample.title')}>
            <p className="adm-kit-sub">{t('pwfs.policy.sample.hint')}</p>
            <div className="pwf-tpl-row">
              <RuleField label={t('pwfs.policy.sample.tasks.label')} path="min_rated_tasks" value={form.minRatedTasks} inputMode="numeric" onChange={(minRatedTasks) => set({ ...form, minRatedTasks })} {...common} />
              <RuleField label={t('pwfs.policy.sample.weight.label')} path="min_effective_weight" value={form.minEffectiveWeight} inputMode="decimal" onChange={(minEffectiveWeight) => set({ ...form, minEffectiveWeight })} {...common} />
            </div>
          </SectionCard>
          <SectionCard title={t('pwfs.policy.bands.title')} status={<span data-testid="band-count">{t('pwfs.policy.bands.count', { count: form.bands.length, max: MAX_BANDS })}</span>}>
            <p className="adm-kit-sub">{t('pwfs.policy.bands.hint')}</p>
            <ol className="pwf-tpl-rows" data-testid="bands">
              {form.bands.map((band, at) => (
                <li key={at} className="pwf-tpl-row">
                  <RuleField label={t('pwfs.policy.band.code.label', { number: at + 1 })} path={`bands[${at}].code`} value={band.code} onChange={(value) => set(updateBand(form, at, { code: value }))} {...common} />
                  <RuleField label={t('pwfs.policy.band.min.label', { number: at + 1 })} path={`bands[${at}].min_score`} value={band.minScore} inputMode="decimal" onChange={(value) => set(updateBand(form, at, { minScore: value }))} {...common} />
                  <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={!canStore || form.bands.length <= 2} data-action={`remove-band-${at}`} onClick={() => set(removeBand(form, at))}>
                    {t('pwfs.policy.band.remove.action')}
                  </button>
                </li>
              ))}
            </ol>
            <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={!canStore || form.bands.length >= MAX_BANDS} data-action="add-band" onClick={() => set(addBand(form))}>
              {t('pwfs.policy.band.add.action')}
            </button>
          </SectionCard>
          <SectionCard title={t('pwfs.policy.calibration.title')}>
            <p className="adm-kit-sub">{t('pwfs.policy.calibration.hint')}</p>
            <div className="pwf-tpl-row">
              <RuleField label={t('pwfs.policy.calibration.max.label')} path="calibration.max_adjustment_points" value={form.maxAdjustment} inputMode="numeric" onChange={(maxAdjustment) => set({ ...form, maxAdjustment })} {...common} />
              <RuleField label={t('pwfs.policy.calibration.reason.label')} path="calibration.min_reason_length" value={form.minReason} inputMode="numeric" onChange={(minReason) => set({ ...form, minReason })} {...common} />
            </div>
            <label className="pwf-field">
              <span>
                <input type="checkbox" checked={form.secondApprover} disabled={!canStore} data-testid="field-second_approver" onChange={(event) => set({ ...form, secondApprover: event.target.checked })} /> {t('pwfs.policy.calibration.second.label')}
              </span>
              <span className="gova1-hint">{t('pwfs.policy.calibration.second.hint')}</span>
            </label>
          </SectionCard>
          <SectionCard title={t('pwfs.policy.window.title')}>
            <div className="pwf-tpl-row">
              <RuleField label={t('pwfs.policy.window.days.label')} path="response_window_days" value={form.responseWindow} inputMode="numeric" hint={t('pwfs.policy.window.days.hint')} onChange={(responseWindow) => set({ ...form, responseWindow })} {...common} />
              <RuleField
                label={t('pwfs.policy.retention.label')}
                path="retention_months"
                value={form.retention}
                inputMode="numeric"
                hint={t('pwfs.policy.retention.hint')}
                info={<FigureInfo name={t('pwfs.policy.retention.label')} formula={t('pwfs.policy.retention.formula')} source={t('pwfs.policy.info.source')} asOf={null} version={t('pwfs.policy.info.version')} unverified />}
                onChange={(retention) => set({ ...form, retention })}
                {...common}
              />
            </div>
          </SectionCard>
        </StateBoundary>
        {canStore ? <RuleSavePanel ruleType={POLICY_RULE_TYPE} code={code} codeValid={codeValid} formOk={problems.length === 0} params={() => paramsOf(form)} onAttempt={() => setAttempted(true)} disabled={false} /> : null}
        {codeValid ? (
          <RuleVersionList
            ruleType={POLICY_RULE_TYPE}
            code={code}
            canManage={canStore}
            canApprove={canApprove}
            writable={writable}
            editLink={() => `${SCORE_PATHS.policy}?code=${code}`}
            diffLink={(id, against) => `${PATHS.ruleDiff}?rule=${id}${against === undefined ? '' : `&against=${against}`}`}
          />
        ) : null}
      </StateBoundary>
      <p className="adm-kit-foot" data-testid="footer">
        {t('gova1.footer.reference', { id: route.id, req: route.req ?? '' })}
      </p>
    </section>
  );
}
