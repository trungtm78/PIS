import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useCollection, useCollections, useCreateCollection, useIndexItem } from './hooks';
import { classificationLabel, collectionStatusLabel, itemStatusLabel, problemMessage } from './labels';
import { CLASSIFICATIONS, EMPTY_COLLECTION, MANAGE_PERMISSION, describeProblem, validateCollection, versionProblem } from './model';
import type { Classification, Collection, CollectionField, CollectionForm, FormProblem } from './model';

const holds = (permissions: readonly string[] | undefined, permission: string, mode: string | undefined): boolean =>
  mode !== 'READ_ONLY' && (permissions === undefined || permissions.includes(permission));
const SHORT_HASH = 12;

function Field({ id, label, error, hint, children }: { id: string; label: string; error: string | undefined; hint?: string; children: ReactNode }) {
  return (
    <div className="field" data-field={id}>
      <label htmlFor={id}>{label}</label>
      {children}
      {hint === undefined ? null : <small className="sub">{hint}</small>}
      {error === undefined ? null : (
        <small className="error" role="alert">
          {error}
        </small>
      )}
    </div>
  );
}

/**
 * LLM-16: the knowledge collections of the AI gateway and what is indexed into them (ST-LLM-007, LLM.md F6, UAT-AC467): a collection is made for an approved embedding model and the highest classification it takes; a
 * document version that was scanned clean and is not above it is indexed into it. Each item shows the hash of the access list it was indexed under; one whose document carries another list now is marked and is
 * indexed again from here (a widened list takes effect then; a narrowed one takes effect at once).
 */
export default function KnowledgeScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // A move to another tenant or person starts the screen over: no form or collection of the one is left open for the other.
  return <KnowledgeContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function KnowledgeContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const collections = useCollections();
  const [opened, setOpened] = useState<string | undefined>(undefined);
  const state = useScreenState({ isLoading: collections.isLoading, error: collections.error, data: collections.data, isEmpty: () => false });
  const list = collections.data ?? [];
  const mayManage = holds(permissions, MANAGE_PERMISSION, mode);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('llm.knowledge.title')}</h1>
          <p>{t('llm.knowledge.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void collections.refetch()}>
        {mayManage ? <CreatePanel /> : null}
        {list.length === 0 ? (
          <p className="card" data-testid="no-collections">
            {t('llm.knowledge.none')}
          </p>
        ) : (
          <div className="tablewrap">
            <table className="table" data-testid="collections" aria-label={t('llm.knowledge.table')}>
              <thead>
                <tr>
                  <th scope="col">{t('llm.knowledge.col.code')}</th>
                  <th scope="col">{t('llm.knowledge.col.title')}</th>
                  <th scope="col">{t('llm.knowledge.col.module')}</th>
                  <th scope="col">{t('llm.knowledge.col.max')}</th>
                  <th scope="col">{t('llm.knowledge.col.items')}</th>
                  <th scope="col">{t('llm.knowledge.col.status')}</th>
                  <th scope="col">{t('llm.knowledge.col.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((collection) => (
                  <tr key={collection.id} data-collection={collection.id} data-status={collection.status}>
                    <td>
                      <code>{collection.code}</code>
                    </td>
                    <td>{collection.title}</td>
                    <td>{collection.subjectModule}</td>
                    <td>{classificationLabel(t, collection.maxClassification)}</td>
                    <td>{collection.itemCount}</td>
                    <td>
                      <span className={`pill ${collection.status === 'ACTIVE' ? 'green' : 'gray'}`} data-testid="status">
                        {collectionStatusLabel(t, collection.status)}
                      </span>
                    </td>
                    <td>
                      <button type="button" onClick={() => setOpened(collection.id)}>
                        {t('llm.knowledge.open.action', { code: collection.code })}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {opened === undefined ? null : <CollectionPanel key={opened} id={opened} mayManage={mayManage} onClose={() => setOpened(undefined)} />}
      </StateBoundary>
      <p className="prototype-note">{t('llm.knowledge.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function CreatePanel() {
  const { t } = useTranslation();
  const send = useCreateCollection();
  const [form, setForm] = useState<CollectionForm>(EMPTY_COLLECTION);
  const [problems, setProblems] = useState<Partial<Record<CollectionField, FormProblem>>>({});
  const [saved, setSaved] = useState(false);
  const failure = send.isError ? describeProblem(send.error) : undefined;
  const set = (patch: Partial<CollectionForm>): void => setForm((value) => ({ ...value, ...patch }));
  const message = (problem: FormProblem | undefined, invalid: string): string | undefined => (problem === undefined ? undefined : problem === 'required' ? t('llm.knowledge.form.required') : invalid);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSaved(false);
    const found = validateCollection(form);
    setProblems(found);
    if (Object.keys(found).length > 0 || send.isPending) return;
    send.mutate(form, {
      onSuccess: () => {
        setSaved(true);
        setForm(EMPTY_COLLECTION);
      },
    });
  };

  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('llm.knowledge.create.title')}>
      <h2>{t('llm.knowledge.create.title')}</h2>
      <Field id="knowledge-code" label={t('llm.knowledge.col.code')} error={message(problems.code, t('llm.knowledge.create.code.invalid'))}>
        <input id="knowledge-code" value={form.code} aria-invalid={problems.code !== undefined} onChange={(event) => set({ code: event.target.value })} />
      </Field>
      <Field id="knowledge-title" label={t('llm.knowledge.col.title')} error={message(problems.title, t('llm.knowledge.create.title.invalid'))}>
        <input id="knowledge-title" value={form.title} aria-invalid={problems.title !== undefined} onChange={(event) => set({ title: event.target.value })} />
      </Field>
      <Field id="knowledge-module" label={t('llm.knowledge.col.module')} hint={t('llm.knowledge.create.module.hint')} error={message(problems.subjectModule, t('llm.knowledge.create.module.invalid'))}>
        <input id="knowledge-module" value={form.subjectModule} aria-invalid={problems.subjectModule !== undefined} onChange={(event) => set({ subjectModule: event.target.value })} />
      </Field>
      <Field
        id="knowledge-model"
        label={t('llm.knowledge.create.model')}
        hint={t('llm.knowledge.create.model.hint')}
        error={message(problems.embeddingModelId, t('llm.knowledge.create.model.invalid'))}
      >
        <input id="knowledge-model" value={form.embeddingModelId} aria-invalid={problems.embeddingModelId !== undefined} onChange={(event) => set({ embeddingModelId: event.target.value })} />
      </Field>
      <Field id="knowledge-max" label={t('llm.knowledge.col.max')} error={undefined}>
        <select id="knowledge-max" value={form.maxClassification} onChange={(event) => set({ maxClassification: event.target.value as Classification })}>
          {CLASSIFICATIONS.map((classification) => (
            <option key={classification} value={classification}>
              {classificationLabel(t, classification)}
            </option>
          ))}
        </select>
      </Field>
      {failure === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="create-refusal" data-reason={failure.reason}>
          {problemMessage(t, failure)}
        </p>
      )}
      {saved ? (
        <p className="callout" role="status" data-testid="create-saved">
          {t('llm.knowledge.create.saved')}
        </p>
      ) : null}
      <div className="formfooter">
        <button type="submit" className="primary" disabled={send.isPending}>
          {t('llm.knowledge.create.submit')}
        </button>
      </div>
    </form>
  );
}

function CollectionPanel({ id, mayManage, onClose }: { id: string; mayManage: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const detail = useCollection(id);
  const state = useScreenState({ isLoading: detail.isLoading, error: detail.error, data: detail.data, isEmpty: (collection) => collection === undefined });
  return (
    <section className="card" aria-label={t('llm.knowledge.detail.title')} data-testid="collection-detail">
      <div className="heading">
        <h2>{t('llm.knowledge.detail.title')}</h2>
        <button type="button" onClick={onClose}>
          {t('llm.knowledge.detail.close')}
        </button>
      </div>
      <StateBoundary state={state} onRetry={() => void detail.refetch()}>
        {detail.data === undefined ? null : <CollectionDetail collection={detail.data} mayManage={mayManage} />}
      </StateBoundary>
    </section>
  );
}

function CollectionDetail({ collection, mayManage }: { collection: Collection; mayManage: boolean }) {
  const { t } = useTranslation();
  const index = useIndexItem();
  const [version, setVersion] = useState('');
  const [problem, setProblem] = useState<FormProblem | undefined>(undefined);
  const failure = index.isError ? describeProblem(index.error) : undefined;
  const open = mayManage && collection.status === 'ACTIVE';

  const run = (documentVersionId: string): void => {
    const found = versionProblem(documentVersionId);
    setProblem(found);
    if (found !== undefined || index.isPending) return;
    index.mutate({ collectionId: collection.id, documentVersionId }, { onSuccess: () => setVersion('') });
  };

  return (
    <div>
      <dl>
        <div>
          <dt>{t('llm.knowledge.col.status')}</dt>
          <dd data-testid="detail-status">{collectionStatusLabel(t, collection.status)}</dd>
        </div>
        <div>
          <dt>{t('llm.knowledge.create.model')}</dt>
          <dd>
            <code data-testid="detail-model">{collection.embeddingModelId}</code>
          </dd>
        </div>
        <div>
          <dt>{t('llm.knowledge.col.max')}</dt>
          <dd data-testid="detail-max">{classificationLabel(t, collection.maxClassification)}</dd>
        </div>
        <div>
          <dt>{t('llm.knowledge.detail.version')}</dt>
          <dd>{collection.indexVersion}</dd>
        </div>
      </dl>
      <h3>{t('llm.knowledge.detail.items')}</h3>
      {collection.items.length === 0 ? (
        <p data-testid="no-items">{t('llm.knowledge.detail.none')}</p>
      ) : (
        <div className="tablewrap">
          <table className="table" data-testid="items" aria-label={t('llm.knowledge.detail.items')}>
            <thead>
              <tr>
                <th scope="col">{t('llm.knowledge.item.version')}</th>
                <th scope="col">{t('llm.knowledge.item.status')}</th>
                <th scope="col">{t('llm.knowledge.item.chunks')}</th>
                <th scope="col">{t('llm.knowledge.item.class')}</th>
                <th scope="col">{t('llm.knowledge.item.acl')}</th>
                <th scope="col">{t('llm.knowledge.item.at')}</th>
                <th scope="col">{t('llm.knowledge.col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {collection.items.map((item) => (
                <tr key={item.id} data-item={item.id} data-status={item.status} data-stale={item.stale}>
                  <td>
                    <code title={item.documentVersionId}>{item.documentVersionId.slice(0, SHORT_HASH)}</code>
                  </td>
                  <td>
                    <span className={`pill ${item.status === 'INDEXED' ? 'green' : 'gray'}`}>{itemStatusLabel(t, item.status)}</span>
                    {item.stale ? (
                      <span className="pill amber" data-testid="stale">
                        {t('llm.knowledge.item.stale')}
                      </span>
                    ) : null}
                  </td>
                  <td>{item.chunkCount}</td>
                  <td>{item.classification ?? '—'}</td>
                  <td>
                    <code title={item.aclHash} data-testid="acl-hash">
                      {item.aclHash.slice(0, SHORT_HASH)}
                    </code>
                  </td>
                  <td>{item.indexedAt ?? '—'}</td>
                  <td>
                    {open && item.status !== 'REMOVED' ? (
                      <button type="button" disabled={index.isPending} onClick={() => run(item.documentVersionId)}>
                        {t('llm.knowledge.item.reindex', { version: item.documentVersionId.slice(0, SHORT_HASH) })}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            run(version);
          }}
          noValidate
          aria-label={t('llm.knowledge.index.title')}
        >
          <Field
            id={`knowledge-version-${collection.id}`}
            label={t('llm.knowledge.index.version')}
            hint={t('llm.knowledge.index.hint')}
            error={problem === undefined ? undefined : problem === 'required' ? t('llm.knowledge.form.required') : t('llm.knowledge.index.version.invalid')}
          >
            <input id={`knowledge-version-${collection.id}`} value={version} aria-invalid={problem !== undefined} onChange={(event) => setVersion(event.target.value)} />
          </Field>
          {failure === undefined ? null : (
            <p className="callout warning" role="alert" data-testid="index-refusal" data-reason={failure.reason}>
              {problemMessage(t, failure)}
            </p>
          )}
          <div className="formfooter">
            <button type="submit" className="primary" disabled={index.isPending}>
              {t('llm.knowledge.index.submit')}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
