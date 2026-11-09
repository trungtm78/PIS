import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../../i18n';
import type { ScreenProps } from '../../../../routes/types';
import { useSession } from '../../../../session/SessionContext';
import { StateBoundary } from '../../../../states/StateBoundary';
import { useScreenState } from '../../../../states/useScreenState';
import { SectionCard, StatusPill } from '../../../../ui';
import { Fact } from '../shared/parts';
import { moneyText } from '../shared/format';
import { DataGuide } from './DataGuide';
import { useEquipmentLine, useUpdateLine } from './hooks';
import { LIST_PATH, MANAGE_PERMISSION, describeProblem, stageTone, validateLink } from './model';
import type { Line } from './model';
import '../shared/shared.css';

/** EQP-02: one line of the equipment procurement: the plan, the package and the result of the choice of contractor, the contract, the payments, and the form that links the package and the contract once each or cancels the line. */
export default function EquipmentDetailScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  return <EquipmentDetailContent key={tenantId ?? 'none'} route={route} />;
}

function EquipmentDetailContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const [params] = useSearchParams();
  const id = params.get('line') ?? undefined;
  const mayManage = (permissions === undefined || permissions.includes(MANAGE_PERMISSION)) && mode !== 'READ_ONLY';
  const found = useEquipmentLine(id);
  const state = useScreenState({ isLoading: found.isLoading, error: found.error, data: found.data === undefined ? undefined : found.data, isEmpty: (data) => data === null });
  const detail = found.data;
  const line = detail?.line;
  const masked = (what: 'CONTRACT' | 'PAYMENT'): boolean => line?.masked.includes(what) === true;
  const money = (value: string | null, what: 'CONTRACT' | 'PAYMENT'): string => (masked(what) ? t('eqp.masked') : moneyText(value, locale));

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="ent2-page">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('eqp.detail.title')}</h1>
          <p>
            <Link to={LIST_PATH}>{t('eqp.detail.back')}</Link>
          </p>
        </div>
      </div>
      <StateBoundary state={id === undefined ? 'empty' : state} onRetry={() => void found.refetch()}>
        {line === undefined || detail === undefined ? null : (
          <>
            <SectionCard title={`${line.code} · ${line.name}`} status={<StatusPill tone={stageTone(line.stage)}>{t(`eqp.stage.${line.stage}`)}</StatusPill>}>
              <dl className="ent2-facts">
                <Fact label={t('eqp.col.project')} testId="fact-project">
                  {line.project.code} · {line.project.name}
                </Fact>
                <Fact label={t('eqp.col.unit')} testId="fact-unit">
                  {line.ownerUnit.name}
                </Fact>
                <Fact label={t('eqp.col.planned')} testId="fact-planned">
                  {moneyText(line.plannedValueVnd, locale)}
                  {line.planRef === null ? '' : ` · ${line.planRef}`}
                </Fact>
                <Fact label={t('eqp.col.package')} testId="fact-package">
                  {line.package === null ? t('eqp.none') : `${line.package.code}${line.package.title === null ? '' : ` · ${line.package.title}`} (${line.package.status})`}
                </Fact>
                <Fact label={t('eqp.detail.external')} testId="fact-external">
                  {line.externalLink === null ? t('eqp.none') : `${line.externalLink.externalCode} (${line.externalLink.diffStatus})`}
                </Fact>
                <Fact label={t('eqp.col.selection')} testId="fact-selection">
                  {line.selection === null ? t('eqp.none') : `${t(`eqp.outcome.${line.selection.outcome}`)} · ${line.selection.status}`}
                </Fact>
                <Fact label={t('eqp.detail.winner')} testId="fact-winner">
                  {line.selection?.winnerName ?? t('eqp.none')}
                </Fact>
                <Fact label={t('eqp.col.contract')} testId="fact-contract">
                  {line.contract === null ? t('eqp.none') : `${line.contract.code} (${line.contract.status})`}
                </Fact>
                <Fact label={t('eqp.detail.contractValue')} testId="fact-contract-value">
                  {money(line.contractValueVnd, 'CONTRACT')}
                </Fact>
                <Fact label={t('eqp.detail.variance')} testId="fact-variance">
                  {money(line.planVarianceVnd, 'CONTRACT')}
                </Fact>
                <Fact label={t('eqp.col.paid')} testId="fact-paid">
                  {money(line.paidVnd, 'PAYMENT')}
                  {line.disbursementPercent === null || masked('PAYMENT') || masked('CONTRACT') ? '' : ` (${line.disbursementPercent}%)`}
                </Fact>
              </dl>
            </SectionCard>
            {mayManage && line.status === 'ACTIVE' ? <ManageCard line={line} /> : null}
            <DataGuide guide={detail.guide} />
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('eqp.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function ManageCard({ line }: { line: Line }) {
  const { t } = useTranslation();
  const update = useUpdateLine();
  const [packageId, setPackageId] = useState('');
  const [contractId, setContractId] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState(false);
  const refused = update.isError ? describeProblem(update.error) : undefined;

  const run = (body: Record<string, string>): void => {
    if (update.isPending) return;
    update.mutate(
      { id: line.id, version: line.version, body },
      {
        onSuccess: () => {
          setSaved(true);
          setPackageId('');
          setContractId('');
          setReason('');
        },
      },
    );
  };
  const link = (event: FormEvent): void => {
    event.preventDefault();
    setSaved(false);
    const found = validateLink({ packageId, contractId }, line);
    setProblem(found);
    if (found !== undefined) return;
    run({ ...(line.package === null && packageId.trim() !== '' ? { package_id: packageId.trim() } : {}), ...(line.contract === null && contractId.trim() !== '' ? { contract_id: contractId.trim() } : {}) });
  };
  const cancel = (): void => {
    setSaved(false);
    if (reason.trim().length < 5) {
      setProblem('reason');
      return;
    }
    setProblem(undefined);
    run({ cancel_reason: reason.trim() });
  };

  return (
    <form className="card" onSubmit={link} noValidate aria-label={t('eqp.manage.aria')}>
      <h2>{t('eqp.manage.title')}</h2>
      <p className="sub">{t('eqp.manage.hint')}</p>
      {refused === undefined ? null : (
        <p className="callout warning" role="alert">
          {t(`eqp.refused.${refused}`)}
        </p>
      )}
      {problem === undefined ? null : (
        <p role="alert" className="field-error">
          {t(`eqp.manage.problem.${problem}`)}
        </p>
      )}
      {line.package === null ? (
        <div className="field">
          <label htmlFor="eqp-package">{t('eqp.manage.package')}</label>
          <input id="eqp-package" value={packageId} onChange={(event) => setPackageId(event.target.value)} />
        </div>
      ) : null}
      {line.contract === null && line.package !== null ? (
        <div className="field">
          <label htmlFor="eqp-contract">{t('eqp.manage.contract')}</label>
          <input id="eqp-contract" value={contractId} onChange={(event) => setContractId(event.target.value)} />
        </div>
      ) : null}
      <div className="actions">
        <button type="submit" className="btn primary" disabled={update.isPending || (line.package !== null && line.contract !== null)}>
          {t('eqp.manage.link')}
        </button>
        {saved ? (
          <span role="status" className="sub">
            {t('eqp.manage.saved')}
          </span>
        ) : null}
      </div>
      <div className="field">
        <label htmlFor="eqp-cancel-reason">{t('eqp.manage.reason')}</label>
        <textarea id="eqp-cancel-reason" rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
      </div>
      <button type="button" className="btn" onClick={cancel} disabled={update.isPending}>
        {t('eqp.manage.cancel')}
      </button>
    </form>
  );
}
