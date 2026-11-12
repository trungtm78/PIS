import { useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { useImportBoq, useBoqLines } from './boq-hooks';
import { faultLabel, fieldLabel, fileProblemMessage, importProblemMessage, modeLabel, roundingLabel } from './boq-labels';
import { BOQ_MANAGE_PERMISSION, DEFAULT_RETENTION_PCT, IMPORT_MODES, decimalText, describeImportProblem, linesOf, prepareFile, reconcile, toImportResult, totalOf } from './boq-model';
import type { BoqLine, ImportMode, ImportResult, PreparedFile, Reconciliation } from './boq-model';
import { BackLink, DefaultContractBar, Fact, StatusBadge } from './components';
import { useContract, useContractChoice } from './hooks';
import { revisionStatusLabel } from './labels';
import { amountText, draftLink } from './model';
import type { ContractView, RevisionLine } from './model';
import './ctr.css';

const NEVER_EMPTY = (): boolean => false;
const LATER_REVISION_STATES: readonly string[] = ['ACTIVE', 'SUSPENDED'];

/** CTR-04: the BOQ of a contract revision (stable items priced per revision, amounts rounded by rule), reconciled with the value of the revision, and its import from a file. */
export default function BoqScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The lines and the form belong to one membership: a switch starts the screen over.
  return <BoqContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function BoqContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  // Opened without a contract in the address (the menu), the largest contract in force is read, and the selector stays to change it.
  const choice = useContractChoice('id');
  const contractId = choice.contractId ?? undefined;
  const contract = useContract(contractId);
  const lines = useBoqLines(contractId);
  const state = useScreenState({
    isLoading: choice.isLoading || contract.isLoading || lines.isLoading,
    error: contract.error ?? lines.error,
    data: contractId === undefined ? undefined : (contract.data ?? undefined),
    isEmpty: NEVER_EMPTY,
  });
  const missing = contractId === undefined || (contract.isSuccess && contract.data === null);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      {contractId === undefined ? null : <BackLink to={draftLink(contractId)}>{t('ctr.back.draft.link')}</BackLink>}
      <DefaultContractBar choice={choice} />
      {choice.isLoading ? (
        <StateBoundary state="loading" />
      ) : missing ? (
        <>
          <div className="heading">
            <h1 id="screen-title">{t('ctr.boq.page.title')}</h1>
          </div>
          <p className="callout warning" role="status" data-testid="no-contract">
            {t('ctr.boq.noContract.notice')}
          </p>
        </>
      ) : (
        <StateBoundary
          state={state}
          onRetry={() => {
            void contract.refetch();
            void lines.refetch();
          }}
        >
          {contract.data === undefined || contract.data === null ? null : <Boq contract={contract.data} lines={lines.data ?? []} requested={params.get('revision') ?? undefined} />}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('ctr.boq.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** The revision the screen opens on: the one asked for, else the draft being worked on, else the latest. */
function pickRevision(revisions: readonly RevisionLine[], requested: string | undefined): RevisionLine | undefined {
  return revisions.find((revision) => revision.id === requested) ?? revisions.find((revision) => revision.status === 'DRAFT') ?? revisions[revisions.length - 1];
}

/**
 * Whether the lines of the revision can be imported now: it is a draft, or a change order that waits for its day (the new prices come in before it takes over), and the contract is in the
 * state that lets that revision be drafted.
 */
function importable(contract: ContractView, revision: RevisionLine): boolean {
  const open = revision.status === 'DRAFT' || (revision.status === 'PENDING_EFFECTIVE' && revision.kind === 'CHANGE_ORDER');
  return open && (revision.kind === 'BASE' ? contract.status === 'DRAFT' : LATER_REVISION_STATES.includes(contract.status));
}

function Boq({ contract, lines, requested }: { contract: ContractView; lines: readonly BoqLine[]; requested: string | undefined }) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState<string | undefined>(requested);
  const revision = pickRevision(contract.revisions, chosen);
  const shown = revision === undefined ? [] : linesOf(lines, revision.id);
  return (
    <>
      <div className="heading">
        <div>
          <h1 id="screen-title">
            {contract.code} · {t('ctr.boq.page.title')}
          </h1>
          <p>
            <StatusBadge status={contract.status} /> {t('ctr.boq.page.subtitle')}
          </p>
        </div>
      </div>
      {revision === undefined ? (
        <p className="callout" role="status" data-testid="no-revision">
          {t('ctr.boq.noRevision.notice')}
        </p>
      ) : (
        <>
          <RevisionPicker revisions={contract.revisions} selected={revision.id} onChange={setChosen} />
          <Reconcile revision={revision} lines={shown} />
          <Grid lines={shown} />
          <ImportPanel contract={contract} revision={revision} />
        </>
      )}
    </>
  );
}

function RevisionPicker({ revisions, selected, onChange }: { revisions: readonly RevisionLine[]; selected: string; onChange: (id: string) => void }) {
  const { t, locale } = useTranslation();
  if (revisions.length < 2) return null;
  return (
    <div className="field ctr-filters">
      <label htmlFor="boq-revision">{t('ctr.boq.revision.label')}</label>
      <select id="boq-revision" value={selected} onChange={(event) => onChange(event.target.value)}>
        {revisions.map((revision) => (
          <option key={revision.id} value={revision.id}>
            {t('ctr.boq.revision.option', { revision: revision.revision, status: revisionStatusLabel(t, revision.status), amount: amountText(revision.amountVnd, locale) })}
          </option>
        ))}
      </select>
    </div>
  );
}

/** BR-CTR-02: the lines of a revision add up to its amount with a difference of zero. The server's total is shown when the answer has it. */
function Reconcile({ revision, lines }: { revision: RevisionLine; lines: readonly BoqLine[] }) {
  const { t, locale } = useTranslation();
  const total = revision.boqTotalVnd ?? totalOf(lines);
  const figures: Reconciliation | undefined = reconcile(revision.amountVnd, total, revision.boqLineCount ?? lines.length);
  return (
    <div className="card" data-testid="reconciliation">
      <h2>{t('ctr.boq.reconcile.title')}</h2>
      <dl className="ctr-facts">
        <Fact label={t('ctr.boq.reconcile.revision')}>
          {t('ctr.boq.revision.name', { revision: revision.revision })} · {revisionStatusLabel(t, revision.status)}
        </Fact>
        <Fact label={t('ctr.boq.reconcile.amount')}>
          <span className="ctr-amount" data-testid="revision-amount">
            {amountText(revision.amountVnd, locale)}
          </span>
        </Fact>
        <Fact label={t('ctr.boq.reconcile.lines')}>
          <span className="ctr-amount" data-testid="lines-total">
            {amountText(total, locale)}
          </span>
        </Fact>
        <Fact label={t('ctr.boq.reconcile.difference')}>
          <span className="ctr-amount" data-testid="difference">
            {figures === undefined ? '' : amountText(figures.difference, locale)}
          </span>
        </Fact>
      </dl>
      {figures === undefined ? null : (
        <p className={figures.matches ? 'ctr-totals ok' : 'ctr-totals bad'} data-testid="reconcile-status" role="status">
          {figures.lineCount === 0 ? t('ctr.boq.reconcile.empty') : figures.matches ? t('ctr.boq.reconcile.ok') : t('ctr.boq.reconcile.bad', { difference: amountText(figures.difference, locale) })}
        </p>
      )}
    </div>
  );
}

function Grid({ lines }: { lines: readonly BoqLine[] }) {
  const { t, locale } = useTranslation();
  const total = totalOf(lines);
  return (
    <div className="card">
      <h2>{t('ctr.boq.grid.title')}</h2>
      {lines.length === 0 ? (
        <p className="callout" role="status" data-testid="no-lines">
          {t('ctr.boq.grid.empty')}
        </p>
      ) : (
        <table className="table" data-testid="boq-grid">
          <thead>
            <tr>
              <th scope="col">{t('ctr.boq.column.item')}</th>
              <th scope="col">{t('ctr.boq.column.unit')}</th>
              <th scope="col">{t('ctr.boq.column.quantity')}</th>
              <th scope="col">{t('ctr.boq.column.price')}</th>
              <th scope="col">{t('ctr.boq.column.amount')}</th>
              <th scope="col">{t('ctr.boq.column.milestone')}</th>
              <th scope="col">{t('ctr.boq.column.retention')}</th>
              <th scope="col">{t('ctr.boq.column.rounding')}</th>
              <th scope="col">{t('ctr.boq.column.member')}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.id} data-testid="boq-row">
                <td>
                  <strong>{line.businessKey}</strong>
                  <br />
                  <span className="sub">{line.description}</span>
                </td>
                <td>{line.unitCode}</td>
                <td className="ctr-amount">{decimalText(line.quantity, locale)}</td>
                <td className="ctr-amount">{decimalText(line.unitPrice, locale)}</td>
                <td className="ctr-amount">{amountText(line.amountVnd, locale)}</td>
                <td>{line.milestoneCode === null ? '' : `${line.milestoneCode}${line.milestoneDueOn === null ? '' : ` · ${line.milestoneDueOn}`}`}</td>
                <td className="ctr-amount">{decimalText(line.retentionPct, locale)}</td>
                <td>{roundingLabel(t, line.roundingRule)}</td>
                <td>{line.partyName ?? ''}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={4}>
                {t('ctr.boq.grid.total')}
              </th>
              <td className="ctr-amount" data-testid="grid-total">
                {amountText(total, locale)}
              </td>
              <td colSpan={4} />
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  );
}

function ImportPanel({ contract, revision }: { contract: ContractView; revision: RevisionLine }) {
  const { t, locale } = useTranslation();
  const { permissions, mode: sessionMode } = useSession();
  const frozen = sessionMode === 'READ_ONLY';
  const allowed = permissions === undefined || permissions.includes(BOQ_MANAGE_PERMISSION);
  const open = importable(contract, revision);
  const editable = open && allowed && !frozen;
  const importBoq = useImportBoq();
  const [mode, setMode] = useState<ImportMode>('REPLACE');
  const [prepared, setPrepared] = useState<PreparedFile | undefined>(undefined);
  const [fileName, setFileName] = useState('');
  const [fileKey, setFileKey] = useState(0);
  const [result, setResult] = useState<ImportResult | undefined>(undefined);
  const problem = importBoq.isError ? describeImportProblem(importBoq.error) : undefined;

  const choose = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    setResult(undefined);
    importBoq.reset();
    if (file === undefined) {
      setPrepared(undefined);
      setFileName('');
      return;
    }
    setFileName(file.name);
    void prepareFile(file, mode).then(setPrepared);
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (importBoq.isPending || !editable || prepared?.body === undefined) return;
    importBoq.mutate(
      { revisionId: revision.id, version: revision.version, body: { ...prepared.body, mode } },
      {
        onSuccess: (answer) => {
          setResult(toImportResult(answer));
          setPrepared(undefined);
          setFileName('');
          setFileKey((current) => current + 1);
        },
      },
    );
  };

  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('ctr.boq.import.title')}>
      <h2>{t('ctr.boq.import.title')}</h2>
      {!editable ? (
        <p className="callout" role="status" data-testid="read-only">
          {frozen ? t('ctr.readOnly.frozen.notice') : !allowed ? t('ctr.readOnly.denied.notice') : revision.status !== 'DRAFT' ? t('ctr.boq.notDraft.notice') : t('ctr.boq.locked.notice')}
        </p>
      ) : (
        <>
          <p className="sub">{t('ctr.boq.import.help')}</p>
          <p className="sub" data-testid="retention-rule">
            {t('ctr.boq.retention.rule', { pct: decimalText(DEFAULT_RETENTION_PCT, locale) })}
          </p>
          <div className="field">
            <label htmlFor="boq-mode">{t('ctr.boq.mode.label')}</label>
            <select id="boq-mode" value={mode} onChange={(event) => setMode(event.target.value as ImportMode)}>
              {IMPORT_MODES.map((option) => (
                <option key={option} value={option}>
                  {modeLabel(t, option)}
                </option>
              ))}
            </select>
            <small className="sub">{mode === 'REPLACE' ? t('ctr.boq.mode.replace.hint') : t('ctr.boq.mode.append.hint')}</small>
          </div>
          <div className="field">
            <label htmlFor="boq-file">{t('ctr.boq.file.label')}</label>
            <input key={fileKey} id="boq-file" type="file" accept=".csv,text/csv" aria-invalid={prepared?.problem !== undefined} aria-describedby={fileName === '' || prepared === undefined ? undefined : 'boq-file-note'} onChange={choose} />
            {fileName === '' || prepared === undefined ? null : prepared.problem === undefined ? (
              <small className="sub" id="boq-file-note" data-testid="file-ready">
                {t('ctr.boq.file.ready', { name: fileName, count: prepared.lineCount })}
              </small>
            ) : (
              <small role="alert" className="field-error" id="boq-file-note" data-testid="file-problem">
                {fileProblemMessage(t, prepared.problem, prepared.column)}
              </small>
            )}
          </div>
        </>
      )}
      {problem === undefined ? null : (
        <div className="callout warning" role="alert" data-testid="problem">
          <p>{importProblemMessage(t, problem, (amount) => amountText(amount, locale))}</p>
          {problem.faults.length === 0 ? null : (
            <table className="table" data-testid="faults">
              <thead>
                <tr>
                  <th scope="col">{t('ctr.boq.faults.row')}</th>
                  <th scope="col">{t('ctr.boq.faults.field')}</th>
                  <th scope="col">{t('ctr.boq.faults.reason')}</th>
                </tr>
              </thead>
              <tbody>
                {problem.faults.map((fault, index) => (
                  <tr key={`${fault.row}:${fault.field}:${index}`} data-testid="fault-row">
                    <td>{fault.row === 0 ? t('ctr.boq.faults.header') : fault.row}</td>
                    <td>{fieldLabel(t, fault.field)}</td>
                    <td>{faultLabel(t, fault.reason)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {problem.faultRows > problem.faults.length && problem.faults.length > 0 ? <p className="sub">{t('ctr.boq.faults.more', { shown: problem.faults.length, total: problem.faultRows })}</p> : null}
        </div>
      )}
      {result === undefined ? null : (
        <div className="callout" role="status" data-testid="result">
          <p>{result.duplicate ? t('ctr.boq.result.duplicate', { count: result.linesImported }) : t('ctr.boq.result.done', { lines: result.linesImported, items: result.itemsCreated })}</p>
          {result.retentionDefaulted > 0 ? (
            <p data-testid="retention-defaulted">{t('ctr.boq.result.retention', { count: result.retentionDefaulted, pct: decimalText(DEFAULT_RETENTION_PCT, locale) })}</p>
          ) : null}
          <p>{result.balanced ? t('ctr.boq.result.balanced') : t('ctr.boq.result.unbalanced', { difference: amountText(result.difference, locale) })}</p>
        </div>
      )}
      {editable ? (
        <div className="formfooter">
          <button type="submit" className="button primary" disabled={importBoq.isPending || prepared?.body === undefined}>
            {importBoq.isPending ? t('ctr.boq.import.pending') : t('ctr.boq.import.action')}
          </button>
        </div>
      ) : null}
    </form>
  );
}
