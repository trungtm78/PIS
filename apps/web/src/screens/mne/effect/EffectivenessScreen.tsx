import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { AuditLine, ContextBar, DataTable, MakerCheckerBadge, SectionCard, StatusPill } from '../../../ui';
import { dayText, idFrom } from '../../gov3/model';
import { useProjects } from '../../prj/hooks';
import { BandPill, DefinitionInfo, RuleInfo, UnverifiedPill } from './components';
import { AssessDialog, CalendarDialog, DecideDialog, DraftDialog, FixDialog, MeasureDialog, calendarResultLines } from './dialogs';
import { useEffectiveness } from './hooks';
import { STATE_GLYPH, anchorText, assessmentStatusText, assessmentStatusTone, conclusionText, conclusionTone, DIRECTION_GLYPH, directionText, kindText, naText, stateText, stateTone } from './labels';
import { calendarByDue, measurementsNewestFirst, naReason, personName } from './model';
import type { Assessment, CalendarEntry, CalendarResult, EffectView, FrozenLine, Indicator, Measurement, TargetSet } from './model';
import './effect.css';

type Modal =
  | { kind: 'draft' }
  | { kind: 'fix'; set: TargetSet }
  | { kind: 'measure'; correcting?: Measurement }
  | { kind: 'calendar' }
  | { kind: 'assess' }
  | { kind: 'decide'; assessment: Assessment; decision: 'APPROVE' | 'RETURN' };

/**
 * MNE-11: the effectiveness of a project after the investment (MR-1, MR.03, Articles 76 and 77). The target indicators stand FIXED once one person drafts them and another fixes them; the actual values are measured after the
 * commissioning and never overwritten (a correction is a later row); the variance, the achievement and the band come from the server with the rule that gave them; the evaluation calendar and the assessments follow, and an
 * assessment is decided by someone other than the one who submitted it. A figure the server could not know says why and is never written as zero.
 */
export default function EffectivenessScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const [params] = useSearchParams();
  // The address decides the project: a move to another one starts the screen over, so no dialog or notice of one project reaches another.
  return <EffectContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}:${params.get('id') ?? ''}`} route={route} />;
}

function EffectContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, mode } = useSession();
  const [params, setParams] = useSearchParams();
  const projectId = idFrom(params.get('id'));
  const projects = useProjects();
  const effect = useEffectiveness(projectId);
  const state = useScreenState({ isLoading: effect.isLoading, error: effect.error, data: effect.data, isEmpty: () => false });
  const view = effect.data ?? undefined;
  const writable = mode !== 'READ_ONLY';
  const [modal, setModal] = useState<Modal | undefined>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [calendarResult, setCalendarResult] = useState<CalendarResult | undefined>(undefined);
  const choose = (id: string): void => setParams(id === '' ? {} : { id });
  const close = (): void => setModal(undefined);
  const may = view !== undefined && writable ? view.can : undefined;
  const anyAction = may !== undefined && (may.draft || may.fix || may.measure || may.generateCalendar || may.assess || may.decide);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('mr1.effect.title')}</h1>
          <p>{t('mr1.effect.subtitle')}</p>
        </div>
      </div>
      <ContextBar
        items={[
          { label: t('mr1.effect.ctx.scope'), value: tenant?.name ?? t('mr1.effect.ctx.scope.all') },
          ...(view === undefined ? [] : [{ label: t('mr1.effect.ctx.project'), value: view.project.code }, { label: t('mr1.effect.ctx.status'), value: view.project.status }]),
        ]}
        {...(view === undefined ? {} : { asOf: dayText(view.asOf) })}
      />
      <div className="eff-picker">
        <label htmlFor="effect-project">{t('mr1.effect.picker.label')}</label>
        <select id="effect-project" value={projectId ?? ''} data-testid="project-picker" onChange={(event) => choose(event.target.value)}>
          <option value="">{t('mr1.effect.picker.none')}</option>
          {(projects.data ?? []).map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.code} {candidate.name}
            </option>
          ))}
        </select>
      </div>
      {projectId === undefined ? (
        <p className="callout" role="status" data-testid="no-project">
          {t('mr1.effect.noProject')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void effect.refetch()}>
          {effect.data === null ? (
            <p className="callout warning" role="alert" data-testid="project-missing">
              {t('mr1.effect.project.missing')}
            </p>
          ) : view === undefined ? null : (
            <>
              {message === undefined ? null : (
                <p className="callout" role="status" data-testid="message">
                  {message}
                </p>
              )}
              {calendarResult === undefined ? null : (
                <div className="callout" role="status" data-testid="calendar-result">
                  <p>
                    <strong>{t('mr1.effect.calendar.result.title')}</strong>
                  </p>
                  <ul>
                    {calendarResultLines(t, calendarResult).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              )}
              {view.policy.unverified ? (
                <p className="callout warning" role="status" data-testid="policy-unverified">
                  {t('mr1.effect.policy.unverified')}
                </p>
              ) : null}
              {writable && anyAction ? (
                <div className="eff-actions" data-testid="actions">
                  {may?.draft ? (
                    <button type="button" className="ui-button ui-button--primary" data-action="draft" onClick={() => setModal({ kind: 'draft' })}>
                      {view.fixed === null ? t('mr1.effect.action.draft') : t('mr1.effect.action.revise')}
                    </button>
                  ) : null}
                  {may?.measure ? (
                    <button type="button" className="ui-button ui-button--outline" data-action="measure" onClick={() => setModal({ kind: 'measure' })}>
                      {t('mr1.effect.action.measure')}
                    </button>
                  ) : null}
                  {may?.generateCalendar ? (
                    <button type="button" className="ui-button ui-button--outline" data-action="calendar" onClick={() => setModal({ kind: 'calendar' })}>
                      {t('mr1.effect.action.calendar')}
                    </button>
                  ) : null}
                  {may?.assess ? (
                    <button type="button" className="ui-button ui-button--outline" data-action="assess" onClick={() => setModal({ kind: 'assess' })}>
                      {t('mr1.effect.action.assess')}
                    </button>
                  ) : null}
                </div>
              ) : (
                <p className="muted" data-testid="read-only">
                  {t('mr1.effect.readonly.notice')}
                </p>
              )}
              <FixedSection view={view} />
              <DraftSection view={view} canFix={may?.fix === true} onFix={(set) => setModal({ kind: 'fix', set })} />
              <SupersededSection view={view} />
              <MeasurementSection view={view} writable={writable} onCorrect={(row) => setModal({ kind: 'measure', correcting: row })} />
              <CalendarSection view={view} />
              <AssessmentSection view={view} canDecide={may?.decide === true} onDecide={(assessment, decision) => setModal({ kind: 'decide', assessment, decision })} />
              {modal?.kind === 'draft' ? <DraftDialog view={view} onClose={close} onDone={setMessage} /> : null}
              {modal?.kind === 'fix' ? <FixDialog view={view} set={modal.set} onClose={close} onDone={setMessage} /> : null}
              {modal?.kind === 'measure' ? <MeasureDialog view={view} {...(modal.correcting === undefined ? {} : { correcting: modal.correcting })} onClose={close} onDone={setMessage} /> : null}
              {modal?.kind === 'calendar' ? <CalendarDialog view={view} onClose={close} onDone={setMessage} onResult={setCalendarResult} /> : null}
              {modal?.kind === 'assess' ? <AssessDialog view={view} onClose={close} onDone={setMessage} /> : null}
              {modal?.kind === 'decide' ? <DecideDialog view={view} assessment={modal.assessment} decision={modal.decision} onClose={close} onDone={setMessage} /> : null}
            </>
          )}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('mr1.effect.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

// ---- the sets of targets --------------------------------------------------------------------------------------------------------

function useValueText(): (value: string | null, unit: string) => string {
  const { t } = useTranslation();
  return (value, unit) => (value === null ? '' : t('mr1.effect.valueUnit', { value, unit }));
}

function IndicatorTable({ view, set, withActual }: { view: EffectView; set: TargetSet; withActual: boolean }) {
  const { t } = useTranslation();
  const valueText = useValueText();
  const policy = view.policy;
  return (
    <DataTable<Indicator>
      caption={withActual ? t('mr1.effect.fixed.table') : t('mr1.effect.draft.table')}
      rows={set.indicators}
      rowKey={(row) => row.id || row.code}
      rowAttrs={(row) => ({ 'data-indicator': row.code, 'data-band': withActual ? row.variance.band : undefined })}
      state={set.indicators.length === 0 ? 'empty' : 'ready'}
      columns={[
        {
          key: 'indicator',
          header: t('mr1.effect.col.indicator'),
          pinned: true,
          render: (row) => (
            <span>
              <code>{row.code}</code>
              <span className="eff-block">{row.name}</span>
            </span>
          ),
        },
        { key: 'direction', header: t('mr1.effect.col.direction'), render: (row) => (
            <span>
              <span aria-hidden="true">{DIRECTION_GLYPH[row.direction]}</span> {directionText(t, row.direction)}
            </span>
          ) },
        {
          key: 'baseline',
          header: t('mr1.effect.col.baseline'),
          align: 'right',
          render: (row) =>
            row.baselineValue === null ? (
              <span className="muted">{t('mr1.effect.baseline.none')}</span>
            ) : (
              <span>
                {valueText(row.baselineValue, row.unit)}
                {row.baselineOn === null ? null : <span className="muted eff-block">{dayText(row.baselineOn)}</span>}
              </span>
            ),
        },
        {
          key: 'target',
          header: t('mr1.effect.col.target'),
          align: 'right',
          render: (row) => (
            <span>
              <strong>{valueText(row.targetValue, row.unit)}</strong>{' '}
              <DefinitionInfo name={t('mr1.effect.info.target', { code: row.code })} formula={row.formula} source={row.dataSource} asOf={set.fixedOn ?? view.asOf} policy={policy} />
              {row.measureAfterMonths === null ? null : <span className="muted eff-block">{t('mr1.effect.measureAfter', { months: row.measureAfterMonths })}</span>}
            </span>
          ),
        },
        ...(withActual
          ? [
              {
                key: 'actual',
                header: t('mr1.effect.col.actual'),
                align: 'right' as const,
                render: (row: Indicator) =>
                  row.actual === null ? (
                    <StatusPill tone="neutral">{t('mr1.effect.actual.none')}</StatusPill>
                  ) : (
                    <span>
                      <strong>{valueText(row.actual.value, row.unit)}</strong>{' '}
                      <DefinitionInfo name={t('mr1.effect.info.actual', { code: row.code })} formula={row.formula} source={row.dataSource} asOf={row.actual.measuredOn} policy={policy} />
                      <span className="muted eff-block">{t('mr1.effect.actual.on', { day: dayText(row.actual.measuredOn) })}</span>
                      <span className="muted eff-block">{row.actual.methodNote}</span>
                    </span>
                  ),
              },
              {
                key: 'variance',
                header: t('mr1.effect.col.variance'),
                align: 'right' as const,
                render: (row: Indicator) => (
                  <span>
                    {row.variance.varianceValue === null ? (
                      <span className="muted">{t('mr1.effect.na.known', { reason: naText(t, naReason(row.variance, 'variance')) })}</span>
                    ) : (
                      <span>
                        {valueText(row.variance.varianceValue, row.unit)}
                        <span className="eff-block">{row.variance.variancePct === null ? t('mr1.effect.na.known', { reason: naText(t, naReason(row.variance, 'variance')) }) : t('mr1.effect.pct', { value: row.variance.variancePct })}</span>
                      </span>
                    )}{' '}
                    <RuleInfo policy={policy} asOf={view.asOf} name={t('mr1.effect.info.variance', { code: row.code })} />
                  </span>
                ),
              },
              {
                key: 'achievement',
                header: t('mr1.effect.col.achievement'),
                align: 'right' as const,
                render: (row: Indicator) => (
                  <span>
                    {row.variance.achievementPct === null ? <span className="muted">{t('mr1.effect.na.known', { reason: naText(t, naReason(row.variance, 'achievement')) })}</span> : <strong>{t('mr1.effect.pct', { value: row.variance.achievementPct })}</strong>}{' '}
                    <RuleInfo policy={policy} asOf={view.asOf} name={t('mr1.effect.info.achievement', { code: row.code })} />
                  </span>
                ),
              },
              {
                key: 'band',
                header: t('mr1.effect.col.band'),
                render: (row: Indicator) => (
                  <span>
                    <BandPill band={row.variance.band} /> <RuleInfo policy={policy} asOf={view.asOf} name={t('mr1.effect.info.band', { code: row.code })} />
                  </span>
                ),
              },
            ]
          : [
              { key: 'source', header: t('mr1.effect.col.source'), render: (row: Indicator) => row.dataSource },
              { key: 'formula', header: t('mr1.effect.col.formula'), render: (row: Indicator) => row.formula },
            ]),
      ]}
    />
  );
}

function SetAudit({ set }: { set: TargetSet }) {
  const { t } = useTranslation();
  return (
    <>
      <MakerCheckerBadge maker={personName(set.draftedBy)} checker={set.fixedBy === null ? null : personName(set.fixedBy)} />
      <AuditLine
        items={[
          { label: t('mr1.effect.fixed.version'), value: String(set.versionNo) },
          { label: t('mr1.effect.fixed.basis'), value: set.basis },
          { label: t('mr1.effect.fixed.draftedAt'), value: dayText(set.draftedAt.slice(0, 10)) },
          ...(set.fixedOn === null ? [] : [{ label: t('mr1.effect.fixed.on'), value: dayText(set.fixedOn) }]),
          ...(set.basisDocumentId === null ? [] : [{ label: t('mr1.effect.fixed.document'), value: set.basisDocumentId.slice(0, 8) }]),
          ...(set.supersedeReason === null ? [] : [{ label: t('mr1.effect.fixed.supersedeReason'), value: set.supersedeReason }]),
        ]}
      />
    </>
  );
}

function FixedSection({ view }: { view: EffectView }) {
  const { t } = useTranslation();
  const fixed = view.fixed;
  return (
    <SectionCard title={t('mr1.effect.fixed.title')} status={fixed === null ? <StatusPill tone="neutral">{t('mr1.effect.fixed.none.pill')}</StatusPill> : <StatusPill tone="success">{t('mr1.effect.fixed.pill')}</StatusPill>}>
      {fixed === null ? (
        <p className="callout" data-testid="no-fixed">
          {t('mr1.effect.fixed.none')}
        </p>
      ) : (
        <>
          <div data-testid="fixed-set">
            <SetAudit set={fixed} />
          </div>
          <p className="muted" data-testid="band-rule">
            {view.policy.metAtPct === null || view.policy.partlyAtPct === null ? t('mr1.effect.band.rule.unknown') : t('mr1.effect.band.rule', { met: view.policy.metAtPct, partly: view.policy.partlyAtPct })}
          </p>
          <IndicatorTable view={view} set={fixed} withActual />
        </>
      )}
    </SectionCard>
  );
}

function DraftSection({ view, canFix, onFix }: { view: EffectView; canFix: boolean; onFix: (set: TargetSet) => void }) {
  const { t } = useTranslation();
  const draft = view.draft;
  if (draft === null) return null;
  return (
    <SectionCard title={t('mr1.effect.draft.section')} status={<StatusPill tone="warning">{t('mr1.effect.draft.pill')}</StatusPill>}>
      <div data-testid="draft-set">
        <SetAudit set={draft} />
      </div>
      <p className="callout" data-testid="draft-fix-rule">
        {t('mr1.effect.fix.rule')}
      </p>
      <IndicatorTable view={view} set={draft} withActual={false} />
      {canFix ? (
        <p>
          <button type="button" className="ui-button ui-button--primary" data-action="fix" onClick={() => onFix(draft)}>
            {t('mr1.effect.action.fix')}
          </button>
        </p>
      ) : null}
    </SectionCard>
  );
}

function SupersededSection({ view }: { view: EffectView }) {
  const { t } = useTranslation();
  if (view.superseded.length === 0) return null;
  return (
    <SectionCard title={t('mr1.effect.superseded.title')}>
      <ul data-testid="superseded">
        {view.superseded.map((set) => (
          <li key={set.id}>{set.fixedOn === null ? t('mr1.effect.superseded.line.noDay', { version: set.versionNo }) : t('mr1.effect.superseded.line', { version: set.versionNo, day: dayText(set.fixedOn) })}</li>
        ))}
      </ul>
    </SectionCard>
  );
}

// ---- the measurements -----------------------------------------------------------------------------------------------------------

function MeasurementSection({ view, writable, onCorrect }: { view: EffectView; writable: boolean; onCorrect: (row: Measurement) => void }) {
  const { t } = useTranslation();
  const rows = measurementsNewestFirst(view.measurements);
  const unitOf = (code: string): string => view.fixed?.indicators.find((line) => line.code === code)?.unit ?? '';
  return (
    <SectionCard title={t('mr1.effect.measurements.title')}>
      <DataTable<Measurement>
        caption={t('mr1.effect.measurements.title')}
        rows={rows}
        rowKey={(row) => row.id}
        rowAttrs={(row) => ({ 'data-measurement': row.id, 'data-corrected': row.corrected ? 'yes' : 'no' })}
        state={rows.length === 0 ? 'empty' : 'ready'}
        columns={[
          { key: 'indicator', header: t('mr1.effect.col.indicator'), render: (row) => <code>{row.indicatorCode}</code> },
          { key: 'day', header: t('mr1.effect.col.measuredOn'), render: (row) => dayText(row.measuredOn) },
          { key: 'value', header: t('mr1.effect.col.value'), align: 'right', render: (row) => t('mr1.effect.valueUnit', { value: row.value, unit: unitOf(row.indicatorCode) }) },
          { key: 'method', header: t('mr1.effect.col.method'), render: (row) => row.methodNote },
          { key: 'evidence', header: t('mr1.effect.col.evidence'), render: (row) => (row.evidenceDocumentId === null ? <span className="muted">{t('mr1.effect.evidence.none')}</span> : row.evidenceDocumentId.slice(0, 8)) },
          { key: 'by', header: t('mr1.effect.col.recordedBy'), render: (row) => `${personName(row.recordedBy)} · ${dayText(row.recordedAt.slice(0, 10))}` },
          {
            key: 'mark',
            header: t('mr1.effect.col.mark'),
            render: (row) => (
              <span>
                {row.corrected ? <StatusPill tone="warning" icon={<span aria-hidden="true">!</span>}>{t('mr1.effect.measurement.corrected')}</StatusPill> : null}
                {row.correctsId === null ? null : (
                  <span className="eff-block">
                    <StatusPill tone="info">{t('mr1.effect.measurement.corrects')}</StatusPill> <span className="muted">{row.correctionReason ?? ''}</span>
                  </span>
                )}
              </span>
            ),
          },
          {
            key: 'actions',
            header: t('mr1.effect.col.actions'),
            render: (row) =>
              writable && view.can.measure && !row.corrected ? (
                <button type="button" className="ui-button ui-button--outline ui-button--small" data-action="correct" onClick={() => onCorrect(row)}>
                  {t('mr1.effect.action.correct')}
                </button>
              ) : null,
          },
        ]}
      />
    </SectionCard>
  );
}

// ---- the calendar ---------------------------------------------------------------------------------------------------------------

function CalendarSection({ view }: { view: EffectView }) {
  const { t } = useTranslation();
  const rows = calendarByDue(view.calendar);
  const unverified = rows.some((row) => row.ruleUnverified);
  return (
    <SectionCard title={t('mr1.effect.calendar.title')}>
      <p className="muted">{t('mr1.effect.calendar.lead')}</p>
      {unverified ? (
        <p className="callout warning eff-unverified" role="status" data-testid="calendar-unverified">
          <strong>{t('mr1.effect.calendar.unverified')}</strong>
        </p>
      ) : null}
      <DataTable<CalendarEntry>
        caption={t('mr1.effect.calendar.title')}
        rows={rows}
        rowKey={(row) => row.id}
        rowAttrs={(row) => ({ 'data-kind': row.kind, 'data-state': row.state })}
        state={rows.length === 0 ? 'empty' : 'ready'}
        columns={[
          { key: 'kind', header: t('mr1.effect.col.kind'), render: (row) => kindText(t, row.kind) },
          { key: 'anchor', header: t('mr1.effect.col.anchor'), render: (row) => t('mr1.effect.calendar.anchorOn', { anchor: anchorText(t, row.anchor), day: dayText(row.anchorOn) }) },
          { key: 'months', header: t('mr1.effect.col.months'), align: 'right', render: (row) => t('mr1.effect.calendar.months', { count: row.months }) },
          { key: 'due', header: t('mr1.effect.col.due'), render: (row) => dayText(row.dueOn) },
          {
            key: 'state',
            header: t('mr1.effect.col.state'),
            render: (row) => (
              <StatusPill tone={stateTone(row.state)} icon={<span aria-hidden="true">{STATE_GLYPH[row.state]}</span>}>
                {stateText(t, row.state, row.daysLate)}
              </StatusPill>
            ),
          },
          { key: 'required', header: t('mr1.effect.col.required'), render: (row) => (row.required ? t('mr1.effect.calendar.required') : t('mr1.effect.calendar.optional')) },
          { key: 'rule', header: t('mr1.effect.col.rule'), render: (row) => <span>{t('mr1.effect.rule.version', { code: row.ruleCode, version: row.ruleVersion })} <UnverifiedPill unverified={row.ruleUnverified} /></span> },
        ]}
      />
    </SectionCard>
  );
}

// ---- the assessments ------------------------------------------------------------------------------------------------------------

function FrozenLines({ view, lines }: { view: EffectView; lines: readonly FrozenLine[] }) {
  const { t } = useTranslation();
  return (
    <details className="eff-frozen">
      <summary>{t('mr1.effect.assessment.lines', { count: lines.length })}</summary>
      <DataTable<FrozenLine>
        caption={t('mr1.effect.assessment.linesCaption')}
        rows={[...lines]}
        rowKey={(row) => row.code}
        state={lines.length === 0 ? 'empty' : 'ready'}
        columns={[
          { key: 'code', header: t('mr1.effect.col.indicator'), render: (row) => <code>{row.code}</code> },
          { key: 'target', header: t('mr1.effect.col.target'), align: 'right', render: (row) => t('mr1.effect.valueUnit', { value: row.targetValue, unit: row.unit }) },
          { key: 'actual', header: t('mr1.effect.col.actual'), align: 'right', render: (row) => (row.actualValue === null ? t('mr1.effect.actual.none') : t('mr1.effect.valueUnit', { value: row.actualValue, unit: row.unit })) },
          { key: 'variance', header: t('mr1.effect.col.variance'), align: 'right', render: (row) => (row.variancePct === null ? t('mr1.effect.na.short') : t('mr1.effect.pct', { value: row.variancePct })) },
          {
            key: 'achievement',
            header: t('mr1.effect.col.achievement'),
            align: 'right',
            render: (row) => (
              <span>
                {row.achievementPct === null ? t('mr1.effect.na.short') : t('mr1.effect.pct', { value: row.achievementPct })} <RuleInfo policy={view.policy} asOf={view.asOf} name={t('mr1.effect.info.achievement', { code: row.code })} />
              </span>
            ),
          },
          { key: 'band', header: t('mr1.effect.col.band'), render: (row) => <BandPill band={row.band} /> },
        ]}
      />
    </details>
  );
}

function AssessmentSection({ view, canDecide, onDecide }: { view: EffectView; canDecide: boolean; onDecide: (assessment: Assessment, decision: 'APPROVE' | 'RETURN') => void }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('mr1.effect.assessments.title')}>
      <DataTable<Assessment>
        caption={t('mr1.effect.assessments.title')}
        rows={view.assessments}
        rowKey={(row) => row.id}
        rowAttrs={(row) => ({ 'data-assessment': row.id, 'data-status': row.status })}
        state={view.assessments.length === 0 ? 'empty' : 'ready'}
        columns={[
          { key: 'kind', header: t('mr1.effect.assessment.kind'), render: (row) => <span>{kindText(t, row.kind)}<span className="muted eff-block">{t('mr1.effect.assessment.asOf', { day: dayText(row.asOf) })}</span></span> },
          { key: 'conclusion', header: t('mr1.effect.assessment.conclusion'), render: (row) => <StatusPill tone={conclusionTone(row.conclusion)}>{conclusionText(t, row.conclusion)}</StatusPill> },
          {
            key: 'summary',
            header: t('mr1.effect.assessment.summary'),
            render: (row) => (
              <div>
                <p>{row.summary}</p>
                <FrozenLines view={view} lines={row.lines} />
              </div>
            ),
          },
          {
            key: 'status',
            header: t('mr1.effect.assessment.status'),
            render: (row) => (
              <span>
                <StatusPill tone={assessmentStatusTone(row.status)}>{assessmentStatusText(t, row.status)}</StatusPill>
                <span className="eff-block">
                  <UnverifiedPill unverified={row.policyUnverified} />
                </span>
              </span>
            ),
          },
          {
            key: 'people',
            header: t('mr1.effect.assessment.people'),
            render: (row) => (
              <span>
                <MakerCheckerBadge maker={personName(row.submittedBy)} checker={row.decidedBy === null ? null : personName(row.decidedBy)} />
                {row.decidedAt === null ? null : <span className="muted eff-block">{t('mr1.effect.assessment.decidedOn', { day: dayText(row.decidedAt.slice(0, 10)) })}</span>}
                {row.decisionReason === null ? null : <span className="eff-block">{row.decisionReason}</span>}
              </span>
            ),
          },
          {
            key: 'actions',
            header: t('mr1.effect.col.actions'),
            render: (row) =>
              canDecide && row.status === 'SUBMITTED' ? (
                <span className="eff-actions">
                  <button type="button" className="ui-button ui-button--primary ui-button--small" data-action="approve" onClick={() => onDecide(row, 'APPROVE')}>
                    {t('mr1.effect.decide.approve')}
                  </button>
                  <button type="button" className="ui-button ui-button--outline ui-button--small" data-action="return" onClick={() => onDecide(row, 'RETURN')}>
                    {t('mr1.effect.decide.return')}
                  </button>
                </span>
              ) : null,
          },
        ]}
      />
    </SectionCard>
  );
}
