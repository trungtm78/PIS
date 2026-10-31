import { useState } from 'react';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useContractors } from '../hooks';
import '../bid.css';
import { useHistory } from './hooks';
import { describeHistory, isUuid } from './model';
import type { HistoryProblem, HistoryView } from './model';

type T = Translator['t'];

function problemMessage(t: T, problem: HistoryProblem): string {
  switch (problem) {
    case 'notFound':
      return t('bid.history.problem.notFound');
    case 'denied':
      return t('bid.history.problem.denied');
    case 'general':
      return t('bid.history.problem.general');
  }
}

/**
 * The frame of the two screens that read the history of a contractor (ST-BID-013): the contractor is chosen from the register or named by its identifier (also from the address, `?contractor=`), the history is read
 * once, and the screen shows the part of it that is its own. A contractor that is not found and a refusal are told in words.
 */
export default function HistoryFrame({ id, req, title, subtitle, children }: { id: string; req: string; title: string; subtitle: string; children(history: HistoryView): ReactNode }) {
  const { tenant } = useSession();
  // A move to another tenant or person starts the screen over: nothing of the one is left for the other.
  return (
    <FrameContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} id={id} req={req} title={title} subtitle={subtitle}>
      {children}
    </FrameContent>
  );
}

function FrameContent({ id, req, title, subtitle, children }: { id: string; req: string; title: string; subtitle: string; children(history: HistoryView): ReactNode }) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const contractors = useContractors();
  const [chosen, setChosen] = useState(() => params.get('contractor') ?? '');
  const named = chosen.trim().toLowerCase();
  const known = named === '' || isUuid(named);
  const history = useHistory(known ? named : '');
  const state = useScreenState({ isLoading: history.isLoading, error: history.error, data: history.data === null ? undefined : history.data, isEmpty: () => false });
  const refusal = history.isError ? describeHistory(history.error) : 'general';
  const options = contractors.data ?? [];
  return (
    <section data-screen-id={id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{title}</h1>
          <p>{subtitle}</p>
        </div>
      </div>
      <div className="card">
        {options.length === 0 ? null : (
          <div className="field">
            <label htmlFor="history-contractor">{t('bid.history.field.contractor')}</label>
            <select id="history-contractor" value={options.some((option) => option.id === named) ? named : ''} onChange={(event) => setChosen(event.target.value)}>
              <option value="">{t('bid.history.field.contractor.none')}</option>
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.legalName}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="history-contractor-id">{t('bid.history.field.contractorId')}</label>
          <input id="history-contractor-id" type="text" value={chosen} onChange={(event) => setChosen(event.target.value)} />
          <small className="sub">{t('bid.history.field.contractorId.hint')}</small>
          {known ? null : (
            <small role="alert" className="field-error">
              {t('bid.history.field.contractorId.error')}
            </small>
          )}
        </div>
      </div>
      {named === '' || !known ? (
        <p className="callout" role="status" data-testid="no-contractor">
          {t('bid.history.noContractor.notice')}
        </p>
      ) : history.isError && refusal !== 'general' ? (
        <p className="callout warning" role="alert" data-testid="history-refusal">
          {problemMessage(t, refusal)}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void history.refetch()}>
          {history.data == null ? null : children(history.data)}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('bid.history.footer.reference', { id, req })}</p>
    </section>
  );
}
