import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, SectionCard, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { clockText } from '../home/overview-model';
import { EmptyReason, FigureTile, Guarded } from './components';
import { useTracker } from './hooks';
import { PERMISSION, dayText, directivePath, toFigures } from './model';
import type { Tracker } from './model';

type UnitRow = Tracker['units'][number];
type DirectiveRow = Tracker['directives'][number];

/**
 * BAN-04, the directives of the committee: how many are open, overdue and escalated in each unit, how old the oldest overdue one is, and the list of the overdue and escalated ones with the way on to DIR-04. Overdue and
 * escalated are counted from the days and the policy of DIR on the day the screen is read; nothing here is stored as a state.
 */
export default function TrackerScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  return (
    <Guarded route={route} permission={PERMISSION.read} title={t('ban.trk.page.title')} subtitle={t('ban.trk.page.subtitle')}>
      <TrackerContent />
    </Guarded>
  );
}

function TrackerContent() {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const query = useTracker();
  const data = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data, isEmpty: () => false });

  const unitColumns: DataTableColumn<UnitRow>[] = [
    { key: 'unit', header: t('ban.trk.col.unit'), pinned: true, render: (unit) => <strong>{unit.unit_name}</strong> },
    { key: 'open', header: t('ban.trk.col.open'), align: 'right', render: (unit) => unit.open },
    { key: 'overdue', header: t('ban.trk.col.overdue'), align: 'right', render: (unit) => unit.overdue },
    { key: 'escalated', header: t('ban.trk.col.escalated'), align: 'right', render: (unit) => unit.escalated },
    { key: 'oldest', header: t('ban.trk.col.oldest'), align: 'right', render: (unit) => (unit.oldest_overdue_days === null ? t('ban.trk.oldest.none') : t('ban.trk.oldest.days', { days: unit.oldest_overdue_days })) },
  ];
  const directiveColumns: DataTableColumn<DirectiveRow>[] = [
    {
      key: 'code',
      header: t('ban.trk.col.directive'),
      pinned: true,
      render: (row) => (
        <Link to={directivePath(row.id)} data-testid={`directive-${row.id}`}>
          <strong>{row.code}</strong>
        </Link>
      ),
    },
    { key: 'text', header: t('ban.trk.col.text'), render: (row) => row.text },
    { key: 'project', header: t('ban.trk.col.project'), render: (row) => row.project_code ?? t('ban.trk.project.none') },
    { key: 'unit', header: t('ban.trk.col.assignee'), render: (row) => row.assignee_unit_name },
    { key: 'due', header: t('ban.trk.col.due'), render: (row) => dayText(row.due_on) },
    { key: 'late', header: t('ban.trk.col.late'), align: 'right', render: (row) => t('ban.trk.late.days', { days: row.overdue_days }) },
    {
      key: 'phase',
      header: t('ban.trk.col.phase'),
      render: (row) =>
        row.phase === 'ESCALATED' ? (
          <StatusPill tone="danger" icon="⛔">
            {t('ban.trk.phase.escalated')}
          </StatusPill>
        ) : (
          <StatusPill tone="warning" icon="▲">
            {t('ban.trk.phase.overdue')}
          </StatusPill>
        ),
    },
    { key: 'extensions', header: t('ban.trk.col.extensions'), align: 'right', render: (row) => row.extension_count },
  ];

  return (
    <>
      <ContextBar
        items={[
          { label: t('ban.dash.context.scope'), value: tenant?.name ?? '–' },
          { label: t('ban.dash.context.asOf'), value: data === undefined ? '–' : dayText(data.as_of) },
        ]}
        {...(query.dataUpdatedAt > 0 ? { asOf: clockText(query.dataUpdatedAt) } : {})}
        stale={query.isError && data !== undefined}
      />
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {data === undefined ? null : (
          <>
            <section className="ban-figures" aria-label={t('ban.dash.figures.aria')} data-testid="tracker-figures">
              {toFigures(data.figures).map((tile) => (
                <FigureTile key={tile.metricCode} tile={tile} />
              ))}
            </section>
            <SectionCard title={t('ban.trk.totals.title')}>
              <div className="ban-summary" data-testid="tracker-totals">
                <div className="ban-summary__item">
                  <span>{t('ban.trk.total.open')}</span>
                  <strong>{data.totals.open}</strong>
                </div>
                <div className="ban-summary__item">
                  <span>{t('ban.trk.total.overdue')}</span>
                  <strong>{data.totals.overdue}</strong>
                </div>
                <div className="ban-summary__item">
                  <span>{t('ban.trk.total.escalated')}</span>
                  <strong>{data.totals.escalated}</strong>
                </div>
              </div>
              <p className="ban-muted">{t('ban.trk.rule.text', { days: data.escalate_after_days })}</p>
            </SectionCard>
            <SectionCard title={t('ban.trk.units.title')}>
              {data.units.length === 0 ? <EmptyReason text={t('ban.trk.units.empty.text')} testId="tracker-units-empty" /> : <DataTable caption={t('ban.trk.units.caption')} columns={unitColumns} rows={data.units} rowKey={(unit) => unit.unit_id} />}
            </SectionCard>
            <SectionCard title={t('ban.trk.list.title')}>
              {data.directives.length === 0 ? (
                <EmptyReason text={data.totals.open === 0 ? t('ban.trk.list.noOpen.text') : t('ban.trk.list.onTime.text')} testId="tracker-list-empty" />
              ) : (
                <>
                  <DataTable caption={t('ban.trk.list.caption')} columns={directiveColumns} rows={data.directives} rowKey={(row) => row.id} />
                  {data.truncated ? (
                    <p className="callout warning" role="status" data-testid="tracker-truncated">
                      {t('ban.trk.list.truncated.text')}
                    </p>
                  ) : null}
                </>
              )}
            </SectionCard>
          </>
        )}
      </StateBoundary>
    </>
  );
}
