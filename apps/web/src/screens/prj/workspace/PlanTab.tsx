import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { DataTable, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { methodLabel } from '../../bid/plan-labels';
import type { PackageLine } from '../../bid/plan-model';
import { bucketLabel, kindLabel } from '../../cap/plan-labels';
import { periodOf } from '../../cap/plan-model';
import type { PlanLine } from '../../cap/plan-model';
import { statusLabel as contractStatusLabel } from '../../ctr/labels';
import type { ContractLine } from '../../ctr/model';
import { useComponents, useMilestones } from '../plan/hooks';
import type { ComponentView, MilestoneView } from '../plan/model';
import { milestoneStatusLabel, milestoneTone } from '../plan/shared';
import { QuerySection, money } from './common';
import type { TabProps } from './common';
import { packageStatusLabel } from './plan-labels';
import { useProjectCapital, useProjectContracts, useProjectPackages } from './plan-hooks';
import type { ProjectCapital } from './plan-hooks';

const MILESTONES_PATH = '/prj/prj-07';
const COMPONENTS_PATH = '/prj/prj-05';
const CAPITAL_PATH = '/cap/cap-03';
const PACKAGES_PATH = '/bid/bid-03';
const CONTRACTS_PATH = '/ctr/ctr-01';

const withProject = (path: string, id: string): string => `${path}?id=${encodeURIComponent(id)}`;

const sum = (values: ReadonlyArray<string | null>): string => values.reduce((total, value) => total + (value !== null && /^-?\d+$/.test(value) ? BigInt(value) : 0n), 0n).toString();

/** PRJ-03, tab "Plan": milestones, work breakdown, capital plan lines by source, procurement packages and contracts of the project. */
export default function PlanTab({ project }: TabProps) {
  return (
    <div data-testid="tab-plan">
      <MilestonesSection projectId={project.id} />
      <ComponentsSection projectId={project.id} />
      <CapitalSection projectId={project.id} />
      <PackagesSection projectId={project.id} />
      <ContractsSection projectId={project.id} />
    </div>
  );
}

function MilestonesSection({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const query = useMilestones(projectId);
  const columns: DataTableColumn<MilestoneView>[] = [
    {
      key: 'milestone',
      header: t('prj.mile.col.milestone'),
      render: (item) => (
        <>
          <code>{item.code}</code> {item.name}
        </>
      ),
    },
    { key: 'baseline', header: t('prj.mile.col.baseline'), render: (item) => item.baselineDate },
    { key: 'planned', header: t('prj.mile.col.planned'), render: (item) => item.plannedDate },
    { key: 'actual', header: t('prj.mile.col.actual'), render: (item) => item.actualDate ?? '–' },
    {
      key: 'status',
      header: t('prj.mile.col.status'),
      render: (item) => (
        <span className="prj-pills" data-status={item.status} data-delayed={item.delayed}>
          <StatusPill tone={milestoneTone(item.status)}>{milestoneStatusLabel(t, item.status)}</StatusPill>
          {item.delayed ? (
            <span data-testid="delay">
              <StatusPill tone="danger">{t('prj.mile.delay.pill', { days: item.delayDays })}</StatusPill>
            </span>
          ) : null}
        </span>
      ),
    },
  ];
  return (
    <QuerySection
      title={t('prj.wsTab.plan.milestones.title')}
      query={query}
      isEmpty={(items) => items.length === 0}
      emptyText={t('prj.wsTab.plan.milestones.empty')}
      linkTo={withProject(MILESTONES_PATH, projectId)}
      linkLabel={t('prj.wsTab.plan.milestones.link')}
      testId="ws-milestones"
    >
      {(items) => <DataTable caption={t('prj.wsTab.plan.milestones.caption')} columns={columns} rows={items} rowKey={(item) => item.id} />}
    </QuerySection>
  );
}

function ComponentsSection({ projectId }: { projectId: string }) {
  const { t, locale } = useTranslation();
  const query = useComponents(projectId);
  const columns: DataTableColumn<ComponentView>[] = [
    {
      key: 'code',
      header: t('prj.wbs.col.code'),
      render: (item) => (
        <span style={{ paddingLeft: `${Math.max(item.depth - 1, 0) * 16}px` }}>
          <code>{item.code}</code> {item.name}
        </span>
      ),
    },
    { key: 'value', header: t('prj.wbs.col.value'), align: 'right', render: (item) => money(item.plannedValueVnd, locale) },
    { key: 'from', header: t('prj.wbs.col.from'), render: (item) => item.validFrom },
  ];
  return (
    <QuerySection
      title={t('prj.wsTab.plan.components.title')}
      query={query}
      isEmpty={(register) => register.items.length === 0}
      emptyText={t('prj.wsTab.plan.components.empty')}
      linkTo={withProject(COMPONENTS_PATH, projectId)}
      linkLabel={t('prj.wsTab.plan.components.link')}
      testId="ws-components"
    >
      {(register) => (
        <>
          <DataTable
            caption={t('prj.wsTab.plan.components.caption')}
            columns={columns}
            rows={register.items}
            rowKey={(item) => item.id}
          />
          <p className={register.exceedsTotal ? 'callout warning' : undefined} role="status" data-testid="ws-wbs-total">
            {register.exceedsTotal
              ? t('prj.wbs.exceeds.warning', { wbs: money(register.wbsTotalVnd, locale), total: money(register.projectTotalVnd, locale) })
              : t('prj.wsTab.plan.components.within', { wbs: money(register.wbsTotalVnd, locale), total: money(register.projectTotalVnd, locale) })}
          </p>
        </>
      )}
    </QuerySection>
  );
}

function CapitalSection({ projectId }: { projectId: string }) {
  const { t, locale } = useTranslation();
  const query = useProjectCapital(projectId);
  const columns: DataTableColumn<PlanLine>[] = [
    { key: 'source', header: t('prj.wsTab.plan.capital.colSource'), render: (line) => line.fundSource.label },
    { key: 'bucket', header: t('prj.wsTab.plan.capital.colClass'), render: (line) => bucketLabel(t, line.bucket) },
    { key: 'year', header: t('prj.wsTab.plan.capital.colYear'), render: (line) => String(line.sourceYear) },
    { key: 'amount', header: t('prj.wsTab.plan.capital.colAmount'), align: 'right', render: (line) => money(line.amountVnd, locale) },
    { key: 'disbursed', header: t('prj.wsTab.plan.capital.colDisbursed'), align: 'right', render: (line) => (line.disbursedVnd === null ? '–' : money(line.disbursedVnd, locale)) },
  ];
  return (
    <QuerySection
      title={t('prj.wsTab.plan.capital.title')}
      query={query}
      isEmpty={(plans: ProjectCapital[]) => plans.every((entry) => entry.lines.length === 0)}
      emptyText={t('prj.wsTab.plan.capital.empty')}
      linkTo={CAPITAL_PATH}
      linkLabel={t('prj.wsTab.plan.capital.link')}
      testId="ws-capital"
    >
      {(plans) => (
        <>
          {plans
            .filter((entry) => entry.lines.length > 0)
            .map((entry) => (
              <div key={entry.plan.id} data-testid="ws-capital-plan">
                <h3>{t('prj.wsTab.plan.capital.plan', { kind: kindLabel(t, entry.plan.planKind), period: periodOf(entry.plan), code: entry.plan.planCode, revision: entry.plan.revision })}</h3>
                <DataTable
                  caption={t('prj.wsTab.plan.capital.caption')}
                  columns={columns}
                  rows={entry.lines}
                  rowKey={(line) => line.id}
                />
                <p data-testid="ws-capital-total">
                  <strong>{t('prj.wsTab.plan.capital.total', { amount: money(sum(entry.lines.map((line) => line.amountVnd)), locale) })}</strong>
                </p>
              </div>
            ))}
        </>
      )}
    </QuerySection>
  );
}

function PackagesSection({ projectId }: { projectId: string }) {
  const { t, locale } = useTranslation();
  const query = useProjectPackages(projectId);
  const columns: DataTableColumn<PackageLine>[] = [
    {
      key: 'code',
      header: t('prj.wsTab.plan.packages.colCode'),
      render: (item) => (
        <>
          <code>{item.code}</code>
          {item.title === null ? null : <> {item.title}</>}
        </>
      ),
    },
    { key: 'method', header: t('prj.wsTab.plan.packages.colMethod'), render: (item) => methodLabel(t, item.method) },
    { key: 'status', header: t('prj.wsTab.plan.packages.colStatus'), render: (item) => <StatusPill tone={item.status === 'AWARDED' ? 'success' : 'neutral'}>{packageStatusLabel(t, item.status)}</StatusPill> },
    { key: 'budget', header: t('prj.wsTab.plan.packages.colBudget'), align: 'right', render: (item) => money(item.budgetVnd, locale) },
  ];
  return (
    <QuerySection
      title={t('prj.wsTab.plan.packages.title')}
      query={query}
      isEmpty={(items) => items.length === 0}
      emptyText={t('prj.wsTab.plan.packages.empty')}
      linkTo={PACKAGES_PATH}
      linkLabel={t('prj.wsTab.plan.packages.link')}
      testId="ws-packages"
    >
      {(items) => <DataTable caption={t('prj.wsTab.plan.packages.caption')} columns={columns} rows={items} rowKey={(item) => item.id} />}
    </QuerySection>
  );
}

function ContractsSection({ projectId }: { projectId: string }) {
  const { t, locale } = useTranslation();
  const query = useProjectContracts(projectId);
  const columns: DataTableColumn<ContractLine>[] = [
    {
      key: 'code',
      header: t('ctr.list.column.code'),
      render: (item) => (
        <>
          <Link to={`${CONTRACTS_PATH}?id=${encodeURIComponent(item.id)}`}>
            <code>{item.code}</code>
          </Link>
          {item.title === null ? null : <> {item.title}</>}
        </>
      ),
    },
    { key: 'contractor', header: t('ctr.list.column.contractor'), render: (item) => item.contractorName ?? '–' },
    { key: 'value', header: t('ctr.list.column.value'), align: 'right', render: (item) => money(item.contractValueVnd, locale) },
    { key: 'status', header: t('ctr.list.column.status'), render: (item) => <StatusPill tone="info">{contractStatusLabel(t, item.status)}</StatusPill> },
  ];
  return (
    <QuerySection
      title={t('prj.wsTab.plan.contracts.title')}
      query={query}
      isEmpty={(items) => items.length === 0}
      emptyText={t('prj.wsTab.plan.contracts.empty')}
      linkTo={CONTRACTS_PATH}
      linkLabel={t('prj.wsTab.plan.contracts.link')}
      testId="ws-contracts"
    >
      {(items) => <DataTable caption={t('prj.wsTab.plan.contracts.caption')} columns={columns} rows={items} rowKey={(item) => item.id} />}
    </QuerySection>
  );
}
