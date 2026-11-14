import { useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { SectionCard, StatusPill } from '../../../ui';
import { useEffective } from '../../adm/governance/hooks';
import { BandBadge, FigureInfo, ProblemBanner, UnverifiedLabel } from '../components';
import { priorityWord, kindWord, unitWord } from '../labels';
import { BAND_RULE_TYPE, PATHS, PERMISSIONS, RULE_PERMISSIONS, describeProblem, holds } from '../model';
import type { BandUnit } from '../model';
import { RuleSavePanel, RuleVersionList } from '../templates/store';
import { OWNER_EXAMPLE, PRIORITIES, SOURCES, SOURCE_UNIT, TASK_KINDS, UNITS, addOverride, blankForm, formOf, paramsOf, problemsOf, removeOverride, thresholdsOf, updateOverride } from './band-model';
import type { BandForm, BandProblem, Ladder, OverrideForm, Source, Thresholds } from './band-model';
import { useBandPreview } from './hooks';
import { sentenceText } from './sentence';
import '../pwf.css';
import '../templates/templates.css';

type T = Translator['t'];

function sourceWord(t: T, source: Source): string {
  switch (source) {
    case 'HOME_WORK':
      return t('pwf.bands.source.homeWork.word');
    case 'REPORT_SCHEDULE':
      return t('pwf.bands.source.reportSchedule.word');
    case 'PROJECT_TASK':
      return t('pwf.bands.source.projectTask.word');
  }
}

function problemWord(t: T, problem: BandProblem): string {
  switch (problem.kind) {
    case 'required':
      return t('pwf.bands.problem.required.error');
    case 'integer':
      return t('pwf.bands.problem.integer.error');
    case 'range':
      return t('pwf.bands.problem.range.error', { min: problem.min ?? 0, max: problem.max ?? 0 });
    case 'order':
      return t('pwf.bands.problem.order.error');
    case 'unitMismatch':
      return t('pwf.bands.problem.unitMismatch.error');
    case 'phase':
      return t('pwf.bands.problem.phase.error');
    case 'listSize':
      return t('pwf.bands.problem.listSize.error', { max: problem.max ?? 0 });
    case 'reminderOrder':
      return t('pwf.bands.problem.reminderOrder.error');
  }
}

/**
 * PWF-08: the three-colour policy of a source of alerts. The numbers that turn a deadline green, yellow and red, with overrides by kind of task, priority and phase, the reminder days and the escalation. The effect of the numbers is
 * shown before anything is written ("5 days left: green, 2 days: yellow, under 1 day: red"); a draft goes into the rule store and a different person approves it.
 */
export default function BandPolicyScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <PolicyContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function PolicyContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [params] = useSearchParams();
  const requested = SOURCES.find((one) => one === params.get('code'));
  const [chosen, setChosen] = useState<Source | undefined>(undefined);
  const source: Source = chosen ?? requested ?? 'PROJECT_TASK';
  const mayRead = holds(permissions, PERMISSIONS.read);
  const writable = mode !== 'READ_ONLY';
  const canStore = writable && (permissions === undefined || permissions.includes(RULE_PERMISSIONS.manage));
  const canApprove = writable && (permissions === undefined || permissions.includes(RULE_PERMISSIONS.approve));
  const effective = useEffective(BAND_RULE_TYPE, source, undefined, mayRead);
  const [edited, setEdited] = useState<BandForm | undefined>(undefined);
  const [attempted, setAttempted] = useState(false);
  const base = useMemo(() => (effective.data === null || effective.data === undefined ? blankForm(SOURCE_UNIT[source]) : formOf(effective.data.params)), [effective.data, source]);
  const form = edited ?? base;
  const problems = useMemo(() => problemsOf(form, source), [form, source]);
  const show = attempted || edited !== undefined;
  const thresholds = thresholdsOf(form);
  const preview = useBandPreview(thresholds, form.unit, mayRead && form.unit === SOURCE_UNIT[source]);
  // Only the first read holds the screen back; choosing another source keeps the choice on the screen while the policy of that source is read.
  const state = useScreenState({ isLoading: effective.isLoading && chosen === undefined, error: effective.error, data: effective.isLoading && chosen === undefined ? undefined : true, isEmpty: () => false });
  const screenState = !mayRead ? 'denied' : state;
  const set = (next: BandForm): void => setEdited(next);
  const unverified = effective.data?.unverified === true;
  const baseNote =
    effective.data === null || effective.data === undefined ? t('pwf.bands.base.blank') : effective.data.source === 'RULE' ? t('pwf.bands.base.rule', { version: effective.data.version }) : t('pwf.bands.base.default');

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pwf.bands.title.text')}</h1>
          <p>{t('pwf.bands.subtitle.text')}</p>
        </div>
        <nav aria-label={t('pwf.bands.links.label')}>
          <Link to={PATHS.board} data-testid="link-board">
            {t('pwf.bands.board.link')}
          </Link>
        </nav>
      </div>
      <StateBoundary state={screenState} onRetry={() => void effective.refetch()}>
        {canStore ? null : (
          <p className="callout" role="status" data-testid="read-only">
            {t('pwf.bands.readOnly.text')}
          </p>
        )}
        <SectionCard title={t('pwf.bands.source.title')} status={unverified ? <UnverifiedLabel /> : undefined}>
          <div className="pwf-tpl-row">
            <div className="pwf-field">
              <label htmlFor="pwf-band-source">{t('pwf.bands.source.label')}</label>
              <select
                id="pwf-band-source"
                value={source}
                data-testid="source"
                onChange={(event) => {
                  setChosen(event.target.value as Source);
                  setEdited(undefined);
                  setAttempted(false);
                }}
              >
                {SOURCES.map((one) => (
                  <option key={one} value={one}>
                    {sourceWord(t, one)}
                  </option>
                ))}
              </select>
              {/* The codes the three sources carry in the rule store, where the versions of this rule are listed by code. */}
              <span className="gova1-hint" data-testid="source-codes">
                {t('fix9.pwf08.source.codes')}
              </span>
            </div>
            <SelectUnit value={form.unit} source={source} disabled={!canStore} problems={problems} show={show} onChange={(unit) => set({ ...form, unit })} />
          </div>
          <p className="adm-kit-sub" data-testid="base-note">
            {baseNote}
          </p>
          {unverified ? (
            <p className="callout warning" role="status" data-testid="unverified-note">
              {t('pwf.bands.unverified.hint')}
            </p>
          ) : null}
        </SectionCard>
        <StateBoundary state={effective.isLoading ? 'loading' : 'default'}>
        <SectionCard title={t('fix9.pwf08.ladder.title')}>
          <LadderFields prefix="" ladder={form.ladder} disabled={!canStore} problems={problems} show={show} onChange={(ladder) => set({ ...form, ladder })} withInfo />
          <Preview thresholds={thresholds} unit={form.unit} preview={preview} />
        </SectionCard>
        <SectionCard title={t('pwf.bands.overrides.title')} status={<span data-testid="override-count">{t('pwf.bands.overrides.count', { count: form.overrides.length })}</span>}>
          <p className="adm-kit-sub">{t('pwf.bands.overrides.hint')}</p>
          <ol className="pwf-tpl-rows" data-testid="overrides">
            {form.overrides.map((override, index) => (
              <li key={index}>
                <OverrideRow index={index} override={override} disabled={!canStore} problems={problems} show={show} onChange={(patch) => set(updateOverride(form, index, patch))} onRemove={() => set(removeOverride(form, index))} />
              </li>
            ))}
          </ol>
          <p className="pwf-actions">
            <button type="button" className="ui-button ui-button--outline" disabled={!canStore || form.overrides.length >= 20} data-action="add-override" onClick={() => set(addOverride(form))}>
              {t('pwf.bands.override.add.action')}
            </button>
          </p>
        </SectionCard>
        <SectionCard title={t('fix9.pwf08.reminders.title')}>
          <div className="pwf-tpl-row">
            <BandField label={t('pwf.bands.reminders.label')} path="reminder_days" hint={t('pwf.bands.reminders.hint')} value={form.reminders} disabled={!canStore} problems={problems} show={show} onChange={(value) => set({ ...form, reminders: value })} />
            <BandField label={t('pwf.bands.escalate.label')} path="escalate_after_overdue_days" hint={t('pwf.bands.escalate.hint')} value={form.escalate} disabled={!canStore} problems={problems} show={show} onChange={(value) => set({ ...form, escalate: value })} />
          </div>
        </SectionCard>
        </StateBoundary>
        {canStore ? (
          <RuleSavePanel ruleType={BAND_RULE_TYPE} code={source} codeValid formOk={problems.length === 0} params={() => paramsOf(form)} onAttempt={() => setAttempted(true)} disabled={false} />
        ) : null}
        <RuleVersionList
          ruleType={BAND_RULE_TYPE}
          code={source}
          canManage={canStore}
          canApprove={canApprove}
          writable={writable}
          editLink={() => `${PATHS.bandPolicy}?code=${source}`}
          diffLink={(id, against) => `${PATHS.ruleDiff}?rule=${id}${against === undefined ? '' : `&against=${against}`}`}
        />
      </StateBoundary>
      <p className="adm-kit-foot" data-testid="footer">
        {t('gova1.footer.reference', { id: route.id, req: route.req ?? '' })}
      </p>
    </section>
  );
}

// ---- fields ------------------------------------------------------------------------------------------------------------------------------------------------------------------

interface BandFieldProps {
  label: string;
  path: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  problems: readonly BandProblem[];
  show: boolean;
  hint?: string | undefined;
  info?: ReactNode;
}

function BandField({ label, path, value, onChange, disabled, problems, show, hint, info }: BandFieldProps) {
  const { t } = useTranslation();
  const id = useId();
  const problem = problems.find((one) => one.path === path);
  const invalid = show && problem !== undefined;
  const describedBy = [invalid ? `${id}-error` : '', hint === undefined ? '' : `${id}-hint`].filter((part) => part !== '').join(' ');
  return (
    <div className="pwf-field">
      <label htmlFor={id}>
        {label} {info}
      </label>
      <input id={id} type="text" inputMode="numeric" autoComplete="off" value={value} disabled={disabled} aria-invalid={invalid} aria-describedby={describedBy === '' ? undefined : describedBy} data-testid={`field-${path}`} onChange={(event) => onChange(event.target.value)} />
      {hint === undefined ? null : (
        <span className="gova1-hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
      {invalid && problem !== undefined ? (
        <span className="pwf-field__error" id={`${id}-error`} data-testid={`error-${path}`}>
          <span aria-hidden="true">⚠ </span>
          {problemWord(t, problem)}
        </span>
      ) : null}
    </div>
  );
}

function SelectUnit({ value, source, disabled, problems, show, onChange }: { value: BandUnit; source: Source; disabled: boolean; problems: readonly BandProblem[]; show: boolean; onChange: (unit: BandUnit) => void }) {
  const { t } = useTranslation();
  const id = useId();
  const problem = problems.find((one) => one.path === 'unit');
  const invalid = show && problem !== undefined;
  return (
    <div className="pwf-field">
      <label htmlFor={id}>{t('fix9.pwf08.unit.label')}</label>
      <select id={id} value={value} disabled={disabled} aria-invalid={invalid} aria-describedby={`${id}-hint`} data-testid="field-unit" onChange={(event) => onChange(event.target.value as BandUnit)}>
        {UNITS.map((unit) => (
          <option key={unit} value={unit}>
            {unitWord(t, unit)}
          </option>
        ))}
      </select>
      <span className="gova1-hint" id={`${id}-hint`}>
        {t('pwf.bands.unit.hint', { source: sourceWord(t, source), unit: unitWord(t, SOURCE_UNIT[source]) })}
      </span>
      {invalid && problem !== undefined ? (
        <span className="pwf-field__error" data-testid="error-unit">
          <span aria-hidden="true">⚠ </span>
          {problemWord(t, problem)}
        </span>
      ) : null}
    </div>
  );
}

interface LadderFieldsProps {
  prefix: string;
  ladder: Ladder;
  disabled: boolean;
  problems: readonly BandProblem[];
  show: boolean;
  onChange: (ladder: Ladder) => void;
  withInfo?: boolean;
}

function LadderFields({ prefix, ladder, disabled, problems, show, onChange, withInfo }: LadderFieldsProps) {
  const { t } = useTranslation();
  const info = (name: string, formula: string): ReactNode =>
    withInfo === true ? <FigureInfo name={name} formula={formula} source={t('pwf.bands.info.source')} asOf={null} version={t('pwf.bands.info.version')} /> : undefined;
  const common = { disabled, problems, show };
  return (
    <div className="pwf-tpl-row">
      <BandField label={t('pwf.bands.green.label')} path={`${prefix}green_days`} hint={t('pwf.bands.green.hint')} value={ladder.green} info={info(t('pwf.bands.green.label'), t('pwf.bands.green.formula'))} onChange={(green) => onChange({ ...ladder, green })} {...common} />
      <BandField label={t('pwf.bands.yellow.label')} path={`${prefix}yellow_days`} hint={t('pwf.bands.yellow.hint')} value={ladder.yellow} info={info(t('pwf.bands.yellow.label'), t('pwf.bands.yellow.formula'))} onChange={(yellow) => onChange({ ...ladder, yellow })} {...common} />
      <BandField label={t('pwf.bands.red.label')} path={`${prefix}red_days`} hint={t('pwf.bands.red.hint')} value={ladder.red} info={info(t('pwf.bands.red.label'), t('pwf.bands.red.formula'))} onChange={(red) => onChange({ ...ladder, red })} {...common} />
    </div>
  );
}

interface OverrideRowProps {
  index: number;
  override: OverrideForm;
  disabled: boolean;
  problems: readonly BandProblem[];
  show: boolean;
  onChange: (patch: Partial<OverrideForm>) => void;
  onRemove: () => void;
}

function OverrideRow({ index, override, disabled, problems, show, onChange, onRemove }: OverrideRowProps) {
  const { t } = useTranslation();
  const prefix = `overrides[${index}].`;
  return (
    <fieldset className="pwf-tpl-sub" data-override={index}>
      <legend>{t('pwf.bands.override.legend', { number: index + 1 })}</legend>
      <div className="pwf-tpl-row">
        <div className="pwf-field">
          <label htmlFor={`pwf-ov-kind-${index}`}>{t('pwf.bands.override.kind.label')}</label>
          <select id={`pwf-ov-kind-${index}`} value={override.task_kind} disabled={disabled} data-testid={`field-${prefix}task_kind`} onChange={(event) => onChange({ task_kind: event.target.value as OverrideForm['task_kind'] })}>
            <option value="">{t('pwf.bands.override.any.option')}</option>
            {TASK_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kindWord(t, kind)}
              </option>
            ))}
          </select>
        </div>
        <div className="pwf-field">
          <label htmlFor={`pwf-ov-priority-${index}`}>{t('pwf.bands.override.priority.label')}</label>
          <select id={`pwf-ov-priority-${index}`} value={override.priority} disabled={disabled} data-testid={`field-${prefix}priority`} onChange={(event) => onChange({ priority: event.target.value as OverrideForm['priority'] })}>
            <option value="">{t('pwf.bands.override.any.option')}</option>
            {PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {priorityWord(t, priority)}
              </option>
            ))}
          </select>
        </div>
        <BandField label={t('pwf.bands.override.phase.label')} path={`${prefix}phase`} hint={t('pwf.bands.override.phase.hint')} value={override.phase} disabled={disabled} problems={problems} show={show} onChange={(phase) => onChange({ phase })} />
      </div>
      <LadderFields prefix={prefix} ladder={override.ladder} disabled={disabled} problems={problems} show={show} onChange={(ladder) => onChange({ ladder })} />
      <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={disabled} data-action={`remove-override-${index}`} onClick={onRemove}>
        {t('pwf.bands.override.remove.action')}
      </button>
    </fieldset>
  );
}

// ---- the preview -----------------------------------------------------------------------------------------------------------------------------------------------------------

function Preview({ thresholds, unit, preview }: { thresholds: Thresholds | undefined; unit: BandUnit; preview: ReturnType<typeof useBandPreview> }) {
  const { t } = useTranslation();
  const loading = preview.isLoading && thresholds !== undefined;
  return (
    <div className="pwf-tpl-sub" data-testid="preview">
      <h3>{t('pwf.bands.preview.title')}</h3>
      <p className="pwf-hint" data-testid="preview-pattern">
        {t('fix9.pwf08.preview.pattern')}
      </p>
      {thresholds !== undefined && thresholds.green_days === OWNER_EXAMPLE.green_days && thresholds.yellow_days === OWNER_EXAMPLE.yellow_days && thresholds.red_days === OWNER_EXAMPLE.red_days ? null : (
        <p className="pwf-band-sentence" data-testid="owner-example">
          <StatusPill tone="info" icon="ⓘ">
            {t('pwf.bands.preview.owner.label')}
          </StatusPill>{' '}
          {sentenceText(t, OWNER_EXAMPLE, unit)}
        </p>
      )}
      {thresholds === undefined ? (
        <p className="callout warning" role="status" data-testid="preview-blocked">
          <span aria-hidden="true">⚠ </span>
          {t('pwf.bands.preview.blocked.text')}
        </p>
      ) : (
        <>
          <p className="pwf-band-sentence" data-testid="sentence">
            {sentenceText(t, thresholds, unit)}
          </p>
          {preview.error === null || preview.error === undefined ? null : <ProblemBanner problem={describeProblem(preview.error)} />}
          <StateBoundary state={loading ? 'loading' : 'default'}>
            {preview.data === undefined ? null : (
              <ul className="pwf-tpl-findings" data-testid="examples" aria-label={t('pwf.bands.preview.examples.label')}>
                {preview.data.examples.map((example) => (
                  <li key={example.remaining_days} data-days={example.remaining_days}>
                    <BandBadge band={{ band: example.band, remaining_days: example.remaining_days, unit: preview.data?.unit ?? unit, overdue: example.remaining_days < 0 }} />
                  </li>
                ))}
              </ul>
            )}
          </StateBoundary>
          {preview.data === undefined ? null : (
            <p className="adm-kit-sub">
              <span className="pwf-figure">
                <span>{t('pwf.bands.preview.thresholds.text', { green: preview.data.thresholds.green_days === null ? t('pwf.bands.preview.noGreen.text') : preview.data.thresholds.green_days, yellow: preview.data.thresholds.yellow_days, red: preview.data.thresholds.red_days })}</span>
                <FigureInfo name={t('pwf.bands.preview.title')} formula={t('pwf.bands.preview.formula')} source={t('pwf.bands.info.source')} asOf={preview.data.as_of} version={t('pwf.bands.info.version')} />
              </span>
            </p>
          )}
        </>
      )}
    </div>
  );
}
