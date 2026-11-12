import { Component } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { SectionCard } from '../../../ui';
import type { ProjectView } from '../model';

/** What every tab of the project workspace receives. */
export interface TabProps {
  project: ProjectView;
}

interface QueryLike<T> {
  isLoading: boolean;
  error?: unknown;
  data?: T;
  refetch?: () => unknown;
}

export interface QuerySectionProps<T> {
  title: string;
  query: QueryLike<T>;
  /** True when the data holds nothing to show; the section then says so and keeps its link. */
  isEmpty?: (data: T) => boolean;
  /** Text shown when the data is empty. */
  emptyText: string;
  /** Link to the detailed screen. */
  linkTo?: string;
  linkLabel?: string;
  testId?: string;
  children: (data: T) => ReactNode;
}

/**
 * One independent card of a tab: loading, empty, error and denied (403) are handled here so a section that fails never takes the tab down.
 * The empty state is a short sentence inside the card, not the full-page empty card.
 */
export function QuerySection<T>({ title, query, isEmpty, emptyText, linkTo, linkLabel, testId, children }: QuerySectionProps<T>) {
  const state = useScreenState({ isLoading: query.isLoading, error: query.error, data: query.data, isEmpty: () => false });
  const empty = state === 'default' && query.data !== undefined && isEmpty?.(query.data) === true;
  const link =
    linkTo === undefined || linkLabel === undefined ? undefined : (
      <Link to={linkTo} data-testid={testId === undefined ? undefined : `${testId}-link`}>
        {linkLabel}
      </Link>
    );
  return (
    <SectionCard title={title} actions={link}>
      <div data-testid={testId}>
        {empty ? (
          <p className="callout" role="status">
            {emptyText}
          </p>
        ) : (
          <StateBoundary state={state} onRetry={query.refetch === undefined ? undefined : () => void query.refetch?.()}>
            {query.data === undefined ? null : children(query.data)}
          </StateBoundary>
        )}
      </div>
    </SectionCard>
  );
}

/** A block that points to the detailed screen (used when a tab cannot show a figure itself). */
export function DetailLinkBlock({ title, text, to, label }: { title: string; text: string; to: string; label: string }) {
  return (
    <SectionCard title={title}>
      <p>{text}</p>
      <p>
        <Link to={to}>{label}</Link>
      </p>
    </SectionCard>
  );
}

/** Catches a render failure of one tab so the workspace (and the other tabs) stay usable. */
export class TabBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function TabFallback() {
  const { t } = useTranslation();
  return (
    <p className="callout warning" role="alert" data-testid="tab-failed">
      {t('prj.wsTab.common.failed')}
    </p>
  );
}

export const money = (value: string | number | null | undefined, locale: string): string => {
  if (value === null || value === undefined || value === '') return '–';
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'vi-VN').format(n) : String(value);
};
