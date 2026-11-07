import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, DataTable, SectionCard } from '../../../ui';
import { FieldValue, VersionPill, periodText } from './components';
import { useDiff, useRule, useVersions } from './hooks';
import type { Translate } from './labels';
import { READ_PERMISSION, isUuid, textParam } from './model';
import type { Change, ChangeKind, DiffEnd } from './model';
import '../adm-kit.css';
import './governance.css';

const KIND: Readonly<Record<ChangeKind, { icon: string }>> = { added: { icon: '＋' }, removed: { icon: '－' }, changed: { icon: '≠' } };

function kindText(t: Translate, kind: ChangeKind): string {
  switch (kind) {
    case 'added':
      return t('gova1.diff.kind.added');
    case 'removed':
      return t('gova1.diff.kind.removed');
    case 'changed':
      return t('gova1.diff.kind.changed');
  }
}

function endText(t: Translate, end: DiffEnd, role: 'from' | 'to'): string {
  if (role === 'to') return t('gova1.diff.end.version', { version: end.version });
  switch (end.source) {
    case 'DEFAULT':
      return t('gova1.diff.end.default');
    case 'NONE':
      return t('gova1.diff.end.none');
    default:
      return t('gova1.diff.end.version', { version: end.version });
  }
}

/**
 * ADM-22: what changed between two versions of a governance rule (G0-1). The version is compared with the one chosen, else with the version before it, else with the default that ships with the platform. Each
 * param that was added, removed or changed is one row with the value before and after (with its unit); the kind of change is a word and a glyph, never colour alone.
 */
export default function RuleDiffScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <DiffContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function DiffContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, permissions } = useSession();
  const [params, setParams] = useSearchParams();
  const rawRule = textParam(params.get('rule'));
  const rawAgainst = textParam(params.get('against'));
  const ruleId = rawRule !== undefined && isUuid(rawRule) ? rawRule : undefined;
  const against = rawAgainst !== undefined && isUuid(rawAgainst) ? rawAgainst : undefined;
  const mayRead = permissions === undefined || permissions.includes(READ_PERMISSION);
  const rule = useRule(mayRead ? ruleId : undefined);
  const versions = useVersions(rule.data?.ruleType, rule.data?.code, rule.data?.unitId ?? undefined, mayRead && rule.data !== undefined && rule.data !== null);
  const diff = useDiff(mayRead ? ruleId : undefined, against);
  const queryState = useScreenState({ isLoading: rule.isLoading || diff.isLoading, error: rule.error ?? diff.error ?? undefined, data: rule.data === undefined || diff.data === undefined ? undefined : { rule: rule.data, diff: diff.data }, isEmpty: () => false });
  const state = mayRead ? queryState : 'denied';
  const view = diff.data ?? undefined;
  const subject = rule.data ?? undefined;
  const others = (versions.data ?? []).filter((version) => version.id !== ruleId);
  const counts = view === undefined ? { added: 0, removed: 0, changed: 0 } : { added: view.changes.filter((c) => c.kind === 'added').length, removed: view.changes.filter((c) => c.kind === 'removed').length, changed: view.changes.filter((c) => c.kind === 'changed').length };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('gova1.diff.title')}</h1>
          <p>{t('gova1.diff.subtitle')}</p>
        </div>
        <nav className="gova1-links" aria-label={t('gova1.links.label')}>
          <Link to="/adm/adm-19" data-testid="link-catalogue">
            {t('gova1.detail.link.catalogue')}
          </Link>
          {subject === undefined ? null : (
            <Link to={`/adm/adm-20?type=${encodeURIComponent(subject.ruleType)}&code=${encodeURIComponent(subject.code)}`} data-testid="link-versions">
              {t('gova1.form.link.versions')}
            </Link>
          )}
        </nav>
      </div>
      <ContextBar
        items={[
          { label: t('gova1.ctx.scope'), value: tenant?.name ?? t('gova1.ctx.scopeAll') },
          ...(subject === undefined ? [] : [{ label: t('gova1.ctx.type'), value: subject.ruleType }, { label: t('gova1.ctx.code'), value: subject.code }]),
        ]}
      />
      {ruleId === undefined ? (
        <p className="gova1-callout" role="status" data-testid="no-target">
          {t('gova1.diff.noTarget')}
        </p>
      ) : (
        <StateBoundary
          state={state}
          onRetry={() => {
            void rule.refetch();
            void diff.refetch();
          }}
        >
          {subject === undefined || view === undefined ? (
            <p className="gova1-callout gova1-callout--error" role="alert" data-testid="missing">
              {t('gova1.diff.missing')}
            </p>
          ) : (
            <>
              <SectionCard title={t('gova1.diff.versions.title')} status={<VersionPill version={subject} />}>
                <dl className="gova1-facts" data-testid="ends">
                  <dt>{t('gova1.diff.from')}</dt>
                  <dd data-testid="from">{endText(t, view.from, 'from')}</dd>
                  <dt>{t('gova1.diff.to')}</dt>
                  <dd data-testid="to">
                    {endText(t, view.to, 'to')} · {periodText(t, subject.effectiveFrom, subject.effectiveTo)}
                  </dd>
                  <dt>{t('gova1.diff.reason')}</dt>
                  <dd>{subject.reason}</dd>
                </dl>
                <div className="gova1-field">
                  <label htmlFor="gova1-against">{t('gova1.diff.against')}</label>
                  <select
                    id="gova1-against"
                    value={against ?? ''}
                    data-testid="against"
                    onChange={(event) => setParams(event.target.value === '' ? { rule: ruleId } : { rule: ruleId, against: event.target.value })}
                  >
                    <option value="">{t('gova1.diff.against.auto')}</option>
                    {others.map((version) => (
                      <option key={version.id} value={version.id}>
                        {t('gova1.diff.against.version', { version: version.version, status: version.status })}
                      </option>
                    ))}
                  </select>
                </div>
              </SectionCard>
              <SectionCard title={t('gova1.diff.changes.title')}>
                <p className="gova1-chips" data-testid="counts">
                  <span>{t('gova1.diff.count.added', { count: counts.added })}</span>
                  <span>{t('gova1.diff.count.removed', { count: counts.removed })}</span>
                  <span>{t('gova1.diff.count.changed', { count: counts.changed })}</span>
                </p>
                {view.changes.length === 0 ? (
                  <p className="gova1-callout" role="status" data-testid="no-changes">
                    {t('gova1.diff.none')}
                  </p>
                ) : (
                  <DataTable<Change>
                    caption={t('gova1.diff.table.caption', { code: subject.code })}
                    rows={view.changes}
                    rowKey={(row) => row.path}
                    rowAttrs={(row) => ({ 'data-change': row.kind, 'data-path': row.path })}
                    columns={[
                      { key: 'path', header: t('gova1.diff.col.param'), pinned: true, render: (row) => <span className="gova1-path">{row.path}</span> },
                      {
                        key: 'kind',
                        header: t('gova1.diff.col.kind'),
                        render: (row) => (
                          <span className={`gova1-change gova1-change--${row.kind}`}>
                            <span aria-hidden="true">{KIND[row.kind].icon} </span>
                            {kindText(t, row.kind)}
                          </span>
                        ),
                      },
                      { key: 'before', header: t('gova1.diff.col.before'), render: (row) => (row.kind === 'added' ? t('gova1.common.absent') : <span className="gova1-before"><FieldValue path={row.path} value={row.before} /></span>) },
                      { key: 'after', header: t('gova1.diff.col.after'), render: (row) => (row.kind === 'removed' ? t('gova1.common.absent') : <FieldValue path={row.path} value={row.after} />) },
                    ]}
                  />
                )}
              </SectionCard>
            </>
          )}
        </StateBoundary>
      )}
      <p className="adm-kit-foot" data-testid="footer">
        {t('gova1.footer.reference', { id: route.id, req: route.req ?? '' })}
      </p>
    </section>
  );
}
