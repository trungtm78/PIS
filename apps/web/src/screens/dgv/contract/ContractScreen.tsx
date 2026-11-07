import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../components';
import '../dgv.css';
import { NO_FILTER, useCatalog } from '../hooks';
import { changeLabel, compatibilityLabel, decisionLabel, kindLabel, problemMessage, statusLabel } from './labels';
import { useCloseRevision, useDraftRevision, usePublishRevision, useRevision, useRevisions, useVersions } from './hooks';
import { APPROVE_PERMISSION, DECIDE_PERMISSION, DRAFT_PERMISSION, EMPTY_DRAFT, ODCS_VERSIONS, allApproved, describeContractProblem, isDay, openRevision, shortHash, validateDraft } from './model';
import type { DraftField, DraftForm, DraftProblem, Revision } from './model';
import '../dgv-kit.css';
import { StatusPill } from '../../../ui';
import { pillTone } from '../pill-tone';

const NONE = '—';
const holds = (permissions: readonly string[] | undefined, permission: string, mode: string | undefined): boolean =>
  mode !== 'READ_ONLY' && (permissions === undefined || permissions.includes(permission));

/**
 * DGV-13: the data contract of a dataset (ST-DGV-005, DGV 3.1 F2, UAT-AC50): the versions published (each with the hash of its document, its compatibility and whether it still serves), the revision that waits for a decision
 * with the columns and what changed from the published version, the consumers that must approve a breaking change, and the forms to draft the next revision from an ODCS document, to publish it (with the window in which the
 * version before it still serves) and to return or reject it.
 */
export default function ContractScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // A move to another tenant or person starts the screen over: no form of the one is left open for the other.
  return <ContractContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ContractContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const catalogue = useCatalog(NO_FILTER);
  const [chosen, setChosen] = useState('');
  const state = useScreenState({ isLoading: catalogue.isLoading, error: catalogue.error, data: catalogue.data });
  const datasets = catalogue.data ?? [];
  const datasetId = chosen !== '' ? chosen : datasets[0]?.id;
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dgv.contract.title')}</h1>
          <p>{t('dgv.contract.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void catalogue.refetch()}>
        <Field id="contract-dataset" label={t('dgv.contract.dataset')} error={undefined}>
          <select id="contract-dataset" value={datasetId ?? ''} onChange={(event) => setChosen(event.target.value)}>
            {datasets.map((dataset) => (
              <option key={dataset.id} value={dataset.id}>
                {dataset.datasetCode}
              </option>
            ))}
          </select>
        </Field>
        {datasetId === undefined ? null : (
          <DatasetContract
            key={datasetId}
            datasetId={datasetId}
            mayDraft={holds(permissions, DRAFT_PERMISSION, mode)}
            mayPublish={holds(permissions, APPROVE_PERMISSION, mode)}
            mayDecide={holds(permissions, DECIDE_PERMISSION, mode)}
          />
        )}
      </StateBoundary>
      <p className="prototype-note">{t('dgv.contract.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function DatasetContract({ datasetId, mayDraft, mayPublish, mayDecide }: { datasetId: string; mayDraft: boolean; mayPublish: boolean; mayDecide: boolean }) {
  const { t } = useTranslation();
  const revisions = useRevisions({ datasetId });
  const versions = useVersions(datasetId);
  const open = openRevision(revisions.data ?? []);
  const detail = useRevision(open?.id);
  // A dataset with nothing published and nothing in review is a dataset to draft for, not an empty screen: only a read that is not done, or that failed, holds the screen.
  // The revision in review is read whole (its changes and its approvals): the list holds its row only, and the form to publish is not given on a row.
  const state = useScreenState({
    isLoading: revisions.isLoading || versions.isLoading || detail.isLoading,
    error: revisions.error ?? versions.error ?? detail.error,
    data: [revisions.data, versions.data, open === undefined ? true : detail.data],
    isEmpty: () => false,
  });
  return (
    <StateBoundary
      state={state}
      onRetry={() => {
        void revisions.refetch();
        void versions.refetch();
        if (open !== undefined) void detail.refetch();
      }}
    >
      <section className="card" aria-labelledby="versions-title">
        <h2 id="versions-title">{t('dgv.contract.versions.title')}</h2>
        {(versions.data ?? []).length === 0 ? (
          <p className="sub" data-testid="no-versions">
            {t('dgv.contract.versions.none')}
          </p>
        ) : (
          <div className="tablewrap">
            <table className="table" data-testid="versions" aria-label={t('dgv.contract.versions.title')}>
              <thead>
                <tr>
                  <th scope="col">{t('dgv.contract.col.revision')}</th>
                  <th scope="col">{t('dgv.contract.col.compat')}</th>
                  <th scope="col">{t('dgv.contract.col.hash')}</th>
                  <th scope="col">{t('dgv.contract.col.published')}</th>
                  <th scope="col">{t('dgv.contract.col.serving')}</th>
                </tr>
              </thead>
              <tbody>
                {(versions.data ?? []).map((version) => (
                  <tr key={version.id} data-version={version.id} data-serving={version.serving}>
                    <td>{version.revision}</td>
                    <td>{compatibilityLabel(t, version.compatibility)}</td>
                    <td>
                      <code title={version.odcsSha256 ?? ''}>{shortHash(version.odcsSha256)}</code>
                    </td>
                    <td>{version.publishedAt === null ? NONE : version.publishedAt.slice(0, 10)}</td>
                    <td>
                      {version.serving
                        ? version.servingUntil === null
                          ? t('dgv.contract.serving.yes')
                          : t('dgv.contract.serving.until', { day: version.servingUntil })
                        : t('dgv.contract.serving.no')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {open === undefined ? (
        <p className="card" data-testid="no-open">
          {t('dgv.contract.open.none')}
        </p>
      ) : detail.data === undefined ? null : (
        <OpenRevision key={open.id} revision={detail.data} mayPublish={mayPublish} mayDecide={mayDecide} />
      )}
      {mayDraft && open === undefined ? <DraftPanel datasetId={datasetId} /> : null}
    </StateBoundary>
  );
}

function OpenRevision({ revision, mayPublish, mayDecide }: { revision: Revision; mayPublish: boolean; mayDecide: boolean }) {
  const { t } = useTranslation();
  const publish = usePublishRevision();
  const close = useCloseRevision();
  const [windowUntil, setWindowUntil] = useState('');
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);
  const breaking = revision.compatibility === 'BREAKING';
  const waiting = revision.approvals.filter((approval) => approval.decision !== 'APPROVED').length;
  const failure = publish.isError ? describeContractProblem(publish.error) : close.isError ? describeContractProblem(close.error) : undefined;
  const windowProblem = attempted && breaking && !isDay(windowUntil.trim());
  const reasonProblem = attempted && reason.trim() === '';

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setAttempted(true);
    if (publish.isPending || (breaking && !isDay(windowUntil.trim()))) return;
    close.reset();
    publish.mutate({ id: revision.id, version: revision.version, windowUntil: breaking ? windowUntil.trim() : undefined });
  };
  const closeWith = (decision: 'return' | 'reject'): void => {
    setAttempted(true);
    if (close.isPending || reason.trim() === '') return;
    publish.reset();
    close.mutate({ id: revision.id, version: revision.version, decision, reason });
  };

  return (
    <section className="card" aria-labelledby="open-title" data-revision={revision.id} data-compat={revision.compatibility ?? ''}>
      <h2 id="open-title">{t('dgv.contract.open.title', { revision: revision.revision })}</h2>
      <p>
        <span className={`pill ${breaking ? 'red' : 'green'}`} data-testid="compat">
          {compatibilityLabel(t, revision.compatibility)}
        </span>{' '}
        <span className="pill" data-testid="status">
          {statusLabel(t, revision.status)}
        </span>{' '}
        <span className="sub">{t('dgv.contract.open.effective', { day: revision.effectiveFrom ?? NONE, version: revision.odcsVersion ?? NONE })}</span>
      </p>
      {revision.changes.length === 0 ? null : (
        <div data-testid="changes">
          <h3>{t('dgv.contract.changes.title')}</h3>
          <ul>
            {revision.changes.map((change) => (
              <li key={`${change.kind}:${change.object}:${change.column}`} data-breaking={change.breaking}>
                {changeLabel(t, change.kind, change.column)}
              </li>
            ))}
          </ul>
        </div>
      )}
      <h3>{t('dgv.contract.schema.title')}</h3>
      <div className="tablewrap">
        <table className="table" data-testid="schema" aria-label={t('dgv.contract.schema.title')}>
          <thead>
            <tr>
              <th scope="col">{t('dgv.contract.col.object')}</th>
              <th scope="col">{t('dgv.contract.col.column')}</th>
              <th scope="col">{t('dgv.contract.col.type')}</th>
              <th scope="col">{t('dgv.contract.col.required')}</th>
              <th scope="col">{t('dgv.contract.col.key')}</th>
              <th scope="col">{t('dgv.contract.col.class')}</th>
              <th scope="col">{t('dgv.contract.col.unit')}</th>
            </tr>
          </thead>
          <tbody>
            {revision.columns.map((column) => (
              <tr key={`${column.object}.${column.name}`}>
                <td>{column.object}</td>
                <td>{column.name}</td>
                <td>{column.physicalType ?? column.logicalType}</td>
                <td>{column.required ? t('dgv.contract.yes') : t('dgv.contract.no')}</td>
                <td>{column.primaryKey ? t('dgv.contract.yes') : t('dgv.contract.no')}</td>
                <td>{column.classification ?? NONE}</td>
                <td>{column.unit ?? NONE}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {revision.approvals.length === 0 ? null : (
        <>
          <h3>{t('dgv.contract.approvals.title')}</h3>
          <div className="tablewrap">
            <table className="table" data-testid="approvals" aria-label={t('dgv.contract.approvals.title')}>
              <thead>
                <tr>
                  <th scope="col">{t('dgv.contract.col.consumer')}</th>
                  <th scope="col">{t('dgv.contract.col.owner')}</th>
                  <th scope="col">{t('dgv.contract.col.decision')}</th>
                </tr>
              </thead>
              <tbody>
                {revision.approvals.map((approval) => (
                  <tr key={approval.id} data-approval={approval.id} data-decision={approval.decision}>
                    <td>
                      {kindLabel(t, approval.kind)} · <code>{approval.ref}</code>
                    </td>
                    <td>{approval.ownerName ?? approval.ownerId}</td>
                    <td>
                      <StatusPill tone={pillTone(approval.decision === 'APPROVED' ? 'green' : approval.decision === 'REJECTED' ? 'red' : 'gray')}>{decisionLabel(t, approval.decision)}</StatusPill>
                      {approval.comment === null ? null : <p className="sub">{approval.comment}</p>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {allApproved(revision) ? null : (
            <p className="callout warning" role="status" data-testid="waiting">
              {t('dgv.contract.approvals.waiting', { count: waiting })}
            </p>
          )}
        </>
      )}
      {failure === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="refusal" data-reason={failure.reason}>
          {problemMessage(t, failure.reason, failure.detail)}
        </p>
      )}
      {mayPublish || mayDecide ? (
        <form onSubmit={submit} noValidate aria-label={t('dgv.contract.publish.title')}>
          <h3>{t('dgv.contract.publish.title')}</h3>
          {breaking && mayPublish ? (
            <Field id="contract-window" label={t('dgv.contract.window')} hint={t('dgv.contract.window.hint')} error={windowProblem ? t('dgv.contract.window.required') : undefined}>
              <input id="contract-window" type="date" value={windowUntil} aria-invalid={windowProblem} onChange={(event) => setWindowUntil(event.target.value)} />
            </Field>
          ) : null}
          {mayDecide ? (
            <Field id="contract-reason" label={t('dgv.contract.reason')} hint={t('dgv.contract.reason.hint')} error={reasonProblem ? t('dgv.contract.reason.required') : undefined}>
              <input id="contract-reason" value={reason} aria-invalid={reasonProblem} onChange={(event) => setReason(event.target.value)} />
            </Field>
          ) : null}
          <div className="formfooter">
            {mayPublish ? (
              <button type="submit" className="ui-button ui-button--primary" disabled={publish.isPending}>
                {t('dgv.contract.publish.submit')}
              </button>
            ) : null}
            {mayDecide ? (
              <>
                <button type="button" disabled={close.isPending} onClick={() => closeWith('return')}>
                  {t('dgv.contract.return')}
                </button>
                <button type="button" disabled={close.isPending} onClick={() => closeWith('reject')}>
                  {t('dgv.contract.reject')}
                </button>
              </>
            ) : null}
          </div>
        </form>
      ) : null}
    </section>
  );
}

function DraftPanel({ datasetId }: { datasetId: string }) {
  const { t } = useTranslation();
  const send = useDraftRevision();
  const [form, setForm] = useState<DraftForm>(EMPTY_DRAFT);
  const [problems, setProblems] = useState<Partial<Record<DraftField, DraftProblem>>>({});
  const [saved, setSaved] = useState(false);
  const failure = send.isError ? describeContractProblem(send.error) : undefined;
  const set = (patch: Partial<DraftForm>): void => setForm((value) => ({ ...value, ...patch }));
  const message = (problem: DraftProblem | undefined, invalid: string): string | undefined => (problem === undefined ? undefined : problem === 'required' ? t('dgv.contract.draft.required') : invalid);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSaved(false);
    const found = validateDraft(form);
    setProblems(found);
    if (Object.keys(found).length > 0 || send.isPending) return;
    send.mutate(
      { datasetId, form },
      {
        onSuccess: () => {
          setSaved(true);
          setForm(EMPTY_DRAFT);
        },
      },
    );
  };

  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('dgv.contract.draft.title')}>
      <h2>{t('dgv.contract.draft.title')}</h2>
      <p className="sub">{t('dgv.contract.draft.help')}</p>
      {saved ? (
        <p className="callout" role="status" data-testid="saved">
          {t('dgv.contract.draft.saved')}
        </p>
      ) : null}
      {failure === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="draft-refusal" data-reason={failure.reason}>
          {problemMessage(t, failure.reason, failure.detail)}
        </p>
      )}
      <Field id="draft-version" label={t('dgv.contract.draft.version')} error={undefined}>
        <select id="draft-version" value={form.odcsVersion} onChange={(event) => set({ odcsVersion: event.target.value })}>
          {ODCS_VERSIONS.map((version) => (
            <option key={version} value={version}>
              {version}
            </option>
          ))}
        </select>
      </Field>
      <Field id="draft-document" label={t('dgv.contract.draft.document')} hint={t('dgv.contract.draft.document.hint')} error={message(problems.document, t('dgv.contract.draft.json'))}>
        <textarea id="draft-document" rows={10} value={form.document} aria-invalid={problems.document !== undefined} onChange={(event) => set({ document: event.target.value })} />
      </Field>
      <Field id="draft-effective" label={t('dgv.contract.draft.effective')} error={message(problems.effectiveFrom, t('dgv.contract.draft.effective.invalid'))}>
        <input id="draft-effective" type="date" value={form.effectiveFrom} aria-invalid={problems.effectiveFrom !== undefined} onChange={(event) => set({ effectiveFrom: event.target.value })} />
      </Field>
      <div className="formfooter">
        <button type="submit" className="ui-button ui-button--primary" disabled={send.isPending}>
          {t('dgv.contract.draft.submit')}
        </button>
      </div>
    </form>
  );
}
