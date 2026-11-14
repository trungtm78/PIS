import { useId } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';

export interface TabItem<Id extends string = string> {
  id: Id;
  /** The words of the tab, already translated. */
  label: string;
  /** A count beside the words (tasks that wait, open requests); left out when there is none to say. */
  count?: number | undefined;
  /** What the tab shows. Every panel is kept in the page and the ones not chosen are hidden, so a form half filled in one tab is still there when the person comes back. */
  panel: ReactNode;
}

export interface TabsProps<Id extends string = string> {
  tabs: readonly TabItem<Id>[];
  /** The chosen tab; a value no tab has falls back to the first one. */
  value: string;
  onChange: (id: Id) => void;
  /** The accessible name of the row of tabs. */
  label: string;
  /** Prefix of the test ids (`<testId>-tab-<id>`, `<testId>-panel-<id>`). */
  testId?: string;
}

/**
 * Tabs of a screen: one purpose a tab, so a long page becomes a few short ones. A row of tabs (`tablist`) where the arrow keys, Home and End move between tabs and only the chosen one is in the Tab order; each tab
 * owns a panel (`tabpanel`) named by it. The caller keeps the chosen tab, usually in the address (`useTabParam`), so a link or a reload opens the same tab.
 */
export function Tabs<Id extends string = string>({ tabs, value, onChange, label, testId }: TabsProps<Id>) {
  const base = useId();
  const chosen = tabs.find((tab) => tab.id === value) ?? tabs[0];
  if (chosen === undefined) return null;
  const tabId = (id: string): string => `${base}-tab-${id}`;
  const panelId = (id: string): string => `${base}-panel-${id}`;
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const at = tabs.findIndex((tab) => tab.id === chosen.id);
    const target = event.key === 'ArrowRight' ? (at + 1) % tabs.length : event.key === 'ArrowLeft' ? (at + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : undefined;
    const next = target === undefined ? undefined : tabs[target];
    if (next === undefined) return;
    event.preventDefault();
    onChange(next.id);
    document.getElementById(tabId(next.id))?.focus();
  };
  return (
    <div className="ui-tabs" data-testid={testId}>
      <div className="ui-tabs__list" role="tablist" aria-label={label}>
        {tabs.map((tab) => {
          const selected = tab.id === chosen.id;
          return (
            <button key={tab.id} type="button" role="tab" id={tabId(tab.id)} className="ui-tabs__tab" aria-selected={selected} aria-controls={panelId(tab.id)} tabIndex={selected ? 0 : -1} data-testid={testId === undefined ? undefined : `${testId}-tab-${tab.id}`} onClick={() => onChange(tab.id)} onKeyDown={onKeyDown}>
              {tab.label}
              {tab.count === undefined ? null : <span className="ui-tabs__count">{tab.count}</span>}
            </button>
          );
        })}
      </div>
      {tabs.map((tab) => (
        <div key={tab.id} role="tabpanel" id={panelId(tab.id)} className="ui-tabs__panel" aria-labelledby={tabId(tab.id)} hidden={tab.id !== chosen.id} data-testid={testId === undefined ? undefined : `${testId}-panel-${tab.id}`}>
          {tab.panel}
        </div>
      ))}
    </div>
  );
}

/**
 * The chosen tab kept in the address under `name` (`?view=schedule`): the first tab leaves the address clean, the other parameters of the address stay as they are, and the browser history is not filled with one entry
 * a tab (replace).
 */
export function useTabParam<Id extends string>(name: string, ids: readonly Id[]): [Id, (id: Id) => void] {
  const [params, setParams] = useSearchParams();
  const first = ids[0] as Id;
  const asked = params.get(name);
  const value = ids.find((id) => id === asked) ?? first;
  const set = (id: Id): void => {
    const next = new URLSearchParams(params);
    if (id === first) next.delete(name);
    else next.set(name, id);
    setParams(next, { replace: true });
  };
  return [value, set];
}
