import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { useApiClient } from '../../api/ApiClientContext';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { COMPARE_PERMISSION, blockLines, defaultOther, diffLines, diffRequired, toRevisionDetail } from './templates/compare';
import type { DiffLine, RevisionDetail } from './templates/compare';

type T = Translator['t'];
const LIBRARY_PATH = '/doc/doc-14';
const NONE = '—';

/** One revision of a template with the people behind it: the read of the detail, by id. */
function useRevision(id: string | undefined) {
  const client = useApiClient();
  const tenantId = useSession().tenant?.id;
  return useQuery<RevisionDetail>({
    queryKey: ['doc', 'template-revision', tenantId, id ?? ''],
    queryFn: async () => toRevisionDetail(await client.read('getDocumentTemplate', { path: { id: id ?? '' } })),
    enabled: tenantId !== undefined && id !== undefined,
    retry: false,
  });
}

function changeLabel(t: T, change: DiffLine['change']): string {
  switch (change) {
    case 'same':
      return t('doc.compare.diff.same');
    case 'removed':
      return t('doc.compare.diff.removed');
    case 'added':
      return t('doc.compare.diff.added');
  }
}

/**
 * DOC-15: two revisions of one template side by side (ST-DOC-016, AC-ST-DOC-016-3, UAT-AC423): the content line by line, the placeholders each requires, the legal basis of both and the people who drafted,
 * published and confirmed each. The revision to start from is named in the address (?id=, with ?other= for the other one); without other it is the revision before.
 */
export default function TemplateCompareScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  return <TemplateCompareContent key={tenantId ?? 'none'} route={route} />;
}

function TemplateCompareContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const [params, setParams] = useSearchParams();
  const mayRead = permissions === undefined || permissions.includes(COMPARE_PERMISSION);
  const id = params.get('id') ?? undefined;
  const right = useRevision(mayRead ? id : undefined);
  const otherId = params.get('other') ?? (right.data === undefined ? undefined : defaultOther(right.data.revisions, right.data.id));
  const left = useRevision(mayRead ? otherId : undefined);
  const state = useScreenState({ isLoading: right.isLoading || (otherId !== undefined && left.isLoading), error: right.error ?? left.error, data: right.data, isEmpty: () => false });
  const after = right.data;
  const before = left.data;
  const lines = before === undefined || after === undefined ? [] : diffLines(blockLines(before.blocks), blockLines(after.blocks));
  const schema = before === undefined || after === undefined ? undefined : diffRequired(before.required, after.required);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <p className="back-link">
        <Link to={LIBRARY_PATH}>
          <span aria-hidden="true">← </span>
          {t('doc.compare.back.link')}
        </Link>
      </p>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('doc.compare.page.title')}</h1>
          <p>{t('doc.compare.page.subtitle')}</p>
        </div>
      </div>
      {!mayRead ? (
        <p className="callout warning" role="status" data-testid="no-read">
          {t('doc.compare.read.denied')}
        </p>
      ) : id === undefined ? (
        <p className="callout" role="status" data-testid="no-template">
          {t('doc.compare.none.notice')}{' '}
          <Link to={LIBRARY_PATH}>{t('doc.compare.back.link')}</Link>
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void Promise.all([right.refetch(), left.refetch()])}>
          {after === undefined ? null : (
            <>
              {after.revisions.length < 2 ? null : (
                <div className="card">
                  <div className="field">
                    <label htmlFor="compare-other">{t('doc.compare.other.label')}</label>
                    <select id="compare-other" value={otherId ?? ''} onChange={(event) => setParams({ id: after.id, other: event.target.value })}>
                      {after.revisions
                        .filter((revision) => revision.id !== after.id)
                        .map((revision) => (
                          <option key={revision.id} value={revision.id}>
                            {t('doc.compare.other.option', { revision: revision.revision, status: revision.status })}
                          </option>
                        ))}
                    </select>
                  </div>
                </div>
              )}
              <div className="formgrid" data-testid="revisions">
                {[before, after].map((revision, index) =>
                  revision === undefined ? (
                    <div key="none" className="card" data-side="before">
                      <p className="sub">{t('doc.compare.none.revision')}</p>
                    </div>
                  ) : (
                    <RevisionCard key={revision.id} revision={revision} side={index === 0 ? 'before' : 'after'} />
                  ),
                )}
              </div>
              <section className="card" aria-labelledby="compare-content-title">
                <h2 id="compare-content-title">{t('doc.compare.content.title')}</h2>
                {before === undefined ? (
                  <p className="sub">{t('doc.compare.none.revision')}</p>
                ) : lines.every((line) => line.change === 'same') ? (
                  <p className="sub" data-testid="content-same">
                    {t('doc.compare.content.same')}
                  </p>
                ) : null}
                {before === undefined ? null : (
                  <ol className="history" aria-label={t('doc.compare.content.title')} data-testid="content-diff">
                    {lines.map((line, index) => (
                      <li key={index} data-change={line.change}>
                        <strong>{changeLabel(t, line.change)}</strong> {line.text}
                      </li>
                    ))}
                  </ol>
                )}
              </section>
              <section className="card" aria-labelledby="compare-schema-title">
                <h2 id="compare-schema-title">{t('doc.compare.schema.title')}</h2>
                {schema === undefined ? (
                  <p className="sub">{t('doc.compare.none.revision')}</p>
                ) : (
                  <ul data-testid="schema-diff">
                    <li data-change="added">{t('doc.compare.schema.added', { names: schema.added.length === 0 ? NONE : schema.added.join(', ') })}</li>
                    <li data-change="removed">{t('doc.compare.schema.removed', { names: schema.removed.length === 0 ? NONE : schema.removed.join(', ') })}</li>
                    <li data-change="same">{t('doc.compare.schema.kept', { names: schema.kept.length === 0 ? NONE : schema.kept.join(', ') })}</li>
                  </ul>
                )}
              </section>
            </>
          )}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('doc.compare.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** One side: the revision, its period, its legal basis and the people who drafted, published and confirmed it. */
function RevisionCard({ revision, side }: { revision: RevisionDetail; side: 'before' | 'after' }) {
  const { t } = useTranslation();
  return (
    <div className="card" data-side={side} data-revision={revision.id}>
      <h2>{t('doc.compare.revision.title', { code: revision.templateCode, revision: revision.revision })}</h2>
      <p className="sub">{revision.title}</p>
      <dl>
        <dt>{t('doc.compare.revision.status')}</dt>
        <dd>{revision.status}</dd>
        <dt>{t('doc.compare.revision.period')}</dt>
        <dd>{t('doc.compare.revision.range', { from: revision.effectiveFrom, until: revision.effectiveUntil ?? NONE })}</dd>
        <dt>{t('doc.compare.revision.basis')}</dt>
        <dd data-testid={`basis-${side}`}>{revision.legalBasis}</dd>
        <dt>{t('doc.compare.revision.confirmation')}</dt>
        <dd>
          {revision.confirmationStatus === 'CONFIRMED' ? t('doc.compare.revision.confirmed', { ref: revision.legalConfirmationRef ?? NONE }) : t('doc.compare.revision.pending')}
        </dd>
        <dt>{t('doc.compare.revision.drafter')}</dt>
        <dd data-testid={`drafter-${side}`}>{revision.createdByName ?? NONE}</dd>
        <dt>{t('doc.compare.revision.approver')}</dt>
        <dd data-testid={`approver-${side}`}>{revision.approvedByName ?? NONE}</dd>
        <dt>{t('doc.compare.revision.confirmer')}</dt>
        <dd data-testid={`confirmer-${side}`}>{revision.legalConfirmedByName ?? NONE}</dd>
      </dl>
    </div>
  );
}
