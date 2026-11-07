import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../../prj/components';
import '../../prj/prj.css';
import { QualityPill } from '../components';
import { useDecideProduct, useProducts } from './hooks';
import { CERTIFY_PERMISSION, EMPTY_DECISION, badgeOf, decisionBody, decisionsAfter, describeDecision, hasRunOut, holds, readinessOf, validateDecision } from './model';
import type { Decision, DecisionField, DecisionForm, DecisionProblem, FormProblem, ProductDatasetView, ProductStatus, ProductView, Readiness } from './model';
import '../dgv-kit.css';

type T = Translator['t'];

function problemMessage(t: T, problem: DecisionProblem): string {
  switch (problem) {
    case 'selfApproval':
      return t('dgv.product.problem.selfApproval');
    case 'qualityNotPassed':
      return t('dgv.product.problem.qualityNotPassed');
    case 'contractNotPublished':
      return t('dgv.product.problem.contractNotPublished');
    case 'stale':
      return t('dgv.product.problem.stale');
    case 'stateInvalid':
      return t('dgv.product.problem.stateInvalid');
    case 'scopeDenied':
      return t('dgv.product.problem.scopeDenied');
    case 'notFound':
      return t('dgv.product.problem.notFound');
    case 'validation':
      return t('dgv.product.problem.validation');
    case 'general':
      return t('dgv.product.problem.general');
  }
}

const fieldMessage = (t: T, problem: FormProblem | undefined): string | undefined =>
  problem === undefined ? undefined : problem === 'required' ? t('dgv.product.field.required.error') : t('dgv.product.field.invalid.error');

const readinessText = (t: T, readiness: Readiness): string => (readiness === 'ready' ? t('dgv.product.ready.ready') : readiness === 'blocked' ? t('dgv.product.ready.blocked') : t('dgv.product.ready.unknown'));

function statusText(t: T, status: ProductStatus): string {
  switch (status) {
    case 'NOT_ASSESSED':
      return t('dgv.product.status.notAssessed');
    case 'PROVISIONAL':
      return t('dgv.product.status.provisional');
    case 'CERTIFIED':
      return t('dgv.product.status.certified');
    case 'REVOKED':
      return t('dgv.product.status.revoked');
  }
}

function actionText(t: T, decision: Decision, renewing: boolean): string {
  if (decision === 'CERTIFIED') return renewing ? t('dgv.product.action.renew') : t('dgv.product.action.certify');
  return decision === 'PROVISIONAL' ? t('dgv.product.action.provisional') : t('dgv.product.action.revoke');
}

function formTitle(t: T, decision: Decision): string {
  switch (decision) {
    case 'CERTIFIED':
      return t('dgv.product.form.certify');
    case 'PROVISIONAL':
      return t('dgv.product.form.provisional');
    case 'REVOKED':
      return t('dgv.product.form.revoke');
  }
}

/**
 * DGV-18: the data products and their certification (ST-DGV-009, DGV 3.1 F9, UAT-AC495). Each product shows its status in words, who certified it and until when, and the datasets it is made of with the contract and the
 * quality badge of each, so that what stands in the way of a certification is seen before it is asked for. Somebody who may certify decides on the product, with a reason, evidence and a last day; the server refuses
 * the owner, a dataset with no published contract and one whose latest run did not pass.
 */
export default function ProductsScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // A move to another tenant or person starts the screen over: no form of the one is left open for the other.
  return <ProductsContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ProductsContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const list = useProducts();
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data });
  const mayCertify = holds(permissions, CERTIFY_PERMISSION, mode);
  const [open, setOpen] = useState<{ productId: string; decision: Decision } | undefined>(undefined);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dgv.product.page.title')}</h1>
          <p>{t('dgv.product.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        <div className="grid" data-testid="products">
          {(list.data ?? []).map((product) => (
            <ProductCard key={product.id} product={product} mayCertify={mayCertify} open={open?.productId === product.id ? open.decision : undefined} onOpen={(decision) => setOpen(decision === undefined ? undefined : { productId: product.id, decision })} />
          ))}
        </div>
      </StateBoundary>
      <p className="prototype-note">{t('dgv.product.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function DatasetRow({ dataset }: { dataset: ProductDatasetView }) {
  const { t } = useTranslation();
  return (
    <tr data-dataset={dataset.id}>
      <td>
        <code>{dataset.datasetCode}</code> {dataset.title}
      </td>
      <td>{dataset.contractPublished ? t('dgv.product.dataset.published') : t('dgv.product.dataset.notPublished')}</td>
      <td>
        <QualityPill badge={badgeOf(dataset.qualityBadge)} />
      </td>
    </tr>
  );
}

function ProductCard({ product, mayCertify, open, onOpen }: { product: ProductView; mayCertify: boolean; open: Decision | undefined; onOpen(decision: Decision | undefined): void }) {
  const { t } = useTranslation();
  const ready = readinessOf(product);
  const runOut = hasRunOut(product);
  const decisions = mayCertify ? decisionsAfter(product.status) : [];
  return (
    <article className="card" data-product={product.id} data-status={product.status} aria-label={`${product.code} ${product.title}`}>
      <h2>
        <code>{product.code}</code> {product.title}
      </h2>
      <p>
        <span className={`pill ${product.status === 'CERTIFIED' && !runOut ? 'green' : product.status === 'REVOKED' ? 'red' : product.status === 'NOT_ASSESSED' ? 'gray' : 'warn'}`} data-testid="status">
          {statusText(t, product.status)}
        </span>
      </p>
      {runOut ? (
        <p className="callout warning" role="status" data-testid="run-out">
          {t('dgv.product.runOut.notice', { day: product.expiresOn ?? '' })}
        </p>
      ) : null}
      <dl>
        <div>
          <dt>{t('dgv.product.owner.label')}</dt>
          <dd>{product.owner}</dd>
        </div>
        <div>
          <dt>{t('dgv.product.certifiedBy.label')}</dt>
          <dd data-testid="certified-by">{product.certifiedBy ?? t('dgv.product.none')}</dd>
        </div>
        <div>
          <dt>{t('dgv.product.expires.label')}</dt>
          <dd data-testid="expires">{product.expiresOn ?? t('dgv.product.none')}</dd>
        </div>
        <div>
          <dt>{t('dgv.product.evidence.label')}</dt>
          <dd>{product.evidenceCount}</dd>
        </div>
      </dl>
      {product.revokeReason === null ? null : (
        <p className="callout warning" data-testid="revoke-reason">
          {t('dgv.product.revoked.reason', { reason: product.revokeReason })}
        </p>
      )}
      <div className="tablewrap">
        <table className="table" aria-label={t('dgv.product.datasets.aria', { code: product.code })}>
          <thead>
            <tr>
              <th scope="col">{t('dgv.product.col.dataset')}</th>
              <th scope="col">{t('dgv.product.col.contract')}</th>
              <th scope="col">{t('dgv.product.col.quality')}</th>
            </tr>
          </thead>
          <tbody>
            {product.datasets.map((dataset) => (
              <DatasetRow key={dataset.id} dataset={dataset} />
            ))}
          </tbody>
        </table>
      </div>
      {product.hidden > 0 ? (
        <p className="sub" data-testid="hidden">
          {t('dgv.product.hidden.notice', { count: product.hidden })}
        </p>
      ) : null}
      {product.status === 'REVOKED' ? null : (
        <p className="sub" data-testid="readiness">
          {t('dgv.product.ready.summary', { contract: readinessText(t, ready.contract), quality: readinessText(t, ready.quality) })}
        </p>
      )}
      {decisions.length === 0 ? null : (
        <div className="formfooter">
          {decisions.map((decision) => (
            <button key={decision} type="button" aria-pressed={open === decision} onClick={() => onOpen(open === decision ? undefined : decision)}>
              {actionText(t, decision, product.status === 'CERTIFIED')}
            </button>
          ))}
        </div>
      )}
      {open === undefined ? null : <DecisionPanel key={open} product={product} decision={open} onDone={() => onOpen(undefined)} />}
    </article>
  );
}

function DecisionPanel({ product, decision, onDone }: { product: ProductView; decision: Decision; onDone(): void }) {
  const { t } = useTranslation();
  const send = useDecideProduct();
  const [form, setForm] = useState<DecisionForm>(EMPTY_DECISION);
  const [problems, setProblems] = useState<Partial<Record<DecisionField, FormProblem>>>({});
  const refusal = send.isError ? describeDecision(send.error) : undefined;
  const set = (patch: Partial<DecisionForm>): void => setForm((value) => ({ ...value, ...patch }));
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found = validateDecision(decision, form);
    setProblems(found);
    if (Object.keys(found).length > 0 || send.isPending) return;
    send.mutate({ id: product.id, version: product.version, body: decisionBody(decision, form) }, { onSuccess: onDone });
  };
  const id = `${product.id}-${decision}`;
  return (
    <form className="card" onSubmit={submit} noValidate aria-label={formTitle(t, decision)}>
      <h3>{formTitle(t, decision)}</h3>
      {refusal === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="decision-refusal">
          {problemMessage(t, refusal)}
        </p>
      )}
      <Field id={`${id}-reason`} label={t('dgv.product.field.reason.label')} error={fieldMessage(t, problems.reason)} hint={t('dgv.product.field.reason.hint')}>
        <textarea id={`${id}-reason`} rows={3} value={form.reason} onChange={(event) => set({ reason: event.target.value })} />
      </Field>
      {decision === 'REVOKED' ? null : (
        <Field id={`${id}-evidence`} label={t('dgv.product.field.evidence.label')} error={fieldMessage(t, problems.evidence)} hint={decision === 'CERTIFIED' ? t('dgv.product.field.evidence.hint') : t('dgv.product.field.evidence.optional')}>
          <textarea id={`${id}-evidence`} rows={3} value={form.evidence} onChange={(event) => set({ evidence: event.target.value })} />
        </Field>
      )}
      {decision === 'CERTIFIED' ? (
        <Field id={`${id}-expires`} label={t('dgv.product.field.expires.label')} error={fieldMessage(t, problems.expiresOn)} hint={t('dgv.product.field.expires.hint')}>
          <input id={`${id}-expires`} type="date" value={form.expiresOn} onChange={(event) => set({ expiresOn: event.target.value })} />
        </Field>
      ) : null}
      <div className="formfooter">
        <button type="submit" className="ui-button ui-button--primary" disabled={send.isPending}>
          {t('dgv.product.form.submit.action')}
        </button>
        <button type="button" onClick={onDone}>
          {t('dgv.product.form.cancel.action')}
        </button>
      </div>
    </form>
  );
}
