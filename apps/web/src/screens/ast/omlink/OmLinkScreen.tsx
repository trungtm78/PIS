import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { usePlanUnits } from '../../cap/plan-hooks';
import { Field } from '../../ctr/components';
import '../../qms/qms.css';
import { useLinkOm, useOmAsset } from './hooks';
import { formProblemMessage, problemMessage } from './labels';
import { READ_PERMISSION, describeProblem, emptyLink, isOperated, linkBody, validateLink } from './model';
import type { LinkForm, OmAsset } from './model';

/**
 * AST-06: the link of a transferred asset to the unit that operates and maintains it (ST-AST-005, AST 3.2, UAT-AC393): the plan of operation, the contract of operation and maintenance, the cycle and the next maintenance. An asset
 * that was not handed to that unit takes no link, and one that has a link takes no second (the screen says so before the server does); the code the asset has in the system of the operator is typed by hand and nothing is synchronised.
 */
export default function OmLinkScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The form belongs to one membership: a switch of tenant or of membership starts the screen over.
  return <OmLinkContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function OmLinkContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [search] = useSearchParams();
  const assetId = search.get('id') ?? undefined;
  const canRead = permissions === undefined || permissions.includes(READ_PERMISSION);
  const asset = useOmAsset(assetId, canRead);
  const state = useScreenState({ isLoading: asset.isLoading, error: asset.error, data: asset.data, isEmpty: (data: unknown) => data === null });
  const view = asset.data ?? undefined;
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ast.omlink.page.title')}</h1>
          <p>
            <Link to="/ast/ast-03">{t('ast.omlink.back.action')}</Link>
          </p>
        </div>
      </div>
      <StateBoundary state={!canRead ? 'denied' : assetId === undefined ? 'empty' : state} onRetry={() => void asset.refetch()}>
        {view === undefined ? null : <Body asset={view} writable={mode !== 'READ_ONLY'} />}
      </StateBoundary>
      <p className="prototype-note">{t('ast.omlink.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Body({ asset, writable }: { asset: OmAsset; writable: boolean }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="card" data-testid="asset">
        <h2>
          <span data-testid="code">{asset.assetCode}</span> {asset.name ?? ''}
        </h2>
        <p>
          <span data-testid="contract">{asset.contractCode}</span> · <span data-testid="unit">{asset.recipientUnit}</span>
        </p>
        <p data-testid="external">
          {asset.externalAssetId === undefined ? t('ast.omlink.external.none') : t('ast.omlink.external.manual', { code: asset.externalAssetId })}
        </p>
      </div>
      {asset.omLink !== undefined ? (
        <div className="card" data-testid="link">
          <h2>{t('ast.omlink.link.title')}</h2>
          <dl>
            <dt>{t('ast.omlink.field.operator')}</dt>
            <dd data-testid="operator">{asset.omLink.operatorUnit}</dd>
            <dt>{t('ast.omlink.field.plan')}</dt>
            <dd data-testid="plan">{asset.omLink.omPlanDocumentVersionId ?? t('ast.omlink.none')}</dd>
            <dt>{t('ast.omlink.field.contract')}</dt>
            <dd data-testid="om-contract">{asset.omLink.omContractId ?? t('ast.omlink.none')}</dd>
            <dt>{t('ast.omlink.field.cycle')}</dt>
            <dd data-testid="cycle">{asset.omLink.maintenanceCycleMonths === undefined ? t('ast.omlink.none') : t('ast.omlink.cycle.months', { months: asset.omLink.maintenanceCycleMonths })}</dd>
            <dt>{t('ast.omlink.field.due')}</dt>
            <dd data-testid="due">{asset.omLink.nextMaintenanceDue ?? t('ast.omlink.none')}</dd>
            <dt>{t('ast.omlink.field.reference')}</dt>
            <dd data-testid="reference">{asset.omLink.externalSystemRef === undefined ? t('ast.omlink.none') : t('ast.omlink.reference.manual', { code: asset.omLink.externalSystemRef })}</dd>
          </dl>
        </div>
      ) : !isOperated(asset) ? (
        <p className="callout warning" role="status" data-testid="not-transferred">
          {t('ast.omlink.notTransferred.notice')}
        </p>
      ) : writable && asset.canLink ? (
        <LinkFormCard asset={asset} />
      ) : (
        <p className="callout" role="status" data-testid="no-right">
          {t('ast.omlink.noRight.notice')}
        </p>
      )}
    </>
  );
}

function LinkFormCard({ asset }: { asset: OmAsset }) {
  const { t } = useTranslation();
  const link = useLinkOm();
  const units = usePlanUnits(true);
  const [form, setForm] = useState<LinkForm>(emptyLink);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateLink(form);
  const shown = (field: keyof LinkForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const set = (patch: Partial<LinkForm>): void => setForm({ ...form, ...patch });
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (link.isPending || Object.keys(problems).length > 0) return;
    link.mutate({ assetId: asset.id, body: linkBody(form) });
  };
  return (
    <form className="card" onSubmit={send} noValidate aria-label={t('ast.omlink.form.aria')} data-testid="link-form">
      {link.isError ? (
        <p className="callout warning" role="alert" data-testid="refusal">
          {problemMessage(t, describeProblem(link.error))}
        </p>
      ) : null}
      {units.isError ? (
        <p className="callout warning" role="status" data-testid="units-failed">
          {t('ast.omlink.units.failed')}
        </p>
      ) : null}
      <Field id="link-operator" label={t('ast.omlink.field.operator')} error={shown('operatorUnitId')}>
        <select id="link-operator" value={form.operatorUnitId} onChange={(event) => set({ operatorUnitId: event.target.value })}>
          <option value="">{t('ast.omlink.operator.choose')}</option>
          {(units.data ?? []).map((unit) => (
            <option key={unit.id} value={unit.id}>
              {unit.name}
            </option>
          ))}
        </select>
      </Field>
      <Field id="link-plan" label={t('ast.omlink.field.plan')} error={shown('documentVersionId')} hint={t('ast.omlink.field.id.hint')}>
        <input id="link-plan" autoComplete="off" value={form.documentVersionId} onChange={(event) => set({ documentVersionId: event.target.value })} />
      </Field>
      <Field id="link-contract" label={t('ast.omlink.field.contract')} error={shown('omContractId')} hint={t('ast.omlink.field.contract.hint')}>
        <input id="link-contract" autoComplete="off" value={form.omContractId} onChange={(event) => set({ omContractId: event.target.value })} />
      </Field>
      <Field id="link-cycle" label={t('ast.omlink.field.cycle')} error={shown('cycle')} hint={t('ast.omlink.field.cycle.hint')}>
        <input id="link-cycle" inputMode="numeric" autoComplete="off" value={form.cycle} onChange={(event) => set({ cycle: event.target.value })} />
      </Field>
      <Field id="link-due" label={t('ast.omlink.field.due')} error={shown('nextDue')} hint={t('ast.omlink.field.due.hint')}>
        <input id="link-due" autoComplete="off" value={form.nextDue} onChange={(event) => set({ nextDue: event.target.value })} />
      </Field>
      <Field id="link-reference" label={t('ast.omlink.field.reference')} error={shown('externalRef')} hint={t('ast.omlink.field.reference.hint')}>
        <input id="link-reference" autoComplete="off" value={form.externalRef} onChange={(event) => set({ externalRef: event.target.value })} />
      </Field>
      <button type="submit" className="primary" disabled={link.isPending}>
        {t('ast.omlink.form.submit')}
      </button>
    </form>
  );
}
