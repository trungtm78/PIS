import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { DataTable, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { BandBadge, FigureInfo } from '../components';
import { dayText, taskLink, workflowLink } from '../model';
import type { MilestoneList } from '../model';
import { slipText } from './labels';
import { MILESTONE_DAYS } from './model';
import type { Milestone } from './model';

/** The milestones of the next 30 days: the forecast and the baseline date, the difference in words, and the risk with an icon (the colour is never the only cue). */
export function MilestonesView({ milestones }: { milestones: MilestoneList }) {
  const { t } = useTranslation();
  const columns: DataTableColumn<Milestone>[] = [
    {
      key: 'milestone',
      header: t('pwf.board.milestones.col.milestone'),
      render: (item) => (
        <span className="pwf-cellstack">
          <Link to={taskLink(item.task_id, item.project_id)}>{item.name}</Link>
          <span className="pwf-code">{item.task_code}</span>
        </span>
      ),
    },
    { key: 'project', header: t('pwf.board.col.project.header'), render: (item) => <Link className="pwf-nowrap" to={workflowLink(item.project_id)}>{item.project_code}</Link> },
    { key: 'planned', header: t('pwf.board.milestones.col.planned'), render: (item) => dayText(item.planned_date) },
    { key: 'baseline', header: t('pwf.board.milestones.col.baseline'), render: (item) => dayText(item.baseline_date) },
    {
      key: 'slip',
      header: t('pwf.board.milestones.col.slip'),
      render: (item) => (
        <span className="pwf-figure">
          {slipText(t, item.forecast_slip_days)}
          <FigureInfo name={t('pwf.board.milestones.col.slip')} formula={t('pwf.board.milestones.formula')} source={t('pwf.board.milestones.source')} asOf={milestones.as_of} version={t('pwf.board.count.version')} />
        </span>
      ),
    },
    {
      key: 'risk',
      header: t('pwf.board.milestones.col.risk'),
      render: (item) =>
        item.at_risk ? (
          <StatusPill tone="warning" icon="⚠">
            {t('pwf.board.risk.yes.word')}
          </StatusPill>
        ) : (
          <StatusPill tone="success" icon="✓">
            {t('pwf.board.risk.no.word')}
          </StatusPill>
        ),
    },
    { key: 'band', header: t('pwf.board.col.band.header'), render: (item) => <BandBadge band={item.band} /> },
  ];
  return (
    <div>
      <h2>{t('pwf.board.milestones.title', { days: MILESTONE_DAYS, from: dayText(milestones.from), to: dayText(milestones.to) })}</h2>
      <p data-testid="milestones-total" role="status">
        {t('pwf.board.milestones.total.text', { total: milestones.total })}
      </p>
      {milestones.items.length === 0 ? (
        <p className="callout" role="status">
          {t('pwf.board.milestones.empty.text')}
        </p>
      ) : (
        <div data-testid="milestones-table" className="pwf-free">
          <DataTable columns={columns} rows={[...milestones.items]} rowKey={(item) => item.task_id} caption={t('pwf.board.milestones.caption')} state="ready" />
        </div>
      )}
    </div>
  );
}
