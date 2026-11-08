import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import type { ScreenState } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { StatusPill } from '../../../ui';
import RegisterScreen from '../register/RegisterScreen';
import { useProfile, useVendorCommand } from '../shared/vnd-hooks';
import { errorText, verificationLabel } from '../shared/vnd-labels';
import { PATHS, failureStatus, verificationTone, vietnamStamp } from '../shared/vnd-model';
import type { Duplicate, Owner, ProfileView } from '../shared/vnd-model';
import { ReceiptNote, ReadOnlyNote, Screen, ScreenFooter, ScreenHead, StaleNotice, useIdParam, useReceipt, useWriter } from '../shared/vnd-ui';
import { AddOwnerDialog, DeclareNoOwnerDialog, DuplicateDecisionDialog, EditProfileDialog, EndOwnerDialog } from './profile-dialogs';
import { DuplicatesTab, GateTab, IdentityTab, OwnersTab, RestrictionsTab, VenturesTab } from './profile-tabs';

const TABS = ['profile', 'owners', 'duplicates', 'restrictions', 'ventures', 'gate'] as const;
type Tab = (typeof TABS)[number];

type DialogState =
  | { kind: 'edit' }
  | { kind: 'addOwner' }
  | { kind: 'endOwner'; owner: Owner }
  | { kind: 'declare' }
  | { kind: 'duplicate'; duplicate: Duplicate; decision: 'DISMISSED' | 'MERGE_REQUESTED' };

/**
 * VND-02, the profile of one contractor: who they are, the owners and beneficial owners, the check of the tax code, the suggestions of duplicates, the restrictions, cases and events of bid conduct with the bid security factor,
 * the joint ventures and a preview of the gates. Without a contractor in the address the screen is the register, where one is chosen. A command is offered only when the answer says the caller may (`actions.*`).
 */
export default function ProfileScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const id = useIdParam('contractor', 'id');
  const { t } = useTranslation();
  if (id === undefined) {
    return (
      <>
        <p className="callout" data-testid="choose-contractor">
          {t('vnd.profile.choose.text')}
        </p>
        <RegisterScreen route={route} />
      </>
    );
  }
  return <ProfileContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}:${id}`} route={route} id={id} />;
}

function ProfileContent({ route, id }: ScreenProps & { id: string }) {
  const { t } = useTranslation();
  const writer = useWriter();
  const query = useProfile(id);
  const [tab, setTab] = useState<Tab>('profile');
  const [dialog, setDialog] = useState<DialogState | undefined>(undefined);
  const receipt = useReceipt();
  const scan = useVendorCommand('scanVendorDuplicates');
  const [scanFailure, setScanFailure] = useState<unknown>(undefined);
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const view = query.data;
  const base = useScreenState({ isLoading: query.isLoading, error: view === undefined ? query.error : undefined, data: view, isEmpty: () => false });
  const state: ScreenState = view === undefined && failureStatus(query.error) === 404 ? 'empty' : base;
  const refreshFailed = query.isError && view !== undefined;
  const actions = view?.actions;
  const canWrite = !writer.readOnly;

  const done = (what: string): void => {
    setDialog(undefined);
    receipt.show(t('vnd.receipt.done.text', { what, time: vietnamStamp(new Date().toISOString()) }));
  };

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, current: Tab): void => {
    const index = TABS.indexOf(current);
    const next = event.key === 'ArrowRight' ? TABS[(index + 1) % TABS.length] : event.key === 'ArrowLeft' ? TABS[(index + TABS.length - 1) % TABS.length] : event.key === 'Home' ? TABS[0] : event.key === 'End' ? TABS[TABS.length - 1] : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  const tabLabel = (code: Tab): string => {
    switch (code) {
      case 'profile':
        return t('vnd.profile.tab.profile.name');
      case 'owners':
        return t('vnd.profile.tab.owners.name');
      case 'duplicates':
        return t('vnd.profile.tab.duplicates.name');
      case 'restrictions':
        return t('vnd.profile.tab.restrictions.name');
      case 'ventures':
        return t('vnd.profile.tab.ventures.name');
      case 'gate':
        return t('vnd.profile.tab.gate.name');
    }
  };

  const runScan = (current: ProfileView): void => {
    setScanFailure(undefined);
    scan.mutate(
      { path: { id: current.profile.contractor_id } },
      {
        onSuccess: (result) => receipt.show(t('vnd.duplicates.scan.receipt', { count: result.items.length, time: vietnamStamp(new Date().toISOString()) })),
        onError: (error) => setScanFailure(error),
      },
    );
  };

  return (
    <Screen route={route}>
      <ScreenHead
        title={view === undefined ? t('vnd.profile.page.title') : view.profile.legal_name}
        subtitle={t('vnd.profile.page.subtitle')}
        asOf={view?.as_of}
        stale={refreshFailed}
        {...(view === undefined ? {} : { items: [{ label: t('vnd.profile.fact.tax.label'), value: view.profile.tax_identifier }] })}
        actions={
          <>
            <Link className="ui-button ui-button--outline" to={PATHS.register}>
              {t('vnd.profile.back.action')}
            </Link>
            {view !== undefined && (
              <StatusPill tone={verificationTone(view.profile.verification_status)}>{verificationLabel(t, view.profile.verification_status)}</StatusPill>
            )}
          </>
        }
      />
      <ReadOnlyNote show={writer.readOnly} />
      <ReceiptNote text={receipt.receipt} />
      {scanFailure !== undefined && (
        <p className="callout" role="alert" data-testid="scan-error">
          {errorText(t, scanFailure)}
        </p>
      )}
      {refreshFailed && <StaleNotice onRetry={() => void query.refetch()} />}
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {view !== undefined && (
          <div className="vnd-page">
            <div className="vnd-tabs" role="tablist" aria-label={t('vnd.profile.tabs.label')}>
              {TABS.map((code) => (
                <button
                  key={code}
                  type="button"
                  role="tab"
                  id={`vnd-tab-${code}`}
                  aria-selected={tab === code}
                  aria-controls={`vnd-panel-${code}`}
                  tabIndex={tab === code ? 0 : -1}
                  className="vnd-tab"
                  ref={(node) => {
                    tabRefs.current[code] = node;
                  }}
                  onClick={() => setTab(code)}
                  onKeyDown={(event) => onTabKey(event, code)}
                >
                  {tabLabel(code)}
                </button>
              ))}
            </div>
            <div role="tabpanel" id={`vnd-panel-${tab}`} aria-labelledby={`vnd-tab-${tab}`} data-testid={`panel-${tab}`}>
              {tab === 'profile' && <IdentityTab view={view} canEdit={canWrite && actions?.update_profile === true} onEdit={() => setDialog({ kind: 'edit' })} />}
              {tab === 'owners' && (
                <OwnersTab
                  view={view}
                  canManage={canWrite && actions?.manage_owners === true}
                  onAdd={() => setDialog({ kind: 'addOwner' })}
                  onEnd={(owner) => setDialog({ kind: 'endOwner', owner })}
                  onDeclare={() => setDialog({ kind: 'declare' })}
                />
              )}
              {tab === 'duplicates' && (
                <DuplicatesTab
                  view={view}
                  canDecide={canWrite && actions?.decide_duplicates === true}
                  canScan={canWrite && actions?.update_profile === true}
                  scanning={scan.isPending}
                  onScan={() => runScan(view)}
                  onDecide={(duplicate, decision) => setDialog({ kind: 'duplicate', duplicate, decision })}
                />
              )}
              {tab === 'restrictions' && <RestrictionsTab view={view} canPropose={canWrite && actions?.propose_restriction === true} />}
              {tab === 'ventures' && <VenturesTab view={view} />}
              {tab === 'gate' && <GateTab view={view} />}
            </div>
          </div>
        )}
      </StateBoundary>
      {view !== undefined && dialog?.kind === 'edit' && <EditProfileDialog view={view} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.profile.edit.title'))} />}
      {view !== undefined && dialog?.kind === 'addOwner' && <AddOwnerDialog view={view} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.owners.add.title'))} />}
      {view !== undefined && dialog?.kind === 'endOwner' && <EndOwnerDialog view={view} owner={dialog.owner} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.owners.end.title'))} />}
      {view !== undefined && dialog?.kind === 'declare' && <DeclareNoOwnerDialog view={view} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.owners.declare.title'))} />}
      {dialog?.kind === 'duplicate' && (
        <DuplicateDecisionDialog
          duplicate={dialog.duplicate}
          decision={dialog.decision}
          onClose={() => setDialog(undefined)}
          onDone={() => done(dialog.decision === 'DISMISSED' ? t('vnd.duplicates.dismiss.title') : t('vnd.duplicates.merge.title'))}
        />
      )}
      <ScreenFooter route={route} />
    </Screen>
  );
}
