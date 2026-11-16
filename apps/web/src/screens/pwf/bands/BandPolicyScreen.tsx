import { useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { SectionCard } from '../../../ui';
import { useEffective } from '../../adm/governance/hooks';
import { KitTable } from '../../adm/KitTable';
import { BandBadge, FigureInfo, ProblemBanner, UnverifiedLabel } from '../components';
import { priorityWord, kindWord, unitWord } from '../labels';
import { BAND_RULE_TYPE, PATHS, PERMISSIONS, RULE_PERMISSIONS, describeProblem, holds } from '../model';
import { RuleSavePanel, RuleVersionList } from '../templates/store';
import { MAX_OVERRIDES, PRIORITIES, SOURCES, SOURCE_UNIT, TASK_KINDS, addOverride, blankForm, formOf, paramsOf, problemsOf, removeOverride, thresholdsOf, updateOverride, withSourceUnit } from './band-model';
import type { BandForm, BandProblem, Ladder, OverrideForm, Source } from './band-model';
import { StepBands, useStepBands } from './StepBands';
import { useBandPreview } from './hooks';
import { ladderSentence } from './sentence';
import '../pwf.css';
import '../templates/templates.css';
import './bands.css';

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
    case 'phase':
      return t('pwf.bands.problem.phase.error');
    case 'listSize':
      return t('pwf.bands.problem.listSize.error', { max: problem.max ?? 0 });
    case 'reminderOrder':
      return t('pwf.bands.problem.reminderOrder.error');
  }
}

/**
 * PWF-08, "Ngưỡng mặc định": one short table of the numbers that turn a deadline red, yellow and green (the default and the exceptions by kind of task, priority and phase), the unit said once, the sentence the numbers make, the reminder
 * days and the escalation, and, read-only, the steps of the templates that carry thresholds of their own (R59). A draft goes into the rule store and a different person approves it.
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
  const stepBands = useStepBands(mayRead && source === 'PROJECT_TASK');
  const [edited, setEdited] = useState<BandForm | undefined>(undefined);
  const [attempted, setAttempted] = useState(false);
  const base = useMemo(() => (effective.data === null || effective.data === undefined ? blankForm(SOURCE_UNIT[source]) : formOf(effective.data.params)), [effective.data, source]);
  const form = withSourceUnit(edited ?? base, source);
  const problems = useMemo(() => problemsOf(form), [form]);
  const show = attempted || edited !== undefined;
  const thresholds = thresholdsOf(form);
  const preview = useBandPreview(thresholds, form.unit, mayRead);
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
          <h1 id="screen-title">{t('wfxbands.title.text')}</h1>
          <p>{t('wfxbands.subtitle.text')}</p>
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
        <SectionCard title={t('wfxbands.table.title')} status={unverified ? <UnverifiedLabel /> : undefined}>
          <div className="pwf-band-toolbar">
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
            </div>
            <p className="pwf-band-unit" data-testid="unit-declared">
              {t('wfxbands.unit.declared.text', { unit: unitWord(t, form.unit) })}
            </p>
          </div>
          <p className="adm-kit-sub" data-testid="base-note">
            {baseNote}
          </p>
          {unverified ? (
            <p className="callout warning" role="status" data-testid="unverified-note">
              {t('pwf.bands.unverified.hint')}
            </p>
          ) : null}
          <StateBoundary state={effective.isLoading ? 'loading' : 'default'}>
            <LadderTable form={form} disabled={!canStore} problems={problems} show={show} onChange={set} />
            <p className="pwf-actions">
              <button type="button" className="ui-button ui-button--outline" disabled={!canStore || form.overrides.length >= MAX_OVERRIDES} data-action="add-override" onClick={() => set(addOverride(form))}>
                {t('wfxbands.exception.add.action')}
              </button>{' '}
              <span className="adm-kit-sub" data-testid="override-count">
                {t('wfxbands.exception.count', { count: form.overrides.length })}
              </span>
            </p>
            <dl className="pwf-band-reading">
              <dt>{t('wfxbands.col.red.label')}</dt>
              <dd>{t('pwf.bands.red.hint')}</dd>
              <dt>{t('wfxbands.col.yellow.label')}</dt>
              <dd>{t('pwf.bands.yellow.hint')}</dd>
              <dt>{t('wfxbands.col.green.label')}</dt>
              <dd>{t('pwf.bands.green.hint')}</dd>
            </dl>
            <p className="adm-kit-sub">{t('wfxbands.exception.hint')}</p>
            <Preview form={form} preview={preview} />
          </StateBoundary>
        </SectionCard>
        <StateBoundary state={effective.isLoading ? 'loading' : 'default'}>
          <SectionCard title={t('fix9.pwf08.reminders.title')}>
            <div className="pwf-tpl-row">
              <BandField label={t('pwf.bands.reminders.label')} path="reminder_days" hint={t('pwf.bands.reminders.hint')} value={form.reminders} disabled={!canStore} problems={problems} show={show} onChange={(value) => set({ ...form, reminders: value })} />
              <BandField label={t('pwf.bands.escalate.label')} path="escalate_after_overdue_days" hint={t('pwf.bands.escalate.hint')} value={form.escalate} disabled={!canStore} problems={problems} show={show} onChange={(value) => set({ ...form, escalate: value })} />
            </div>
          </SectionCard>
        </StateBoundary>
        {canStore ? <RuleSavePanel ruleType={BAND_RULE_TYPE} code={source} codeValid formOk={problems.length === 0} params={() => paramsOf(form)} onAttempt={() => setAttempted(true)} disabled={false} /> : null}
        {source === 'PROJECT_TASK' ? <StepBands rows={stepBands.rows} loading={stepBands.loading} failed={stepBands.failed} /> : null}
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
}

function BandField({ label, path, value, onChange, disabled, problems, show, hint }: BandFieldProps) {
  const { t } = useTranslation();
  const id = useId();
  const problem = problems.find((one) => one.path === path);
  const invalid = show && problem !== undefined;
  const describedBy = [invalid ? `${id}-error` : '', hint === undefined ? '' : `${id}-hint`].filter((part) => part !== '').join(' ');
  return (
    <div className="pwf-field">
      <label htmlFor={id}>{label}</label>
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

interface NumberCellProps {
  path: string;
  label: string;
  value: string;
  disabled: boolean;
  problems: readonly BandProblem[];
  show: boolean;
  onChange: (value: string) => void;
}

/** One of the three numbers of a row: a labelled box in a table cell, its problem said under it. */
function NumberCell({ path, label, value, disabled, problems, show, onChange }: NumberCellProps) {
  const { t } = useTranslation();
  const id = useId();
  const problem = problems.find((one) => one.path === path);
  const invalid = show && problem !== undefined;
  return (
    <td className="pwf-band-num">
      <label className="ui-sr-only" htmlFor={id}>
        {label}
      </label>
      <input id={id} type="text" inputMode="numeric" autoComplete="off" value={value} disabled={disabled} aria-invalid={invalid} aria-describedby={invalid ? `${id}-error` : undefined} data-testid={`field-${path}`} onChange={(event) => onChange(event.target.value)} />
      {invalid && problem !== undefined ? (
        <span className="pwf-field__error" id={`${id}-error`} data-testid={`error-${path}`}>
          <span aria-hidden="true">⚠ </span>
          {problemWord(t, problem)}
        </span>
      ) : null}
    </td>
  );
}

interface LadderTableProps {
  form: BandForm;
  disabled: boolean;
  problems: readonly BandProblem[];
  show: boolean;
  onChange: (next: BandForm) => void;
}

/** Red, yellow and green for the default and for each exception: three numbers on every row, the column heads carry the "i" of the formula. */
function LadderTable({ form, disabled, problems, show, onChange }: LadderTableProps) {
  const { t } = useTranslation();
  const info = (name: string, formula: string): ReactNode => <FigureInfo name={name} formula={formula} source={t('pwf.bands.info.source')} asOf={null} version={t('pwf.bands.info.version')} />;
  const cells = (prefix: string, ladder: Ladder, row: string, change: (next: Ladder) => void): ReactNode => (
    <>
      <NumberCell path={`${prefix}red_days`} label={t('wfxbands.cell.red.label', { row })} value={ladder.red} disabled={disabled} problems={problems} show={show} onChange={(red) => change({ ...ladder, red })} />
      <NumberCell path={`${prefix}yellow_days`} label={t('wfxbands.cell.yellow.label', { row })} value={ladder.yellow} disabled={disabled} problems={problems} show={show} onChange={(yellow) => change({ ...ladder, yellow })} />
      <NumberCell path={`${prefix}green_days`} label={t('wfxbands.cell.green.label', { row })} value={ladder.green} disabled={disabled} problems={problems} show={show} onChange={(green) => change({ ...ladder, green })} />
    </>
  );
  return (
    <KitTable caption={t('wfxbands.table.caption')} testId="ladder-table">
      <thead>
        <tr>
          <th>{t('wfxbands.col.scope.label')}</th>
          <th className="pwf-band-num pwf-band-head--red">
            {t('wfxbands.col.red.label')} {info(t('wfxbands.col.red.label'), t('pwf.bands.red.formula'))}
          </th>
          <th className="pwf-band-num pwf-band-head--yellow">
            {t('wfxbands.col.yellow.label')} {info(t('wfxbands.col.yellow.label'), t('pwf.bands.yellow.formula'))}
          </th>
          <th className="pwf-band-num pwf-band-head--green">
            {t('wfxbands.col.green.label')} {info(t('wfxbands.col.green.label'), t('pwf.bands.green.formula'))}
          </th>
          <th>
            <span className="ui-sr-only">{t('wfxbands.col.actions.label')}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr data-row="default">
          <th scope="row" className="pwf-band-scope">
            <strong>{t('wfxbands.row.default.label')}</strong>
            <span className="adm-kit-sub">{t('wfxbands.row.default.hint')}</span>
          </th>
          {cells('', form.ladder, t('wfxbands.row.default.name'), (ladder) => onChange({ ...form, ladder }))}
          <td />
        </tr>
        {form.overrides.map((override, index) => (
          <OverrideRow key={index} index={index} override={override} disabled={disabled} problems={problems} show={show} onChange={(patch) => onChange(updateOverride(form, index, patch))} onRemove={() => onChange(removeOverride(form, index))} cells={cells} />
        ))}
      </tbody>
    </KitTable>
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
  cells: (prefix: string, ladder: Ladder, row: string, change: (next: Ladder) => void) => ReactNode;
}

function OverrideRow({ index, override, disabled, problems, show, onChange, onRemove, cells }: OverrideRowProps) {
  const { t } = useTranslation();
  const prefix = `overrides[${index}].`;
  const row = t('wfxbands.row.exception.name', { number: index + 1 });
  const phaseProblem = problems.find((one) => one.path === `${prefix}phase`);
  const phaseInvalid = show && phaseProblem !== undefined;
  return (
    <tr data-override={index}>
      <th scope="row" className="pwf-band-scope">
        <strong>{t('wfxbands.row.exception.label', { number: index + 1 })}</strong>
        <span className="pwf-band-scope__fields">
          <span className="pwf-band-scope__field">
            <label htmlFor={`pwf-ov-kind-${index}`}>{t('pwf.bands.override.kind.label')}</label>
            <select id={`pwf-ov-kind-${index}`} value={override.task_kind} disabled={disabled} data-testid={`field-${prefix}task_kind`} onChange={(event) => onChange({ task_kind: event.target.value as OverrideForm['task_kind'] })}>
              <option value="">{t('pwf.bands.override.any.option')}</option>
              {TASK_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kindWord(t, kind)}
                </option>
              ))}
            </select>
          </span>
          <span className="pwf-band-scope__field">
            <label htmlFor={`pwf-ov-priority-${index}`}>{t('pwf.bands.override.priority.label')}</label>
            <select id={`pwf-ov-priority-${index}`} value={override.priority} disabled={disabled} data-testid={`field-${prefix}priority`} onChange={(event) => onChange({ priority: event.target.value as OverrideForm['priority'] })}>
              <option value="">{t('pwf.bands.override.any.option')}</option>
              {PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {priorityWord(t, priority)}
                </option>
              ))}
            </select>
          </span>
          <span className="pwf-band-scope__field">
            <label htmlFor={`pwf-ov-phase-${index}`}>{t('pwf.bands.override.phase.label')}</label>
            <input id={`pwf-ov-phase-${index}`} type="text" autoComplete="off" value={override.phase} disabled={disabled} placeholder={t('pwf.bands.override.any.option')} aria-invalid={phaseInvalid} data-testid={`field-${prefix}phase`} onChange={(event) => onChange({ phase: event.target.value })} />
            {phaseInvalid && phaseProblem !== undefined ? (
              <span className="pwf-field__error" data-testid={`error-${prefix}phase`}>
                <span aria-hidden="true">⚠ </span>
                {problemWord(t, phaseProblem)}
              </span>
            ) : null}
          </span>
        </span>
      </th>
      {cells(prefix, override.ladder, row, (ladder) => onChange({ ladder }))}
      <td>
        <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={disabled} data-action={`remove-override-${index}`} aria-label={t('wfxbands.exception.remove.label', { number: index + 1 })} onClick={onRemove}>
          {t('wfxbands.exception.remove.action')}
        </button>
      </td>
    </tr>
  );
}

// ---- the preview -----------------------------------------------------------------------------------------------------------------------------------------------------------

/** The sentence the default numbers make, and what the server says each number of days left turns into. */
function Preview({ form, preview }: { form: BandForm; preview: ReturnType<typeof useBandPreview> }) {
  const { t } = useTranslation();
  const thresholds = thresholdsOf(form);
  const loading = preview.isLoading && thresholds !== undefined;
  return (
    <div className="pwf-tpl-sub" data-testid="preview">
      <h3>{t('pwf.bands.preview.title')}</h3>
      {thresholds === undefined ? (
        <p className="callout warning" role="status" data-testid="preview-blocked">
          <span aria-hidden="true">⚠ </span>
          {t('pwf.bands.preview.blocked.text')}
        </p>
      ) : (
        <>
          <p className="pwf-band-sentence" data-testid="sentence">
            {ladderSentence(t, thresholds)}
          </p>
          {preview.error === null || preview.error === undefined ? null : <ProblemBanner problem={describeProblem(preview.error)} />}
          <StateBoundary state={loading ? 'loading' : 'default'}>
            {preview.data === undefined ? null : (
              <ul className="pwf-tpl-findings" data-testid="examples" aria-label={t('pwf.bands.preview.examples.label')}>
                {preview.data.examples.map((example) => (
                  <li key={example.remaining_days} data-days={example.remaining_days}>
                    <BandBadge band={{ band: example.band, remaining_days: example.remaining_days, unit: preview.data?.unit ?? form.unit, overdue: example.remaining_days < 0 }} />
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
