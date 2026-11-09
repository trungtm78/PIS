import { useTranslation } from '../../../../i18n';
import type { ScreenProps } from '../../../../routes/types';
import { useSession } from '../../../../session/SessionContext';
import { FundTile } from '../../../../screens/home/funding-components';
import { billionsText } from '../../../../screens/home/funding-model';
import '../../../../screens/dis/dis.css';
import '../../../../screens/home/home.css';
import { ContextBar, KpiStrip, SectionCard } from '../../../../ui';
import { useLeaderRates } from './hooks';
import type { LeaderRates } from './hooks';
import { percentText } from './model';
import { structureRefused } from './structure-model';
import type { StructureClassRow } from './structure-model';
import './leader.css';

/**
 * HOME-07 of the enterprise edition (ENT-4d, FND-1): the funding structure of the company by the classes of the enterprise taxonomy (equity, loan, other), from the latest frozen enterprise snapshot, through the
 * same read as the leader panel (`getLeaderRates`, the one reader of the snapshot). The plan in force of each class, what was disbursed since the start of the year, the share of the class in the whole and its rate
 * against its own plan. A figure nobody has is said so, never 0. Read only; it replaces the screen of the public funding structure (NSTW, NSDP, ODA) through the slot of the edition.
 */
export default function FundingStructureScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <StructureContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function StructureContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const tenant = useSession().tenant;
  const read = useLeaderRates();
  const data: LeaderRates | undefined = read.data;
  const structure = data?.structure;
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ent.funding.page.title')}</h1>
          <p>{t('ent.funding.page.subtitle')}</p>
        </div>
      </div>
      {read.isLoading ? (
        <p role="status" aria-busy="true">
          {t('ent.leader.loading.text')}
        </p>
      ) : data === undefined || structure === undefined ? (
        structureRefused(read.error) ? (
          <p role="status" data-testid="funding-structure-empty">
            {t('ent.funding.empty')}
          </p>
        ) : (
          <p role="alert" data-testid="funding-structure-error">
            {t('ent.leader.error.text')}{' '}
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void read.refetch()}>
              {t('ent.leader.retry.action')}
            </button>
          </p>
        )
      ) : (
        <div className="home-stack" data-testid="funding-structure">
          <ContextBar
            items={[
              { label: t('dis.wr.ctx.scope'), value: tenant?.name ?? t('dis.wr.ctx.scope.all') },
              { label: t('home.funding.year.label'), value: data.as_of_date.slice(0, 4) },
              { label: t('ent.funding.context.snapshot'), value: t('ent.funding.context.snapshotValue', { day: data.as_of_date.split('-').reverse().join('/'), revision: data.revision ?? 0 }) },
            ]}
            unit={t('w2dis.home.unit.billion')}
          />
          <SectionCard title={t('ent.funding.total.title')} unit={t('w2dis.home.unit.billion')}>
            <KpiStrip label={t('ent.funding.total.title')}>
              <FundTile label={t('ent.funding.total.plan')} vnd={structure.plan_total_vnd} testId="funding-total-plan" tone="success" />
              <FundTile label={t('ent.funding.total.disbursed')} vnd={structure.disbursed_total_vnd} testId="funding-total-disbursed" />
            </KpiStrip>
            <p className="home-note">{t('ent.funding.total.note')}</p>
          </SectionCard>
          <SectionCard title={t('ent.funding.classes.title')} unit={t('w2dis.home.unit.billion')}>
            <KpiStrip label={t('ent.funding.classes.title')}>
              {structure.classes.map((row) => (
                <ClassTile key={row.class_code} row={row} locale={locale} />
              ))}
            </KpiStrip>
          </SectionCard>
        </div>
      )}
    </section>
  );
}

function ClassTile({ row, locale }: { row: StructureClassRow; locale: string }) {
  const { t } = useTranslation();
  const label = row.class_code === 'EQUITY' ? t('ent.funding.class.equity') : row.class_code === 'LOAN' ? t('ent.funding.class.loan') : row.class_code === 'OTHER' ? t('ent.funding.class.other') : row.class_code;
  const none = t('ent.leader.noData.text');
  const percent = (value: string | null): string => (value === null ? none : percentText(value, locale));
  return (
    <FundTile label={label} vnd={row.plan_vnd} card={row.class_code} testId={`structure-${row.class_code}`}>
      <span className="home-fund-line" data-testid={`structure-${row.class_code}-plan-share`}>
        {t('ent.funding.card.planShare', { value: percent(row.plan_share_pct) })}
      </span>
      <span className="home-fund-line" data-testid={`structure-${row.class_code}-disbursed`}>
        {t('ent.funding.card.disbursed', { value: row.disbursed_vnd === null ? none : t('home.funding.card.amount', { value: billionsText(row.disbursed_vnd, locale) }) })}
      </span>
      <span className="home-fund-line">{t('ent.funding.card.disbursedShare', { value: percent(row.disbursed_share_pct) })}</span>
      <span className="home-fund-line">{t('ent.funding.card.rate', { value: percent(row.rate_pct) })}</span>
    </FundTile>
  );
}
