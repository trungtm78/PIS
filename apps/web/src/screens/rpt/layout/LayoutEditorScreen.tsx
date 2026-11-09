import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { ContextBar, SectionCard } from '../../../ui';
import { useCreateDraft, useEffective } from '../../adm/governance/hooks';
import { GridIssues, PreviewTable, refusalText } from '../components';
import { kindWord, statusWord } from '../model';
import '../rpt.css';
import './layout.css';
import { usePreviewLayout } from './hooks';
import type { LayoutPreview } from './hooks';
import { BASES, COLUMN_KEYS, KINDS, LIMITS, PERIOD_KIND_LIST, RULE_TYPE, SCALES, SIGNATURES, draftProblem, emptyState, fromParams, moveItem, problemOf, quickProblem, toParams } from './model';
import type { ColumnKey, EditorState, Signature } from './model';

/** How long the form waits after the last keystroke before it asks for a new preview. */
const PREVIEW_DELAY_MS = 600;
const todayOf = (): string => new Date().toISOString().slice(0, 10);

/**
 * RPT-08, the editor of a report layout (ENT-4b, R23, requirement BC.01): the user picks indicators, the columns of the project table, project groups, their order and their titles from closed lists, and sees the
 * form at once with invented, labelled data. There is no free design of cells. "Save" writes a draft version of the rule `REPORT_LAYOUT`; submitting and approving it (by other people) is done on RPT-07.
 */
export default function LayoutEditorScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <EditorContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function Move<T>({ list, index, set, testId }: { list: T[]; index: number; set: (next: T[]) => void; testId: string }) {
  const { t } = useTranslation();
  return (
    <span className="rpt-lay__move">
      <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('rpt.layout.move.up')} disabled={index === 0} data-testid={`${testId}-up`} onClick={() => set(moveItem(list, index, -1))}>
        ↑
      </button>
      <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('rpt.layout.move.down')} disabled={index === list.length - 1} data-testid={`${testId}-down`} onClick={() => set(moveItem(list, index, 1))}>
        ↓
      </button>
      <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('rpt.layout.remove')} data-testid={`${testId}-remove`} onClick={() => set(list.filter((_, at) => at !== index))}>
        ×
      </button>
    </span>
  );
}

function EditorContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const startCode = search.get('code') ?? undefined;
  const today = todayOf();
  const [state, setState] = useState<EditorState>(() => emptyState(today));
  const [loaded, setLoaded] = useState(startCode === undefined);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [shown, setShown] = useState<LayoutPreview | undefined>(undefined);
  const effective = useEffective(RULE_TYPE, startCode, undefined, startCode !== undefined);
  const preview = usePreviewLayout();
  const create = useCreateDraft();
  const latest = useRef(preview);
  latest.current = preview;

  // A new version starts from the version in force of the code it was opened for (once).
  useEffect(() => {
    if (loaded || effective.data === undefined || startCode === undefined) return;
    if (effective.data !== null) setState(fromParams(startCode, effective.data.params, today));
    setLoaded(true);
  }, [effective.data, loaded, startCode, today]);

  const set = (change: Partial<EditorState>): void => {
    setSaveError(undefined);
    setState((current) => ({ ...current, ...change }));
  };

  // The preview follows the form: after a pause in typing, when the form is plainly complete enough to be asked about.
  const params = toParams(state);
  const paramsKey = JSON.stringify(params);
  const complete = quickProblem(state) === undefined;
  useEffect(() => {
    if (!loaded || !complete) return undefined;
    const timer = setTimeout(() => latest.current.mutate({ params: JSON.parse(paramsKey) as Record<string, unknown> }, { onSuccess: (result) => setShown(result) }), PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [paramsKey, loaded, complete]);

  const problem = draftProblem(state, today);
  const field = shown !== undefined && !shown.valid ? problemOf(shown.problem) : quickProblem(state);
  const save = (): void => {
    if (problem !== undefined) {
      setSaveError(t(`rpt.layout.problem.${statusWord(problemOf(problem))}`));
      return;
    }
    create.mutate(
      { ruleType: RULE_TYPE, code: state.code, unitId: undefined, params, effectiveFrom: state.effectiveFrom, effectiveTo: undefined, reason: state.reason.trim() },
      { onSuccess: () => navigate(`/rpt/rpt-07?code=${state.code}`), onError: (failure) => setSaveError(refusalText(t, failure)) },
    );
  };

  const indicatorsFull = state.indicators.length >= LIMITS.indicators;
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('rpt.layout.edit.title')}</h1>
          <p>{t('rpt.layout.edit.subtitle')}</p>
        </div>
      </div>
      <ContextBar items={[{ label: t('rpt.layout.context.scope'), value: tenant?.name ?? '–' }]} />
      <div className="rpt-lay">
        <div className="rpt-lay__form">
          <SectionCard title={t('rpt.layout.section.form')}>
            <label>
              {t('rpt.layout.field.code')}
              <input type="text" maxLength={39} value={state.code} data-testid="field-code" readOnly={startCode !== undefined} onChange={(event) => set({ code: event.target.value.toUpperCase().trim() })} />
            </label>
            <label>
              {t('rpt.layout.field.kind')}
              <select value={state.kind} data-testid="field-kind" onChange={(event) => set({ kind: event.target.value as EditorState['kind'], receiver: event.target.value === 'INTERNAL' ? 'INTERNAL' : '' })}>
                {KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {t(`rpt.layout.kind.${statusWord(kind)}`)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('rpt.layout.field.title')}
              <input type="text" maxLength={200} value={state.title} data-testid="field-title" onChange={(event) => set({ title: event.target.value })} />
            </label>
            <label>
              {t('rpt.layout.field.subtitle')}
              <input type="text" maxLength={200} value={state.subtitle} data-testid="field-subtitle" onChange={(event) => set({ subtitle: event.target.value })} />
            </label>
            <label>
              {t('rpt.layout.field.period')}
              <select value={state.periodKind} data-testid="field-period" onChange={(event) => set({ periodKind: event.target.value as EditorState['periodKind'] })}>
                {PERIOD_KIND_LIST.map((kind) => (
                  <option key={kind} value={kind}>
                    {t(`rpt.common.kind.${kindWord(kind)}`)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('rpt.layout.field.scale')}
              <select value={state.moneyScale} data-testid="field-scale" onChange={(event) => set({ moneyScale: event.target.value as EditorState['moneyScale'] })}>
                {SCALES.map((scale) => (
                  <option key={scale} value={scale}>
                    {t(`rpt.layout.scale.${statusWord(scale)}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="rpt-lay__check">
              <input type="checkbox" checked={state.demo} data-testid="field-demo" onChange={(event) => set({ demo: event.target.checked })} />
              {t('rpt.layout.field.demo')}
            </label>
            <p className="callout" role="note">
              {t('rpt.layout.field.demo.hint')}
            </p>
          </SectionCard>

          {state.kind === 'AGENCY_REQUEST' ? (
            <SectionCard title={t('rpt.layout.section.agency')}>
              <label>
                {t('rpt.layout.field.agency')}
                <input type="text" maxLength={200} value={state.agencyName} data-testid="field-agency" onChange={(event) => set({ agencyName: event.target.value })} />
              </label>
              <label>
                {t('rpt.layout.field.request')}
                <input type="text" maxLength={200} value={state.requestRef} data-testid="field-request" onChange={(event) => set({ requestRef: event.target.value })} />
              </label>
              <label>
                {t('rpt.layout.field.receiver')}
                <input type="text" maxLength={60} value={state.receiver} data-testid="field-receiver" onChange={(event) => set({ receiver: event.target.value.trim() })} />
              </label>
              <p className="callout" role="note">
                {t('rpt.layout.field.receiver.hint')}
              </p>
            </SectionCard>
          ) : null}

          <SectionCard title={t('rpt.layout.section.indicators')}>
            <ol className="rpt-lay__list" data-testid="indicators">
              {state.indicators.map((one, index) => (
                <li key={index} data-testid={`indicator-${index}`}>
                  <input type="text" aria-label={t('rpt.layout.indicator.code')} placeholder={t('rpt.layout.indicator.code')} maxLength={64} value={one.code} data-testid={`indicator-${index}-code`} onChange={(event) => set({ indicators: state.indicators.map((row, at) => (at === index ? { ...row, code: event.target.value.toUpperCase().trim() } : row)) })} />
                  <input type="text" aria-label={t('rpt.layout.indicator.title')} placeholder={t('rpt.layout.indicator.title')} maxLength={200} value={one.title} data-testid={`indicator-${index}-title`} onChange={(event) => set({ indicators: state.indicators.map((row, at) => (at === index ? { ...row, title: event.target.value } : row)) })} />
                  <select aria-label={t('rpt.layout.indicator.basis')} value={one.basis} data-testid={`indicator-${index}-basis`} onChange={(event) => set({ indicators: state.indicators.map((row, at) => (at === index ? { ...row, basis: event.target.value } : row)) })}>
                    {BASES.map((basis) => (
                      <option key={basis} value={basis}>
                        {basis === '' ? t('rpt.layout.basis.default') : t(`rpt.layout.basis.${statusWord(basis)}`)}
                      </option>
                    ))}
                  </select>
                  <Move list={state.indicators} index={index} set={(next) => set({ indicators: next })} testId={`indicator-${index}`} />
                </li>
              ))}
            </ol>
            <button type="button" className="ui-button ui-button--outline" disabled={indicatorsFull} data-testid="indicator-add" onClick={() => set({ indicators: [...state.indicators, { code: '', title: '', basis: '' }] })}>
              {t('rpt.layout.indicator.add')}
            </button>
          </SectionCard>

          <SectionCard title={t('rpt.layout.section.groups')}>
            <ol className="rpt-lay__list" data-testid="groups">
              {state.groups.map((one, index) => (
                <li key={index} data-testid={`group-${index}`}>
                  <input type="text" aria-label={t('rpt.layout.group.key')} placeholder={t('rpt.layout.group.key')} maxLength={24} value={one.key} data-testid={`group-${index}-key`} onChange={(event) => set({ groups: state.groups.map((row, at) => (at === index ? { ...row, key: event.target.value.toLowerCase().trim() } : row)) })} />
                  <input type="text" aria-label={t('rpt.layout.group.title')} placeholder={t('rpt.layout.group.title')} maxLength={200} value={one.title} data-testid={`group-${index}-title`} onChange={(event) => set({ groups: state.groups.map((row, at) => (at === index ? { ...row, title: event.target.value } : row)) })} />
                  <Move list={state.groups} index={index} set={(next) => set({ groups: next })} testId={`group-${index}`} />
                </li>
              ))}
            </ol>
            <button type="button" className="ui-button ui-button--outline" disabled={state.groups.length >= LIMITS.groups} data-testid="group-add" onClick={() => set({ groups: [...state.groups, { key: `group_${state.groups.length + 1}`, title: '' }], columns: state.columns.length === 0 ? [{ key: 'project_code', title: '' }, { key: 'project_name', title: '' }] : state.columns })}>
              {t('rpt.layout.group.add')}
            </button>
          </SectionCard>

          {state.groups.length > 0 ? (
            <SectionCard title={t('rpt.layout.section.columns')}>
              <ol className="rpt-lay__list" data-testid="columns">
                {state.columns.map((one, index) => (
                  <li key={one.key} data-testid={`column-${index}`}>
                    <strong>{t(`rpt.layout.column.${statusWord(one.key)}`)}</strong>
                    <input type="text" aria-label={t('rpt.layout.column.title')} placeholder={t('rpt.layout.column.title')} maxLength={120} value={one.title} data-testid={`column-${index}-title`} onChange={(event) => set({ columns: state.columns.map((row, at) => (at === index ? { ...row, title: event.target.value } : row)) })} />
                    <Move list={state.columns} index={index} set={(next) => set({ columns: next })} testId={`column-${index}`} />
                  </li>
                ))}
              </ol>
              <label>
                {t('rpt.layout.column.add')}
                <select value="" data-testid="column-add" onChange={(event) => event.target.value !== '' && set({ columns: [...state.columns, { key: event.target.value as ColumnKey, title: '' }] })}>
                  <option value="">{t('rpt.layout.column.choose')}</option>
                  {COLUMN_KEYS.filter((key) => !state.columns.some((row) => row.key === key)).map((key) => (
                    <option key={key} value={key}>
                      {t(`rpt.layout.column.${statusWord(key)}`)}
                    </option>
                  ))}
                </select>
              </label>
            </SectionCard>
          ) : null}

          <SectionCard title={t('rpt.layout.section.finish')}>
            <label className="rpt-lay__check">
              <input type="checkbox" checked={state.totals} data-testid="field-totals" onChange={(event) => set({ totals: event.target.checked })} />
              {t('rpt.layout.field.totals')}
            </label>
            <fieldset>
              <legend>{t('rpt.layout.field.signatures')}</legend>
              {SIGNATURES.map((role) => (
                <label key={role} className="rpt-lay__check">
                  <input type="checkbox" checked={state.signatures.includes(role)} data-testid={`sign-${role.toLowerCase()}`} onChange={(event) => set({ signatures: SIGNATURES.filter((one: Signature) => (one === role ? event.target.checked : state.signatures.includes(one))) })} />
                  {t(`rpt.layout.sign.${role.toLowerCase()}`)}
                </label>
              ))}
            </fieldset>
            <label>
              {t('rpt.layout.field.note')}
              <textarea maxLength={500} value={state.note} data-testid="field-note" onChange={(event) => set({ note: event.target.value })} />
            </label>
            <label>
              {t('rpt.layout.field.provider')}
              <input type="text" maxLength={40} value={state.provider} data-testid="field-provider" onChange={(event) => set({ provider: event.target.value.toUpperCase().trim() })} />
            </label>
          </SectionCard>

          <SectionCard title={t('rpt.layout.section.save')}>
            <label>
              {t('rpt.layout.field.from')}
              <input type="date" min={today} value={state.effectiveFrom} data-testid="field-from" onChange={(event) => set({ effectiveFrom: event.target.value })} />
            </label>
            <label>
              {t('rpt.layout.field.reason')}
              <textarea maxLength={500} value={state.reason} data-testid="field-reason" onChange={(event) => set({ reason: event.target.value })} />
            </label>
            {saveError === undefined ? null : (
              <p className="callout warning" role="alert" data-testid="save-error">
                {saveError}
              </p>
            )}
            <button type="button" className="ui-button" disabled={create.isPending} data-testid="save" onClick={save}>
              {t('rpt.layout.save')}
            </button>
            <p className="callout" role="note">
              {t('rpt.layout.save.hint')}
            </p>
          </SectionCard>
        </div>

        <aside className="rpt-lay__preview" aria-label={t('rpt.layout.preview.title')} data-testid="preview">
          <h2>{t('rpt.layout.preview.title')}</h2>
          <p className="callout" role="note">
            {t('rpt.layout.preview.hint')}
          </p>
          {field !== undefined && field !== null ? (
            <p className="callout warning" role="alert" data-testid="preview-problem">
              {t('rpt.layout.preview.problem', { field: t(`rpt.layout.problem.${statusWord(problemOf(field))}`) })}
            </p>
          ) : null}
          {preview.isPending ? <p role="status">{t('rpt.layout.preview.loading')}</p> : null}
          {shown?.valid === true && shown.preview !== null ? (
            <>
              <p data-testid="preview-name">
                <strong>{shown.form_name}</strong>
              </p>
              <PreviewTable preview={shown.preview} />
              {shown.datasets.length > 0 ? <p className="rpt-lay__datasets">{t('rpt.layout.preview.datasets', { names: shown.datasets.join(', ') })}</p> : null}
              {shown.issues.length > 0 ? <GridIssues issues={shown.issues} /> : null}
            </>
          ) : null}
        </aside>
      </div>
      <p className="prototype-note">{t('rpt.common.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
