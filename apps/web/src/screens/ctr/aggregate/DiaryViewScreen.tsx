import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { useCoverage } from '../../qms/diary-cover/hooks';
import { statusLabel, roleLabel, weatherLabel } from '../../qms/diary/labels';
import { READ_PERMISSION, catalogueLink, pendingConflicts, reviewLink } from '../../qms/diary/model';
import type { DiaryLine } from '../../qms/diary/model';
import { vietnamToday } from '../workspace/model';
import { ViewFrame } from './ViewFrame';
import { useDiaries, useViewScope } from './hooks';
import { ownerLink } from './model';
import { SectionCard } from '../../../ui';

/**
 * CTR-09: the site diaries of a contract, read-only (ST-CTR-017, CTR section 7). QMS owns the diaries (QMS-01 to QMS-03): every write and every signature goes through its commands. Here a
 * contract officer sees the diaries of the contract with the signatures each carries and the coverage of the month, and follows a link to the diary on the screen that owns it.
 */
export default function DiaryViewScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The view belongs to one membership: a switch of tenant or of membership starts it over.
  return <DiaryContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function DiaryContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const scope = useViewScope(READ_PERMISSION);
  const diaries = useDiaries(scope);
  return (
    <ViewFrame
      route={route}
      title={t('ctr.diaryView.page.title')}
      subtitle={t('ctr.diaryView.page.subtitle')}
      module="QMS"
      scope={scope}
      loaded={diaries}
      isEmpty={(rows) => rows.length === 0}
      owners={[
        { id: 'QMS-01', to: catalogueLink() },
        { id: 'QMS-11', to: ownerLink.coverage(scope.contractId ?? '') },
      ]}
    >
      {({ contract, data }) => (
        <>
          <Coverage contractId={contract.id} />
          <DiaryTable rows={data} />
        </>
      )}
    </ViewFrame>
  );
}

/** The month so far: how many working days have a signed diary, a draft or none. A contract without a working calendar has no coverage, and the view says so without losing the diaries. */
function Coverage({ contractId }: { contractId: string }) {
  const { t } = useTranslation();
  const month = vietnamToday(new Date()).slice(0, 7);
  const coverage = useCoverage(contractId, month);
  const totals = coverage.data?.totals;
  return (
    <article className="card" aria-label={t('ctr.diaryView.cover.title', { month })} data-testid="coverage">
      <h2>{t('ctr.diaryView.cover.title', { month })}</h2>
      {totals === undefined ? (
        <p className="sub" data-testid="coverage-none">
          {coverage.isLoading ? t('ctr.diaryView.cover.loading') : t('ctr.diaryView.cover.unavailable')}
        </p>
      ) : (
        <dl className="ctr-facts">
          <dt>{t('ctr.diaryView.cover.working')}</dt>
          <dd data-testid="cover-working">{totals.workingDays}</dd>
          <dt>{t('ctr.diaryView.cover.signed')}</dt>
          <dd data-testid="cover-signed">{totals.signed}</dd>
          <dt>{t('ctr.diaryView.cover.draft')}</dt>
          <dd data-testid="cover-draft">{totals.draft}</dd>
          <dt>{t('ctr.diaryView.cover.missing')}</dt>
          <dd data-testid="cover-missing">{totals.missing}</dd>
          <dt>{t('ctr.diaryView.cover.late')}</dt>
          <dd data-testid="cover-late">{totals.late}</dd>
        </dl>
      )}
    </article>
  );
}

function DiaryTable({ rows }: { rows: DiaryLine[] }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('ctr.diaryView.table.label')}>
      <table className="table" data-testid="diaries">
        <thead>
          <tr>
            <th scope="col">{t('ctr.diaryView.column.no')}</th>
            <th scope="col">{t('ctr.diaryView.column.date')}</th>
            <th scope="col">{t('ctr.diaryView.column.status')}</th>
            <th scope="col">{t('ctr.diaryView.column.weather')}</th>
            <th scope="col" className="ctr-amount">
              {t('ctr.diaryView.column.workforce')}
            </th>
            <th scope="col">{t('ctr.diaryView.column.signed')}</th>
            <th scope="col" className="ctr-amount">
              {t('ctr.diaryView.column.conflicts')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((diary) => {
            const signed = diary.signatures.filter((signature) => signature.valid).map((signature) => roleLabel(t, signature.role));
            return (
              <tr key={diary.id} data-diary={diary.id}>
                <td>
                  <Link to={reviewLink(diary.id)} data-testid="open">
                    {diary.diaryNo}
                  </Link>
                </td>
                <td data-testid="date">{diary.recordDate}</td>
                <td data-testid="status">{statusLabel(t, diary.status)}</td>
                <td data-testid="weather">{diary.weatherCode === null ? '–' : weatherLabel(t, diary.weatherCode)}</td>
                <td className="ctr-amount" data-testid="workforce">
                  {diary.workforceCount ?? '–'}
                </td>
                <td data-testid="signed">{signed.length === 0 ? t('ctr.diaryView.signed.none') : signed.join(', ')}</td>
                <td className="ctr-amount" data-testid="conflicts">
                  {pendingConflicts(diary).length}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </SectionCard>
  );
}
