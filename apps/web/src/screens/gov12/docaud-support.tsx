import { ApiError } from '@machvon/api-client';
import type { ApiClient } from '@machvon/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import { useSession } from '../../session/SessionContext';
import { InfoFormula, StatusPill } from '../../ui';
import type { Tone } from '../../ui';

/** The shared pieces of the DOC, AUD and QMS screens of lane GOV-12: the rights of the caller, a read and a command with their keys, the words of a refusal and the "i" of a figure. */

export type Attempt = ReturnType<AttemptRegistry['forPayload']>;
export type Query = Record<string, string | number | boolean | undefined>;

/** The rights of the caller as the screens know them; a suspended tenant (READ_ONLY) is read-only for everyone. The server still decides. */
export function useRights(): { holds: (permission: string) => boolean; frozen: boolean; membershipId: string | undefined } {
  const { permissions, mode, tenant } = useSession();
  return { holds: (permission) => permissions === undefined || permissions.includes(permission), frozen: mode === 'READ_ONLY', membershipId: tenant?.membershipId };
}

function useScopeKey(): readonly ['gov12da', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['gov12da', tenant?.id, tenant?.membershipId];
}

const clean = (value: Query | undefined): Query => Object.fromEntries(Object.entries(value ?? {}).filter(([, item]) => item !== undefined && item !== ''));

/** One read of the API: the key holds the tenant and the member (what is shown depends on both), the operation and what it was asked. */
export function useRead<T>(operation: string, input: { path?: Record<string, string>; query?: Query } = {}, enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  const parts = { ...(input.path === undefined ? {} : { path: input.path }), ...(input.query === undefined ? {} : { query: clean(input.query) }) };
  return useQuery<T>({
    queryKey: [...key, operation, JSON.stringify(parts)],
    queryFn: () => client.read(operation as never, parts as never) as Promise<T>,
    enabled: key[1] !== undefined && enabled,
    retry: false,
  });
}

export interface PageShape<Item> {
  as_of: string;
  items: Item[];
  has_more: boolean;
}

/**
 * A list read page by page: the first page is an ordinary read, loadMore asks for the next page with the offset of what is already loaded and appends it, and hasMore stays true until the server says there is
 * no more. The pages that were appended belong to the first page they were loaded after: when the first page is read again (a command ended, the filter changed) they are dropped, so a list is never made of two moments.
 */
export function usePagedList<Item>(operation: string, query: Query, pageSize: number, enabled = true) {
  const client = useApiClient();
  const first = useRead<PageShape<Item>>(operation, { query: { ...query, limit: pageSize, offset: 0 } }, enabled);
  const [extra, setExtra] = useState<{ stamp: string; items: Item[]; hasMore: boolean } | undefined>(undefined);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'failed'>('idle');
  const stamp = `${JSON.stringify(clean(query))}:${first.dataUpdatedAt}`;
  const mine = extra !== undefined && extra.stamp === stamp ? extra : undefined;
  const items = [...(first.data?.items ?? []), ...(mine?.items ?? [])];
  const hasMore = mine !== undefined ? mine.hasMore : first.data?.has_more === true;
  const loadMore = async (): Promise<void> => {
    if (phase === 'loading') return;
    setPhase('loading');
    try {
      const page = (await client.read(operation as never, { query: clean({ ...query, limit: pageSize, offset: items.length }) } as never)) as PageShape<Item>;
      setExtra({ stamp, items: [...(mine?.items ?? []), ...page.items], hasMore: page.has_more });
      setPhase('idle');
    } catch {
      setPhase('failed');
    }
  };
  return { first, items, hasMore, loadMore, loading: phase === 'loading', failed: phase === 'failed' };
}

/** The button that loads the next page while the server has more, with the sentence that says how much of the list is shown, and the failure of a page that could not be loaded. */
export function LoadMore({ shown, hasMore, loading, failed, onLoad }: { shown: number; hasMore: boolean; loading: boolean; failed: boolean; onLoad: () => void }) {
  const { t } = useTranslation();
  if (!hasMore && !failed) return null;
  return (
    <div className="g12-more" data-testid="load-more-box">
      {hasMore ? <span className="g12-muted" data-testid="partial-note">{t('gov12da.common.partial.note', { count: shown })}</span> : null}{' '}
      {failed ? <span role="alert">{t('gov12da.common.more.error')}</span> : null}{' '}
      {hasMore ? (
        <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="load-more" disabled={loading} onClick={onLoad}>
          {t('gov12da.common.more.load')}
        </button>
      ) : null}
    </div>
  );
}

/** One command, one idempotency attempt per intention: the key is kept while the same request is retried and dropped when it ends; every read of the screens is refreshed after a success. */
export function useCommand<Input>(send: (client: ApiClient, input: Input, attempt: Attempt) => Promise<unknown>) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(client, input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

/** The one sentence a refused command is answered with; every refusal of these screens has its own words. */
export function refusalText(t: Translator['t'], error: unknown): string {
  const code = error instanceof ApiError ? error.code : 'UNKNOWN';
  switch (code) {
    case 'SELF_APPROVAL_DENIED':
      return t('gov12da.error.selfApproval.text');
    case 'TRANSMITTAL_REQUIRED':
      return t('gov12da.error.transmittalRequired.text');
    case 'TRANSMITTAL_NOT_APPROVED':
      return t('gov12da.error.transmittalNotApproved.text');
    case 'TRANSMITTAL_STATE_INVALID':
      return t('gov12da.error.transmittalState.text');
    case 'TRANSMITTAL_DOCUMENT_CHANGED':
      return t('gov12da.error.documentChanged.text');
    case 'GIFT_OUTCOME_REFUSED':
      return t('gov12da.error.giftOutcome.text');
    case 'GIFT_STATE_INVALID':
      return t('gov12da.error.giftState.text');
    case 'WHISTLE_STATE_INVALID':
      return t('gov12da.error.whistleState.text');
    case 'WHISTLE_HANDLER_INVOLVED':
      return t('gov12da.error.whistleInvolved.text');
    case 'PHOTO_FINDING_STATE_INVALID':
      return t('gov12da.error.photoState.text');
    case 'VERSION_CONFLICT':
      return t('gov12da.error.versionConflict.text');
    case 'SCOPE_DENIED':
      return t('gov12da.error.scope.text');
    case 'RESOURCE_NOT_FOUND':
      return t('gov12da.error.notFound.text');
    case 'VALIDATION_FAILED':
      return t('gov12da.error.validation.text');
    default:
      return t('gov12da.error.generic.text');
  }
}

/** The rule a figure is made with, as the read models carry it: its version (0 is the built-in default) and whether the numbers are still a starting value nobody confirmed. */
export interface RuleView {
  version: number;
  unverified: boolean;
}

export type RuleTopic = 'transmittal' | 'standing' | 'whistle' | 'gift' | 'photo';

/** Day and hour of the Vietnam calendar, `dd/mm/yyyy hh:mm`; the dash for a missing time. */
export function vietnamDateTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || Number.isNaN(Date.parse(iso))) return '–';
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso));
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}`;
}

/** A day `YYYY-MM-DD` written `dd/mm/yyyy`; the dash for none. */
export const vietnamDay = (day: string | null | undefined): string => (day === null || day === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(day) ? '–' : day.split('-').reverse().join('/'));

/** A hash short enough to read in a table, with both ends so two hashes are told apart. */
export const shortHash = (sha: string): string => `${sha.slice(0, 12)}…${sha.slice(-6)}`;

/** Money in whole dong with thousands groups; the text is exact (no number rounding). */
export function dong(value: string | null | undefined): string {
  if (value === null || value === undefined || !/^-?\d+$/.test(value)) return '–';
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

export const word = (value: string): string => value.toLowerCase().replace(/_(\w)/g, (_m, letter: string) => letter.toUpperCase());

/** The "i" of a figure (G0-4): what it is made of, where the numbers come from, the day it is as of, who answers for it and which version of the rule it is; a rule that is a starting value says so. */
export function InfoRule({ topic, name, asOf, rule }: { topic: RuleTopic; name: string; asOf: string; rule: RuleView | undefined }) {
  const { t } = useTranslation();
  const unverified = rule === undefined ? true : rule.unverified;
  const version = rule === undefined || rule.version === 0 ? t('gov12da.info.version.default') : t('gov12da.info.version.number', { n: rule.version });
  return (
    <InfoFormula
      name={name}
      formula={t(`gov12da.rule.${topic}.formula`)}
      source={t('gov12da.info.source.text')}
      asOf={asOf}
      owner={t(`gov12da.rule.${topic}.owner`)}
      version={version}
      unverified={unverified}
      labels={{
        open: t('gov12da.info.label.open', { name }),
        close: t('gov12da.info.label.close'),
        formula: t('gov12da.info.label.formula'),
        numerator: t('gov12da.info.label.numerator'),
        denominator: t('gov12da.info.label.denominator'),
        exclusions: t('gov12da.info.label.exclusions'),
        source: t('gov12da.info.label.source'),
        asOf: t('gov12da.info.label.asOf'),
        owner: t('gov12da.info.label.owner'),
        version: t('gov12da.info.label.version'),
        unverified: t('gov12da.info.label.unverified'),
      }}
    />
  );
}

/** A figure with its name, its value and its "i". */
export function Figure({ label, value, topic, asOf, rule, testId, partial = false }: { label: string; value: string; topic: RuleTopic; asOf: string; rule: RuleView | undefined; testId?: string; partial?: boolean }) {
  const { t } = useTranslation();
  const name = partial ? `${label} ${t('gov12da.common.partial.suffix')}` : label;
  return (
    <div className="g12-figure">
      <span className="g12-figure__label">{name}</span>
      <strong className="g12-figure__value" data-testid={testId}>
        {value}
      </strong>
      <InfoRule topic={topic} name={name} asOf={asOf} rule={rule} />
    </div>
  );
}

export const tone = (state: string, good: readonly string[], bad: readonly string[], warn: readonly string[] = []): Tone => (good.includes(state) ? 'success' : bad.includes(state) ? 'danger' : warn.includes(state) ? 'warning' : 'neutral');

export function Pill({ label, tones }: { label: string; tones: Tone }) {
  return <StatusPill tone={tones}>{label}</StatusPill>;
}

/** A select box of the words of a list, each word looked up under a prefix. */
export function WordSelect({ id, label, labelOf, values, value, onChange, any }: { id: string; label: string; labelOf: (value: string) => string; values: readonly string[]; value: string; onChange: (value: string) => void; any?: string }) {
  return (
    <label className="g12-field" htmlFor={id}>
      {label}
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        {any === undefined ? null : <option value="">{any}</option>}
        {values.map((entry) => (
          <option key={entry} value={entry}>
            {labelOf(entry)}
          </option>
        ))}
      </select>
    </label>
  );
}
