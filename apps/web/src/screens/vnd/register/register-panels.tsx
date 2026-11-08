import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { DataTable, KpiStrip, KpiTile, SectionCard, StatusPill } from '../../../ui';
import { DuplicateDecisionDialog } from '../profile/profile-dialogs';
import { duplicateStatusLabel, signalLabel } from '../shared/vnd-labels';
import { PERMISSION, PATHS, failureStatus, numberText, percentText } from '../shared/vnd-model';
import type { Duplicate } from '../shared/vnd-model';
import { CountInfo, Empty, PolicyInfo, ReceiptNote, StaleNotice, UnverifiedPill, useReceipt, useWriter } from '../shared/vnd-ui';
import { useControlFigures, useDuplicateQueue } from './register-hooks';

const STATES = ['OPEN', 'MERGE_REQUESTED', 'DISMISSED'] as const;

/**
 * The queue of suggestions of duplicate contractors of the whole register (VND-02 across contractors). A duplicate is only a suggestion: a person dismisses it or sends it to the merge of master data, each with a reason,
 * and nothing is merged here. The score has the "i" of the rule `VENDOR_DUPLICATE_SIGNALS` (formula, source, day, version, and the flag when the weights are a starting value nobody confirmed).
 */
export function DuplicateQueue() {
  const { t, locale } = useTranslation();
  const writer = useWriter();
  const [status, setStatus] = useState<string>('OPEN');
  const [deciding, setDeciding] = useState<{ duplicate: Duplicate; decision: 'DISMISSED' | 'MERGE_REQUESTED' } | undefined>(undefined);
  const receipt = useReceipt();
  const query = useDuplicateQueue(status);
  const data = query.data;
  const hidden = data === undefined && failureStatus(query.error) === 403;
  const canDecide = writer.can(PERMISSION.duplicateDecide);
  return (
    <SectionCard title={t('lookahead.vnd.duplicates.title')} status={data?.policy.unverified === true ? <UnverifiedPill /> : undefined}>
      <div data-testid="duplicate-queue">
        <p className="vnd-note">{t('lookahead.vnd.duplicates.note')}</p>
        <label className="vnd-row">
          {t('lookahead.vnd.duplicates.filter')}
          <select value={status} onChange={(event) => setStatus(event.target.value)} data-testid="duplicate-status">
            <option value="">{t('vnd.register.filter.any.option')}</option>
            {STATES.map((state) => (
              <option key={state} value={state}>
                {duplicateStatusLabel(t, state)}
              </option>
            ))}
          </select>
        </label>
        <ReceiptNote text={receipt.receipt} />
        {query.isError && data !== undefined && <StaleNotice onRetry={() => void query.refetch()} />}
        {query.isLoading && (
          <p role="status" aria-busy="true" data-testid="duplicates-loading">
            {t('lookahead.vnd.duplicates.loading')}
          </p>
        )}
        {hidden && (
          <p role="alert" data-testid="duplicates-hidden">
            {t('lookahead.vnd.duplicates.hidden')}
          </p>
        )}
        {query.isError && data === undefined && !hidden && (
          <p role="alert" data-testid="duplicates-error">
            {t('lookahead.vnd.duplicates.error')}{' '}
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void query.refetch()}>
              {t('ui.common.retry')}
            </button>
          </p>
        )}
        {data !== undefined &&
          (data.items.length === 0 ? (
            <Empty text={t('lookahead.vnd.duplicates.empty')} testId="duplicate-queue-empty" />
          ) : (
            <DataTable<Duplicate>
              caption={t('vnd.duplicates.table.caption')}
              rows={data.items}
              rowKey={(row) => row.id}
              rowAttrs={(row) => ({ 'data-duplicate-id': row.id })}
              columns={[
                {
                  key: 'a',
                  header: t('vnd.duplicates.column.a'),
                  pinned: true,
                  render: (row) => (
                    <span className="vnd-stack">
                      <Link to={PATHS.profile(row.contractor_a_id)}>{row.contractor_a_name}</Link>
                      <span className="vnd-days">{row.contractor_a_tax}</span>
                    </span>
                  ),
                },
                {
                  key: 'b',
                  header: t('vnd.duplicates.column.b'),
                  render: (row) => (
                    <span className="vnd-stack">
                      <Link to={PATHS.profile(row.contractor_b_id)}>{row.contractor_b_name}</Link>
                      <span className="vnd-days">{row.contractor_b_tax}</span>
                    </span>
                  ),
                },
                {
                  key: 'score',
                  header: t('vnd.duplicates.column.score'),
                  align: 'right',
                  render: (row) => (
                    <span className="vnd-row">
                      {numberText(row.score, locale)}
                      <PolicyInfo name={t('vnd.duplicates.figure.score.name')} policy={data.policy} />
                    </span>
                  ),
                },
                { key: 'signals', header: t('vnd.duplicates.column.signals'), render: (row) => row.signals.map((signal) => signalLabel(t, signal)).join(', ') },
                {
                  key: 'status',
                  header: t('vnd.duplicates.column.status'),
                  render: (row) => (
                    <span className="vnd-stack">
                      <StatusPill tone={row.status === 'OPEN' ? 'warning' : 'neutral'}>{duplicateStatusLabel(t, row.status)}</StatusPill>
                      {row.decision_reason !== null && <span className="vnd-days">{row.decision_reason}</span>}
                    </span>
                  ),
                },
                {
                  key: 'actions',
                  header: t('vnd.duplicates.column.actions'),
                  render: (row) =>
                    canDecide && row.status === 'OPEN' ? (
                      <span className="vnd-row">
                        <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="queue-dismiss" onClick={() => setDeciding({ duplicate: row, decision: 'DISMISSED' })}>
                          {t('vnd.duplicates.dismiss.action')}
                        </button>
                        <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="queue-merge" onClick={() => setDeciding({ duplicate: row, decision: 'MERGE_REQUESTED' })}>
                          {t('vnd.duplicates.merge.action')}
                        </button>
                      </span>
                    ) : null,
                },
              ]}
            />
          ))}
      </div>
      {deciding !== undefined && (
        <DuplicateDecisionDialog
          duplicate={deciding.duplicate}
          decision={deciding.decision}
          onClose={() => setDeciding(undefined)}
          onDone={() => {
            setDeciding(undefined);
            receipt.show(t('lookahead.vnd.duplicates.receipt'));
          }}
        />
      )}
    </SectionCard>
  );
}

/**
 * The indicators of the controls of contractors (independence, risk grades, performance, bid security and subcontractor payments, VND-07 to VND-12): each is counted now from the records, with the numerator, the
 * denominator, and the "i" that shows its formula, source and day. An indicator whose denominator is zero shows a dash, never zero percent. The read needs the right over the whole tenant: otherwise the panel says so.
 */
export function ControlFigures() {
  const { t, locale } = useTranslation();
  const query = useControlFigures();
  const data = query.data;
  const hidden = data === undefined && failureStatus(query.error) === 403;
  return (
    <SectionCard title={t('lookahead.vnd.controls.title')}>
      <div data-testid="control-figures">
        {hidden && (
          <p role="alert" data-testid="controls-hidden">
            {t('lookahead.vnd.controls.hidden')}
          </p>
        )}
        {query.isError && data === undefined && !hidden && (
          <p role="alert" data-testid="controls-error">
            {t('lookahead.vnd.controls.error')}{' '}
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void query.refetch()}>
              {t('ui.common.retry')}
            </button>
          </p>
        )}
        {query.isError && data !== undefined && <StaleNotice onRetry={() => void query.refetch()} />}
        {query.isLoading && (
          <KpiStrip label={t('lookahead.vnd.controls.label')}>
            <KpiTile label={t('lookahead.vnd.controls.loading')} value="" state="loading" />
            <KpiTile label={t('lookahead.vnd.controls.loading')} value="" state="loading" />
          </KpiStrip>
        )}
        {data !== undefined &&
          (data.indicators.length === 0 ? (
            <Empty text={t('lookahead.vnd.controls.empty')} testId="controls-empty" />
          ) : (
            <KpiStrip label={t('lookahead.vnd.controls.label')}>
              {data.indicators.map((indicator) => (
                <KpiTile
                  key={indicator.code}
                  label={indicator.name}
                  value={indicator.denominator === 0 ? '–' : indicator.pct !== null ? percentText(indicator.pct, locale) : numberText(indicator.numerator, locale)}
                  sub={
                    <span className="vnd-row" data-testid={`control-${indicator.code}`}>
                      <span>{t('lookahead.vnd.controls.sub', { numerator: numberText(indicator.numerator, locale), denominator: numberText(indicator.denominator, locale) })}</span>
                      <CountInfo name={indicator.name} formula={indicator.formula} source={indicator.source} asOf={data.as_of} unverified={indicator.unverified} />
                      {indicator.unverified && <UnverifiedPill />}
                    </span>
                  }
                />
              ))}
            </KpiStrip>
          ))}
      </div>
    </SectionCard>
  );
}
