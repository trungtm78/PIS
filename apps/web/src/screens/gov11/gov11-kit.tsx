import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, InfoFormula, KpiTile } from '../../ui';
import type { InfoFormulaLabels } from '../../ui';
import './gov11.css';

/** The rule of a read model as the API writes it: the version that decided, where the numbers come from, and whether nobody confirmed them. */
export interface RuleReading {
  version: number;
  source: 'RULE' | 'DEFAULT';
  unverified: boolean;
  params?: Record<string, unknown>;
  provenance: { formula: string; source: string; as_of: string; legal_status: string } | null;
}

export const asRecord = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
export const asList = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? value.map(asRecord) : []);
export const text = (value: unknown, fallback = '–'): string => (typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : fallback);
export const num = (value: unknown): number => (typeof value === 'number' ? value : typeof value === 'string' && value !== '' && !Number.isNaN(Number(value)) ? Number(value) : 0);

/** Whole dong with thousands separators, from a decimal string; null stays a dash, never zero. */
export function money(value: unknown): string {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return '–';
  const negative = value.startsWith('-');
  const digits = negative ? value.slice(1) : value;
  return `${negative ? '-' : ''}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}

export const percent = (value: unknown): string => (typeof value === 'string' && value !== '' ? `${value}%` : '–');

/** A Vietnam day and time as the person reads it. */
export function stamp(iso: unknown): string | undefined {
  if (typeof iso !== 'string') return undefined;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return undefined;
  const local = new Date(at.getTime() + 7 * 3_600_000).toISOString();
  return `${local.slice(8, 10)}/${local.slice(5, 7)}/${local.slice(0, 4)} ${local.slice(11, 16)}`;
}

export const dayLabel = (day: unknown): string => (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}/.test(day) ? `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}` : '–');

/** The read of one operation, kept per tenant and membership (what a screen shows depends on the places the member reaches). */
export function useGovRead(area: string, operation: string, request: { path?: Record<string, string>; query?: Record<string, string> } | undefined, enabled = true) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Record<string, unknown>>({
    queryKey: ['gov11', area, operation, tenant?.id, tenant?.membershipId, request ?? null],
    queryFn: async () => asRecord(await client.read(operation as never, request as never)),
    enabled: tenant?.id !== undefined && enabled,
    retry: false,
  });
}

export function useInfoLabels(): (name: string) => InfoFormulaLabels {
  const { t } = useTranslation();
  return (name) => ({
    open: t('govc.bi.info.open', { name }),
    close: t('govc.bi.info.close'),
    formula: t('govc.bi.info.formula'),
    numerator: t('govc.bi.info.numerator'),
    denominator: t('govc.bi.info.denominator'),
    exclusions: t('govc.bi.info.exclusions'),
    source: t('govc.bi.info.source'),
    asOf: t('govc.bi.info.asOf'),
    owner: t('govc.bi.info.owner'),
    version: t('govc.bi.info.version'),
    unverified: t('govc.bi.register.unverified'),
  });
}

export interface InfoProps {
  /** The name of the figure. */
  name: string;
  rule: RuleReading | undefined;
  /** What the figure is, in one sentence when the rule carries no formula (a figure that is a plain sum). */
  fallbackFormula: string;
  owner: string;
  asOf: string;
}

/** The "i" of a figure: the formula, the source, the day and the version of the rule it rests on; a default nobody confirmed says so. */
export function Info({ name, rule, fallbackFormula, owner, asOf }: InfoProps) {
  const { t } = useTranslation();
  const labels = useInfoLabels();
  return (
    <InfoFormula
      name={name}
      formula={rule?.provenance?.formula ?? fallbackFormula}
      source={rule?.provenance?.source ?? t('gov11.common.source.record')}
      asOf={rule?.provenance?.as_of ?? asOf}
      owner={owner}
      version={rule === undefined ? t('gov11.common.version.none') : rule.source === 'RULE' ? t('gov11.common.version.approved', { version: rule.version }) : t('gov11.common.version.default')}
      unverified={rule?.unverified ?? false}
      labels={labels(name)}
    />
  );
}

export interface FigureProps extends Omit<InfoProps, 'name'> {
  label: string;
  value: string;
  tone?: 'default' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';
  sub?: ReactNode;
}

/** A tile with its number, and the "i" next to the label: no figure without its definition. */
export function Figure({ label, value, tone, sub, ...info }: FigureProps) {
  return (
    <div className="gov11-figure">
      <KpiTile label={label} value={value} {...(tone === undefined ? {} : { tone })} {...(sub === undefined ? {} : { sub })} />
      <span className="gov11-figure__info">
        <Info name={label} {...info} />
      </span>
    </div>
  );
}

export interface FrameProps extends ScreenProps {
  title: string;
  subtitle: string;
  scope: Array<{ label: string; value: string }>;
  query: { isLoading: boolean; error: unknown; data: Record<string, unknown> | undefined; refetch: () => unknown; isError: boolean };
  /** Whether the read answered but has nothing to show: told apart from a failure. */
  isEmpty?: (data: Record<string, unknown>) => boolean;
  /** Said above the page when a source failed or the rule is a default nobody confirmed. */
  notice?: ReactNode;
  children: (data: Record<string, unknown>) => ReactNode;
}

/** The frame of a screen of this lane: three-layer header, context bar with the freshness, the notice, the states of the kit, and the footer that names the screen. */
export function Frame({ route, title, subtitle, scope, query, isEmpty, notice, children }: FrameProps) {
  const { t } = useTranslation();
  const data = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data, isEmpty: (value) => isEmpty?.(asRecord(value)) ?? false });
  const stale = query.isError && data !== undefined;
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="gov11-page">
      <div className="heading">
        <div>
          <h1 id="screen-title">{title}</h1>
          <p>{subtitle}</p>
        </div>
      </div>
      <ContextBar items={scope} {...(stamp(data?.as_of) === undefined ? {} : { asOf: stamp(data?.as_of) as string })} stale={stale} />
      {stale && (
        <p className="callout" role="status" data-testid="stale-note">
          {t('gov11.common.stale')}
        </p>
      )}
      {notice}
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {data !== undefined && children(data)}
      </StateBoundary>
      <p className="prototype-note">{t('gov11.common.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** The line that says a rule is a starting value nobody confirmed (a legal number): shown on every screen that rests on one. */
export function UnverifiedNote({ rules }: { rules: Array<RuleReading | undefined> }) {
  const { t } = useTranslation();
  if (!rules.some((rule) => rule?.unverified === true)) return null;
  return (
    <p className="callout gov11-unverified" role="note" data-testid="unverified-note">
      {t('gov11.common.unverified')}
    </p>
  );
}

export interface CommandInput {
  path?: Record<string, string>;
  body?: Record<string, unknown>;
  /** The version of the record the person saw: the server refuses the change when it moved (409 VERSION_CONFLICT). */
  version?: number;
}

/** A command of this lane: one idempotency attempt for each intention, the reads of the screen refreshed on success. */
export function useGovCommand(operation: string) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: CommandInput) =>
      client.command(operation as never, { ...(input.path === undefined ? {} : { path: input.path }), body: (input.body ?? {}) as never, ...(input.version === undefined ? {} : { ifMatchVersion: input.version }), attempt: attempts.current.forPayload(input) } as never),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: ['gov11'] });
    },
    onError: (error) => attempts.current.ended(error),
    meta: { tenant: tenant?.id },
  });
}

/** The words of a refusal of a command: its code is shown as the screen's own sentence when the screen has one, else the code. */
export function refusalCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code: unknown }).code === 'string' ? (error as { code: string }).code : undefined;
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PickIdProps extends ScreenProps {
  title: string;
  subtitle: string;
  /** What was typed in the address and is not an identifier: said, not ignored. */
  raw: string;
  onPick: (id: string) => void;
}

/** A screen about one project opens on its identifier; with none (or a bad one) the person is asked for it, and a bad one is named. */
export function PickId({ route, title, subtitle, raw, onPick }: PickIdProps) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState('');
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="gov11-page">
      <div className="heading">
        <div>
          <h1 id="screen-title">{title}</h1>
          <p>{subtitle}</p>
        </div>
      </div>
      <form
        className="gov11-form"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (UUID_PATTERN.test(typed.trim())) onPick(typed.trim());
        }}
      >
        <label>
          {t('gov11.common.pick.label')}
          <input value={typed} onChange={(event) => setTyped(event.target.value)} data-testid="pick-id" aria-invalid={typed !== '' && !UUID_PATTERN.test(typed.trim())} />
        </label>
        <button type="submit" className="ui-button ui-button--primary">
          {t('gov11.common.pick.open')}
        </button>
        {raw !== '' && (
          <p role="alert" data-testid="bad-id">
            {t('gov11.common.pick.bad')}
          </p>
        )}
      </form>
    </section>
  );
}
