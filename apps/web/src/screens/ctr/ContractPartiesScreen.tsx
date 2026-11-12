import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { BackLink, DefaultContractBar, Field, StatusBadge } from './components';
import { useContract, useContractChoice, useContractorOptions, useReplaceParties } from './hooks';
import { partyProblemMessage, problemMessage, roleLabel } from './labels';
import { PARTY_ROLES, UPDATE_PERMISSION, amountText, describeProblem, draftLink, draftsOf, partiesBody, partyTotals, validateParties } from './model';
import type { ContractView, Option, PartyDraft, PartyRole } from './model';
import './ctr.css';

const NEVER_EMPTY = (): boolean => false;

/** CTR-25: the members of a joint venture, their share of the work and its value, with the sums checked live (the shares add up to 100, the work to the value). */
export default function ContractPartiesScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The editor and the options belong to one membership: a switch starts the screen over.
  return <ContractPartiesContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ContractPartiesContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  // Opened without a contract in the address (the menu), the largest contract in force is read, and the selector stays to change it.
  const choice = useContractChoice('id');
  const contractId = choice.contractId ?? undefined;
  const contract = useContract(contractId);
  const state = useScreenState({ isLoading: contract.isLoading, error: contract.error, data: contractId === undefined ? undefined : (contract.data ?? undefined), isEmpty: NEVER_EMPTY });
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
            <h1 id="screen-title">{t('ctr.parties.page.title')}</h1>
          </div>
          <p className="callout warning" role="status" data-testid="no-contract">
            {t('ctr.parties.noContract.notice')}
          </p>
        </>
      ) : (
        <StateBoundary state={state} onRetry={() => void contract.refetch()}>
          {contract.data === undefined || contract.data === null ? null : <Parties key={contract.data.version} contract={contract.data} />}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('ctr.parties.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Parties({ contract }: { contract: ContractView }) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const contractors = useContractorOptions();
  const replace = useReplaceParties();
  const frozen = mode === 'READ_ONLY';
  const editable = contract.status === 'DRAFT' && contract.isJointVenture && (permissions === undefined || permissions.includes(UPDATE_PERMISSION)) && !frozen;
  const [rows, setRows] = useState<PartyDraft[]>(() => draftsOf(contract));
  const [nextKey, setNextKey] = useState(rows.length);
  const [submitted, setSubmitted] = useState(false);
  const [saved, setSaved] = useState(false);
  const problem = replace.isError ? describeProblem(replace.error) : undefined;
  const totals = partyTotals(rows, contract.contractValueVnd);
  const problems = validateParties(rows);
  const options: Option[] = withMembers(contractors.data ?? [], contract);

  const change = (key: number, patch: Partial<PartyDraft>): void => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
    setSaved(false);
  };
  const add = (): void => {
    setRows((current) => [...current, { key: nextKey, contractorId: '', role: 'MEMBER', sharePct: '', workValueVnd: '' }]);
    setNextKey(nextKey + 1);
    setSaved(false);
  };
  const remove = (key: number): void => {
    setRows((current) => current.filter((row) => row.key !== key));
    setSaved(false);
  };
  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (replace.isPending || !editable) return;
    setSubmitted(true);
    if (problems.size > 0 || !totals.sharesComplete || !totals.workMatchesValue) return;
    replace.mutate({ id: contract.id, version: contract.version, body: partiesBody(rows) }, { onSuccess: () => setSaved(true) });
  };

  return (
    <>
      <div className="heading">
        <div>
          <h1 id="screen-title">
            {contract.code} · {t('ctr.parties.page.title')}
          </h1>
          <p>
            <StatusBadge status={contract.status} /> {t('ctr.parties.page.subtitle', { amount: amountText(contract.contractValueVnd, locale) })}
          </p>
        </div>
      </div>
      {!contract.isJointVenture ? (
        <p className="callout" role="status" data-testid="not-venture">
          {t('ctr.parties.notVenture.notice')}
        </p>
      ) : (
        <form className="card" onSubmit={save} noValidate aria-label={t('ctr.parties.table.title')}>
          <h2>{t('ctr.parties.table.title')}</h2>
          {!editable ? (
            <p className="callout" role="status" data-testid="read-only">
              {frozen ? t('ctr.readOnly.frozen.notice') : contract.status === 'DRAFT' ? t('ctr.readOnly.denied.notice') : t('ctr.parties.notDraft.notice')}
            </p>
          ) : null}
          {problem === undefined ? null : (
            <p className="callout warning" role="alert" data-testid="problem">
              {problemMessage(t, problem)}
            </p>
          )}
          {saved ? (
            <p className="callout" role="status" data-testid="saved">
              {t('ctr.parties.saved.notice')}
            </p>
          ) : null}
          <table className="table" data-testid="parties">
            <thead>
              <tr>
                <th scope="col">{t('ctr.parties.column.contractor')}</th>
                <th scope="col">{t('ctr.parties.column.role')}</th>
                <th scope="col">{t('ctr.parties.column.share')}</th>
                <th scope="col">{t('ctr.parties.column.work')}</th>
                <th scope="col">
                  <span className="ctr-sr-only">{t('ctr.parties.column.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const rowProblem = submitted ? problems.get(row.key) : undefined;
                return (
                  <tr key={row.key} data-testid="party-row">
                    <td>
                      <Field id={`party-${row.key}-contractor`} label={t('ctr.parties.contractor.label', { n: index + 1 })} error={rowProblem === undefined ? undefined : partyProblemMessage(t, rowProblem)}>
                        <select id={`party-${row.key}-contractor`} value={row.contractorId} disabled={!editable} onChange={(event) => change(row.key, { contractorId: event.target.value })}>
                          <option value="">{t('ctr.parties.choose.option')}</option>
                          {options.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </Field>
                    </td>
                    <td>
                      <label htmlFor={`party-${row.key}-role`} className="ctr-sr-only">
                        {t('ctr.parties.role.label', { n: index + 1 })}
                      </label>
                      <select id={`party-${row.key}-role`} value={row.role} disabled={!editable} onChange={(event) => change(row.key, { role: event.target.value as PartyRole })}>
                        {PARTY_ROLES.map((role) => (
                          <option key={role} value={role}>
                            {roleLabel(t, role)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <label htmlFor={`party-${row.key}-share`} className="ctr-sr-only">
                        {t('ctr.parties.share.label', { n: index + 1 })}
                      </label>
                      <input id={`party-${row.key}-share`} inputMode="decimal" value={row.sharePct} disabled={!editable} onChange={(event) => change(row.key, { sharePct: event.target.value })} />
                    </td>
                    <td>
                      <label htmlFor={`party-${row.key}-work`} className="ctr-sr-only">
                        {t('ctr.parties.work.label', { n: index + 1 })}
                      </label>
                      <input id={`party-${row.key}-work`} inputMode="numeric" value={row.workValueVnd} disabled={!editable} onChange={(event) => change(row.key, { workValueVnd: event.target.value })} />
                    </td>
                    <td>
                      {editable && rows.length > 1 ? (
                        <button type="button" className="button" onClick={() => remove(row.key)}>
                          {t('ctr.parties.remove.action', { n: index + 1 })}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="ctr-totals" data-testid="totals">
            <p className={totals.sharesComplete ? 'ok' : 'bad'} data-testid="share-total">
              {totals.share === undefined
                ? t('ctr.parties.total.shareUnknown')
                : totals.sharesComplete
                  ? t('ctr.parties.total.shareOk', { share: totals.share })
                  : t('ctr.parties.total.shareBad', { share: totals.share })}
            </p>
            <p className={totals.workMatchesValue ? 'ok' : 'bad'} data-testid="work-total">
              {totals.work === undefined
                ? t('ctr.parties.total.workUnknown')
                : totals.workMatchesValue
                  ? t('ctr.parties.total.workOk', { amount: amountText(totals.work, locale) })
                  : t('ctr.parties.total.workBad', { amount: amountText(totals.work, locale), value: amountText(contract.contractValueVnd, locale) })}
            </p>
          </div>
          <p className="sub">{t('ctr.parties.rule.text')}</p>
          {editable ? (
            <div className="formfooter">
              <button type="button" className="button" onClick={add} disabled={rows.length >= MAX_ROWS}>
                {t('ctr.parties.add.action')}
              </button>
              <button type="submit" className="button primary" disabled={replace.isPending}>
                {replace.isPending ? t('ctr.parties.submit.pending') : t('ctr.parties.submit.action')}
              </button>
            </div>
          ) : null}
        </form>
      )}
    </>
  );
}

const MAX_ROWS = 20;

/** The contractors to choose from, with the members the contract holds now even when they are no longer on the list (so the select can show them). */
function withMembers(options: readonly Option[], contract: ContractView): Option[] {
  const known = new Set(options.map((option) => option.id));
  const held = [{ id: contract.contractorId, name: contract.contractorName }, ...contract.parties.map((party) => ({ id: party.contractorId, name: party.contractorName }))];
  const extra = held.filter((member, index) => !known.has(member.id) && held.findIndex((other) => other.id === member.id) === index).map((member) => ({ id: member.id, label: member.name ?? member.id }));
  return [...options, ...extra];
}
