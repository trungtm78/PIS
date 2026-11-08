import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { ScreenFrame } from './assist-components';
import { useChecklists, useCriteriaSets, usePermit } from './assist-hooks';
import { CONFIG_APPROVE, CONFIG_MANAGE, CONFIG_READ } from './assist-model';
import type { Checklist, CriteriaSet } from './assist-model';
import { ChecklistDialog, CriteriaDialog } from './config-editors';
import { ChecklistDrawer, ChecklistTable, CriteriaDrawer, CriteriaTable, PublishDialog } from './config-tables';
import type { PublishTarget } from './config-tables';

type Tab = 'checklists' | 'criteria';
const TABS: readonly Tab[] = ['checklists', 'criteria'];

/**
 * LLM-26, the checklists of the review of a file and the sets of criteria of the evaluation of a contract (AI.02, AI.04): each is written as a draft by one person and published by another, a published one is locked, and the
 * weights of a set of criteria add up to 10000 basis points before it can be published. The detail of a row is in a drawer; a draft is written in a dialog whose rows follow the rules of the contract.
 */
export default function ConfigScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <ConfigContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

type Dialog = { kind: 'new-checklist' } | { kind: 'new-criteria' } | { kind: 'publish'; target: PublishTarget };
type Drawer = { kind: 'checklist'; row: Checklist } | { kind: 'criteria'; row: CriteriaSet };

function ConfigContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const permit = usePermit();
  const checklists = useChecklists();
  const criteria = useCriteriaSets();
  const [tab, setTab] = useState<Tab>('checklists');
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const [drawer, setDrawer] = useState<Drawer | undefined>(undefined);
  const [receipt, setReceipt] = useState<string | undefined>(undefined);
  const tabButtons = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const allowed = permit.has(CONFIG_READ) || permit.has(CONFIG_MANAGE) || permit.has(CONFIG_APPROVE);
  const asOf = tab === 'checklists' ? checklists.dataUpdatedAt : criteria.dataUpdatedAt;

  const choose = (next: Tab): void => {
    setTab(next);
    tabButtons.current[next]?.focus();
  };
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const at = TABS.indexOf(tab);
    if (event.key === 'ArrowRight') choose(TABS[(at + 1) % TABS.length] ?? 'checklists');
    else if (event.key === 'ArrowLeft') choose(TABS[(at + TABS.length - 1) % TABS.length] ?? 'checklists');
    else if (event.key === 'Home') choose('checklists');
    else if (event.key === 'End') choose('criteria');
    else return;
    event.preventDefault();
  };
  const done = (text: string): void => setReceipt(text);

  return (
    <ScreenFrame
      screenId={route.id}
      title={t('llm.config.page.title')}
      subtitle={t('llm.config.page.subtitle')}
      {...(asOf > 0 ? { asOf: new Date(asOf).toLocaleString('vi-VN') } : {})}
      actions={
        allowed && permit.can(CONFIG_MANAGE) ? (
          <button type="button" className="ui-button ui-button--primary" data-testid="new-button" onClick={() => setDialog({ kind: tab === 'checklists' ? 'new-checklist' : 'new-criteria' })}>
            {tab === 'checklists' ? t('llm.config.checklist.new') : t('llm.config.criteria.new')}
          </button>
        ) : undefined
      }
    >
      {!allowed ? (
        <StateBoundary state="denied" />
      ) : (
        <div className="assist-page">
          <p className="callout" data-testid="config-rule">
            {t('llm.config.page.rule')}
          </p>
          {receipt === undefined ? null : (
            <p className="callout assist-receipt" role="status" data-testid="config-receipt">
              {receipt}
            </p>
          )}
          <div className="assist-tabs" role="tablist" aria-label={t('llm.config.tabs.label')}>
            {TABS.map((entry) => (
              <button
                key={entry}
                type="button"
                role="tab"
                id={`config-tab-${entry}`}
                aria-selected={tab === entry}
                aria-controls={`config-panel-${entry}`}
                tabIndex={tab === entry ? 0 : -1}
                className="assist-tab"
                ref={(element) => {
                  tabButtons.current[entry] = element;
                }}
                onClick={() => setTab(entry)}
                onKeyDown={onTabKey}
              >
                {entry === 'checklists' ? t('llm.config.tab.checklists') : t('llm.config.tab.criteria')}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`config-panel-${tab}`} aria-labelledby={`config-tab-${tab}`} data-testid={`panel-${tab}`}>
            {tab === 'checklists' ? (
              <ChecklistTable
                rows={checklists.data ?? []}
                list={checklists}
                mayPublish={permit.can(CONFIG_APPROVE)}
                onOpen={(row) => setDrawer({ kind: 'checklist', row })}
                onPublish={(row) => setDialog({ kind: 'publish', target: { kind: 'checklist', row } })}
              />
            ) : (
              <CriteriaTable
                rows={criteria.data ?? []}
                list={criteria}
                mayPublish={permit.can(CONFIG_APPROVE)}
                onOpen={(row) => setDrawer({ kind: 'criteria', row })}
                onPublish={(row) => setDialog({ kind: 'publish', target: { kind: 'criteria', row } })}
              />
            )}
          </div>
        </div>
      )}
      {drawer?.kind === 'checklist' ? <ChecklistDrawer row={drawer.row} onClose={() => setDrawer(undefined)} /> : null}
      {drawer?.kind === 'criteria' ? <CriteriaDrawer row={drawer.row} onClose={() => setDrawer(undefined)} /> : null}
      {dialog?.kind === 'new-checklist' ? <ChecklistDialog onClose={() => setDialog(undefined)} onDone={done} /> : null}
      {dialog?.kind === 'new-criteria' ? <CriteriaDialog onClose={() => setDialog(undefined)} onDone={done} /> : null}
      {dialog?.kind === 'publish' ? <PublishDialog target={dialog.target} onClose={() => setDialog(undefined)} onDone={done} /> : null}
    </ScreenFrame>
  );
}
