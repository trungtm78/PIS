import { DIS_GOLDEN, DIS_GOLDEN_SESSION } from '@machvon/contracts';
import type { GoldenFixture } from '@machvon/contracts';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DISBURSEMENT_DOMAIN, DISBURSEMENT_REQUIRED_TERMS, definitionState } from '../../mdm/model';
import type { GlossaryTermView } from '../../mdm/model';
import { useGlossaryTerms } from '../../mdm/hooks';
import '../dis.css';

type T = Translator['t'];

/** Where the terms are proposed, approved and published: this screen only reads them. */
const GLOSSARY_PATH = '/mdm/mdm-34';

function termStatusLabel(t: T, status: GlossaryTermView['status'] | undefined): string {
  switch (status) {
    case undefined:
      return t('dis.definitions.term.missing');
    case 'PUBLISHED':
      return t('dis.definitions.term.published');
    case 'APPROVED':
      return t('dis.definitions.term.approved');
    case 'IN_REVIEW':
      return t('dis.definitions.term.inReview');
    case 'DRAFT':
      return t('dis.definitions.term.draft');
    case 'REJECTED':
      return t('dis.definitions.term.rejected');
    case 'DEPRECATED':
      return t('dis.definitions.term.deprecated');
  }
}

function fixtureTitle(t: T, id: GoldenFixture['id']): string {
  switch (id) {
    case 'FX-DIS-001':
      return t('dis.definitions.fixture.fx001');
    case 'FX-DIS-002':
      return t('dis.definitions.fixture.fx002');
    case 'FX-DIS-003':
      return t('dis.definitions.fixture.fx003');
    case 'FX-DIS-004':
      return t('dis.definitions.fixture.fx004');
    case 'FX-DIS-005':
      return t('dis.definitions.fixture.fx005');
    case 'FX-DIS-006':
      return t('dis.definitions.fixture.fx006');
    case 'FX-DIS-007':
      return t('dis.definitions.fixture.fx007');
  }
}

/** The term of the glossary that stands for a required code: the published revision when there is one, otherwise the newest. */
function termOf(terms: readonly GlossaryTermView[], code: string): GlossaryTermView | undefined {
  const own = terms.filter((term) => term.termCode === code);
  return own.find((term) => term.status === 'PUBLISHED') ?? [...own].sort((a, b) => b.revision - a.revision)[0];
}

/**
 * DIS-25: the definitions of the metrics of the period, the year to date and the project to date, and the golden fixtures, in one place that only reads (ST-DIS-011, DIS 3 F6, BR-DIS-12, CXN-03, CXN-11). The
 * definitions are the terms of the glossary of the domain DISBURSEMENT; each carries the label that it awaits the sign-off of the capital business owner (D03) until it is published, and nothing here edits,
 * approves or signs: that is done on the glossary, by the owner of the domain. The fixtures are the synthetic cases whose expected numbers are to be signed.
 */
export default function DefinitionsScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  return <DefinitionsContent key={tenantId ?? 'none'} route={route} />;
}

function DefinitionsContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const glossary = useGlossaryTerms();
  const state = useScreenState({ isLoading: glossary.isLoading, error: glossary.error, data: glossary.data, isEmpty: () => false });
  const terms = (glossary.data ?? []).filter((term) => term.domain === DISBURSEMENT_DOMAIN);
  const signed = definitionState(glossary.data ?? [], DISBURSEMENT_DOMAIN)?.signed === true;
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dis.definitions.page.title')}</h1>
          <p>{t('dis.definitions.page.subtitle')}</p>
        </div>
        {glossary.data === undefined ? null : signed ? (
          <span className="pill green" data-testid="definitions-signed">
            {t('dis.definitions.signed')}
          </span>
        ) : (
          <span className="pill warn" data-testid="definitions-pending" title={t('dis.definitions.pending.title')}>
            {t('dis.definitions.pending', { session: DIS_GOLDEN_SESSION })}
          </span>
        )}
      </div>
      <StateBoundary state={state} onRetry={() => void glossary.refetch()}>
        <section className="card" aria-labelledby="definitions-title">
          <h2 id="definitions-title">{t('dis.definitions.terms.title')}</h2>
          <p className="sub" data-testid="definitions-readonly">
            {t('dis.definitions.readonly.note')} <Link to={GLOSSARY_PATH}>{t('dis.definitions.glossary.link')}</Link>
          </p>
          <div className="tablewrap">
            <table className="table" aria-label={t('dis.definitions.terms.aria')} data-testid="definitions-table">
              <thead>
                <tr>
                  <th scope="col">{t('dis.definitions.col.term')}</th>
                  <th scope="col">{t('dis.definitions.col.definition')}</th>
                  <th scope="col">{t('dis.definitions.col.formula')}</th>
                  <th scope="col">{t('dis.definitions.col.status')}</th>
                </tr>
              </thead>
              <tbody>
                {DISBURSEMENT_REQUIRED_TERMS.map((code) => {
                  const term = termOf(terms, code);
                  return (
                    <tr key={code} data-term={code} data-status={term?.status ?? 'MISSING'}>
                      <td>
                        {term?.termVi ?? code}
                        <span className="dis-code">{code}</span>
                      </td>
                      <td>{term?.definition ?? t('dis.definitions.term.none')}</td>
                      <td>{term?.formulaRef === null || term === undefined ? <span>—</span> : <code>{term.formulaRef}</code>}</td>
                      <td>
                        <span className={term?.status === 'PUBLISHED' ? 'pill green' : 'pill warn'}>{termStatusLabel(t, term?.status)}</span>
                        {term?.status === 'PUBLISHED' ? null : <span className="dis-code">{t('dis.definitions.term.awaiting', { session: DIS_GOLDEN_SESSION })}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
        <section className="card" aria-labelledby="fixtures-title">
          <h2 id="fixtures-title">{t('dis.definitions.fixtures.title')}</h2>
          <p className="sub">{t('dis.definitions.fixtures.note', { session: DIS_GOLDEN_SESSION })}</p>
          <div className="tablewrap">
            <table className="table" aria-label={t('dis.definitions.fixtures.aria')} data-testid="fixtures-table">
              <thead>
                <tr>
                  <th scope="col">{t('dis.definitions.fixtures.col.id')}</th>
                  <th scope="col">{t('dis.definitions.fixtures.col.case')}</th>
                  <th scope="col">{t('dis.definitions.fixtures.col.rule')}</th>
                  <th scope="col">{t('dis.definitions.fixtures.col.given')}</th>
                  <th scope="col">{t('dis.definitions.fixtures.col.expected')}</th>
                </tr>
              </thead>
              <tbody>
                {DIS_GOLDEN.map((fixture) => (
                  <tr key={fixture.id} data-fixture={fixture.id}>
                    <th scope="row">
                      {fixture.id}
                      <span className="dis-code">{fixture.test}</span>
                    </th>
                    <td>{fixtureTitle(t, fixture.id)}</td>
                    <td>{fixture.rule}</td>
                    <td>
                      <code data-testid={`given-${fixture.id}`}>{JSON.stringify(fixture.given)}</code>
                    </td>
                    <td>
                      <code data-testid={`expected-${fixture.id}`}>{JSON.stringify(fixture.expected)}</code>
                      <span className="pill warn">{t('dis.definitions.pending', { session: DIS_GOLDEN_SESSION })}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </StateBoundary>
      <p className="prototype-note">{t('dis.definitions.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
