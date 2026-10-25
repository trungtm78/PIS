import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useProjectOptions } from '../../ctr/hooks';
import { isUuid } from '../../ctr/change/model';
import { instantText } from '../model';
import { useChain } from './hooks';
import { typeLabel } from './labels';
import { NODE_TYPES, PROJECT_READ_PERMISSION, READ_PERMISSION, correctsOf, nodeLink, nodesOf, vndText } from './model';
import type { Chain, ChainNode } from './model';
import '../pay.css';

/**
 * PAY-17: the trace of a payment (ST-PAY-010, PAY 3.4, UAT-AC67). From a project, and from one of its contracts when one is picked, the screen lists in the order of the chain the project, the contract with
 * the revision in force, the measurements the acceptances rest on (a measurement that was corrected shows its new revision and the old one marked as superseded, the acceptance keeping the revision it
 * used), the acceptances, the payment requests, the Treasury transactions matched to them and the settlements, each with the version it stands at and a link to the screen where it is worked on. It
 * only reads: nothing here changes a record. A project that is not there for the caller says so and says nothing of what exists.
 */
export default function ChainScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The chain belongs to one membership: a switch of tenant or of membership starts the screen over.
  return <ChainContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ChainContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions } = useSession();
  const holds = (permission: string): boolean => permissions === undefined || permissions.includes(permission);
  const mayRead = holds(READ_PERMISSION);
  const [search, setSearch] = useSearchParams();
  const rawProject = search.get('project');
  const rawContract = search.get('contract');
  const projectId = rawProject !== null && isUuid(rawProject) ? rawProject : null;
  const contractId = rawContract !== null && isUuid(rawContract) ? rawContract : null;
  const projects = useProjectOptions(holds(PROJECT_READ_PERMISSION) && mayRead);
  const chain = useChain(projectId, contractId, mayRead);
  const state = useScreenState({ isLoading: chain.isLoading, error: chain.error, data: projectId === null ? null : chain.data, isEmpty: () => false });
  const found = chain.data ?? undefined;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pay.chain.title')}</h1>
          <p>{t('pay.chain.subtitle')}</p>
        </div>
      </div>
      {!mayRead ? (
        <p className="callout" role="status" data-testid="no-read">
          {t('pay.chain.read.denied')}
        </p>
      ) : (
        <>
          <article className="card" aria-label={t('pay.chain.pick.title')}>
            <h2>{t('pay.chain.pick.title')}</h2>
            <div className="pay-form-grid">
              <div className="field">
                <label htmlFor="chain-project">{t('pay.chain.pick.project')}</label>
                {(projects.data ?? []).length > 0 ? (
                  <select id="chain-project" value={projectId ?? ''} onChange={(event) => setSearch(event.target.value === '' ? {} : { project: event.target.value })}>
                    <option value="">{t('pay.chain.pick.project.choose')}</option>
                    {(projects.data ?? []).map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id="chain-project"
                    autoComplete="off"
                    defaultValue={rawProject ?? ''}
                    onBlur={(event) => setSearch(isUuid(event.target.value.trim()) ? { project: event.target.value.trim() } : {})}
                  />
                )}
              </div>
              {found === undefined || projectId === null ? null : (
                <div className="field">
                  <label htmlFor="chain-contract">{t('pay.chain.pick.contract')}</label>
                  <select
                    id="chain-contract"
                    value={contractId ?? ''}
                    onChange={(event) => setSearch(event.target.value === '' ? { project: projectId } : { project: projectId, contract: event.target.value })}
                  >
                    <option value="">{t('pay.chain.pick.contract.all')}</option>
                    {contractOptions(found, contractId).map((contract) => (
                      <option key={contract.id} value={contract.id}>
                        {contract.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          </article>
          {projectId === null ? (
            <p className="sub" role="status" data-testid="pick">
              {t('pay.chain.pick.none')}
            </p>
          ) : (
            <StateBoundary state={state} onRetry={() => void chain.refetch()}>
              {found === undefined ? (
                <p className="callout" role="status" data-testid="not-found">
                  {t('pay.chain.error.notFound')}
                </p>
              ) : (
                <ChainView chain={found} locale={locale} />
              )}
            </StateBoundary>
          )}
        </>
      )}
      <p className="prototype-note">{t('pay.chain.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** The contracts of the chain as options of the picker; the one picked stays in the list even when the chain is cut to it. */
function contractOptions(chain: Chain, picked: string | null): Array<{ id: string; label: string }> {
  const options = nodesOf(chain, 'contract').map((node) => ({ id: node.id, label: node.label }));
  return picked !== null && !options.some((option) => option.id === picked) ? [...options, { id: picked, label: picked }] : options;
}

function ChainView({ chain, locale }: { chain: Chain; locale: string }) {
  const { t } = useTranslation();
  const money = (value: string): string => vndText(value, locale);
  return (
    <>
      <dl className="pay-counts">
        <div>
          <dt>{t('pay.chain.totals.requests')}</dt>
          <dd data-testid="counted-requests">{chain.countedRequests}</dd>
        </div>
        <div>
          <dt>{t('pay.chain.totals.gross')}</dt>
          <dd data-testid="counted-gross">{money(chain.countedGrossVnd)}</dd>
        </div>
        <div>
          <dt>{t('pay.chain.totals.settled')}</dt>
          <dd data-testid="settled-gross">{money(chain.settledGrossVnd)}</dd>
        </div>
      </dl>
      {chain.truncated.length === 0 ? null : (
        <p className="callout warning" role="status" data-testid="truncated">
          {t('pay.chain.truncated', { types: chain.truncated.map((type) => typeLabel(t, type)).join(', ') })}
        </p>
      )}
      {chain.asOf === '' ? null : (
        <p className="sub" data-testid="as-of">
          {t('pay.chain.asOf', { at: instantText(chain.asOf, locale) })}
        </p>
      )}
      {NODE_TYPES.map((type) => (
        <NodeList key={type} chain={chain} type={type} money={money} />
      ))}
    </>
  );
}

function NodeList({ chain, type, money }: { chain: Chain; type: ChainNode['type']; money(value: string): string }) {
  const { t } = useTranslation();
  const nodes = nodesOf(chain, type);
  return (
    <article className="card" aria-label={typeLabel(t, type)} data-type={type}>
      <h2>{typeLabel(t, type)}</h2>
      {nodes.length === 0 ? (
        <p className="sub" data-testid="none">
          {t('pay.chain.type.none')}
        </p>
      ) : (
        <ol className="pay-chain-nodes">
          {nodes.map((node) => (
            <NodeRow key={node.id} chain={chain} node={node} money={money} />
          ))}
        </ol>
      )}
    </article>
  );
}

function NodeRow({ chain, node, money }: { chain: Chain; node: ChainNode; money(value: string): string }) {
  const { t } = useTranslation();
  const target = nodeLink(node);
  const corrects = correctsOf(node);
  const leadsTo = chain.edges.filter((edge) => edge.from === node.id && edge.relation !== 'CORRECTS').length;
  return (
    <li data-node={node.id} data-superseded={node.superseded ? 'yes' : 'no'}>
      <span data-testid="label">{node.label}</span>{' '}
      {node.status === null ? null : (
        <span className={node.superseded ? 'pay-badge warning' : 'pay-badge'} data-testid="status">
          {node.status}
        </span>
      )}{' '}
      <span className="sub" data-testid="version">
        {node.version === null ? t('pay.chain.version.none') : t('pay.chain.version.of', { version: node.version })}
        {node.revision === null ? '' : ` · ${t('pay.chain.revision.of', { revision: node.revision })}`}
      </span>
      {node.superseded ? (
        <span className="pay-badge warning" data-testid="superseded">
          {t('pay.chain.superseded')}
        </span>
      ) : null}
      {node.amountVnd === null ? null : (
        <span className="pay-amount" data-testid="amount">
          {' '}
          {money(node.amountVnd)}
        </span>
      )}
      {corrects === null ? null : (
        <span className="sub" data-testid="corrects">
          {' '}
          {t('pay.chain.corrects')}
        </span>
      )}
      {leadsTo === 0 ? null : (
        <span className="sub" data-testid="leads-to">
          {' '}
          {t('pay.chain.leadsTo', { count: leadsTo })}
        </span>
      )}{' '}
      {target === undefined ? null : (
        <Link to={target} data-testid="open">
          {t('pay.chain.open')}
        </Link>
      )}
    </li>
  );
}
