import { ApiError } from '@machvon/api-client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Navigate, useLocation, useParams } from 'react-router-dom';
import { useApiClient } from '../api/ApiClientContext';
import { useTranslation } from '../i18n';
import { SignInGate } from '../session/oidc/SignInGate';
import { useSession } from '../session/SessionContext';
import { StateBoundary } from '../states/StateBoundary';
import type { ScreenState } from '../states/StateBoundary';
import { NotFound } from './NotFound';
import { routeById } from './registry';

/** The shape of the opaque link of a message to a person (`/d/{document_version_id}`): an id and nothing else. */
const DOCUMENT_VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface DocumentVersionView {
  version: number | undefined;
  mime: string;
  pages: number | undefined;
  classification: string;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const count = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);

function toView(raw: unknown): DocumentVersionView {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return { version: count(record.version), mime: text(record.mime), pages: count(record.page_count), classification: text(record.classification) };
}

function stateOf(error: unknown): ScreenState {
  if (error === null || error === undefined) return 'default';
  if (error instanceof ApiError) {
    if (error.code === 'SESSION_EXPIRED') return 'signedOut';
    // A document that is not there and one the person may not read look the same: the link says nothing about which.
    if (error.status === 403 || error.status === 404) return 'denied';
    if (error.status === 0) return 'offline';
  }
  return 'error';
}

/**
 * The link a message to a person carries for a file or a record (ST-OMNI-005, BR-NOT-11): it names the version of a document and nothing about what it is about. Opening it asks the person to sign in, and the server decides whether
 * they may read it: a document they may not read is shown as refused, not found by this link.
 */
export function DocumentLink() {
  const { id } = useParams();
  const session = useSession();
  const location = useLocation();
  if (id === undefined || !DOCUMENT_VERSION_ID.test(id)) return <NotFound />;
  if (session.status === 'signedOut' && session.signIn !== undefined) return <SignInGate />;
  if (session.tenant === undefined) {
    // A person who is known but has not chosen a tenant yet is sent to choose one, and comes back here (as the screens of the route table do).
    if (session.status === 'identified') return <Navigate to={`${routeById('IAM-04')?.path ?? '/'}?next=${encodeURIComponent(`${location.pathname}${location.search}`)}`} replace />;
    return <StateBoundary state="signedOut" />;
  }
  // What was asked for belongs to this document and this person: another document, or another tenant, starts over.
  return <DocumentVersionCard key={`${session.tenant.id}:${session.tenant.membershipId}:${id.toLowerCase()}`} id={id.toLowerCase()} tenantId={session.tenant.id} membershipId={session.tenant.membershipId} />;
}

function DocumentVersionCard({ id, tenantId, membershipId }: { id: string; tenantId: string; membershipId: string }) {
  const { t } = useTranslation();
  const client = useApiClient();
  const found = useQuery<DocumentVersionView>({
    queryKey: ['doc', 'link', tenantId, membershipId, id],
    queryFn: async () => toView(await client.read('get_resources_document_version_id', { path: { id } })),
    retry: false,
  });
  // The file itself is asked for each time it is opened, with the same session: the server judges the permission and the scan again and gives an address that lasts a few minutes, so a page left open never holds one that has run out.
  const download = useMutation({
    mutationFn: async (): Promise<string> => {
      const body = (await client.read('getDocumentVersionDownload', { path: { id } })) as { url?: unknown } | null;
      if (typeof body?.url !== 'string' || body.url === '') throw new Error('no address');
      return body.url;
    },
  });
  // The window is opened in the click itself, which a browser allows, and sent to the address once the server has given it; a window that could not be opened is replaced by this one.
  const open = (): void => {
    const popup = window.open('', '_blank');
    download.mutate(undefined, {
      onSuccess: (url) => {
        if (popup === null) {
          window.location.assign(url);
          return;
        }
        popup.opener = null;
        popup.location.href = url;
      },
      onError: () => popup?.close(),
    });
  };
  const state: ScreenState = found.isLoading ? 'loading' : stateOf(found.error);
  const view = found.data;
  return (
    <section aria-labelledby="document-link-title" data-document-link>
      <div className="heading">
        <div>
          <h1 id="document-link-title">{t('doc.link.page.title')}</h1>
          <p>{t('doc.link.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void found.refetch()}>
        {view === undefined ? null : (
          <dl className="card" data-document-details>
            <dt>{t('doc.link.field.version')}</dt>
            <dd data-version>{view.version ?? ''}</dd>
            <dt>{t('doc.link.field.mime')}</dt>
            <dd data-mime>{view.mime}</dd>
            <dt>{t('doc.link.field.pages')}</dt>
            <dd data-pages>{view.pages ?? ''}</dd>
            <dt>{t('doc.link.field.classification')}</dt>
            <dd data-classification>{view.classification}</dd>
          </dl>
        )}
        {view === undefined ? null : (
          <div className="card" data-download>
            {download.isError ? (
              <p className="callout warning" role="alert" data-download-problem>
                {t('doc.link.download.failed')}
              </p>
            ) : null}
            <button type="button" className="primary" onClick={open} disabled={download.isPending}>
              {t('doc.link.download.action')}
            </button>
          </div>
        )}
      </StateBoundary>
    </section>
  );
}
