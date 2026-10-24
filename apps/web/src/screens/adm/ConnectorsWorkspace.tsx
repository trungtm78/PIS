import { useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from '../../i18n';
import type { WebRoute } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { adapterLabel } from '../mdm/labels';
import { useCreateConnector, useMoveConnector } from './connectors/hooks';
import { adapterPill, connectorStatusLabel, connectorStatusPill, fieldMessage, modeLabel, problemMessage } from './connectors/labels';
import {
  ADAPTER_STATUSES,
  CONNECTOR_MODES,
  EMPTY_CONNECTOR,
  MANAGE_CONNECTOR_PERMISSION,
  REASON_MAX_LENGTH,
  REASON_MIN_LENGTH,
  connectorBody,
  describeProblem,
  inRegisterOrder,
  mayBeActive,
  validateConnector,
} from './connectors/model';
import type { ConnectorErrors, ConnectorField, ConnectorMode, ConnectorStatus, ConnectorValues, ConnectorView } from './connectors/model';
import type { AdapterStatus } from '../mdm/model';
import './connectors/connectors.css';

export interface ConnectorsWorkspaceProps {
  route: WebRoute;
  /** The connectors of the tenant, as the register read returns them. */
  connectors: readonly ConnectorView[];
}

interface FieldProps {
  id: string;
  label: string;
  error: string | undefined;
  hint?: string;
  children: ReactNode;
}

function Field({ id, label, error, hint, children }: FieldProps) {
  return (
    <div className="field" data-field={id}>
      <label htmlFor={id}>{label}</label>
      {children}
      {hint === undefined ? null : <small className="sub">{hint}</small>}
      {error === undefined ? null : (
        <small role="alert" className="field-error" id={`${id}-error`}>
          {error}
        </small>
      )}
    </div>
  );
}

interface Moving {
  id: string;
  status: Exclude<ConnectorStatus, 'Draft'>;
}

/**
 * ADM-09: the integration connectors of the tenant (ST-ADM-018). A connector is honest about its adapter: the verdict is shown in the words of
 * the integration cursors (VERIFIED, PROPOSED, MOCK, MISSING), a MOCK adapter in red and a PROPOSED one in yellow, and only a VERIFIED adapter
 * (or a MOCK one outside production, which the server decides) can be made Active. A secret is never typed here: a credential is a reference to the vault.
 */
export function ConnectorsWorkspace({ route, connectors }: ConnectorsWorkspaceProps) {
  const tenantId = useSession().tenant?.id;
  // Everything the screen holds (the form, the open move, the reason) belongs to one tenant: a switch starts it over.
  return <WorkspaceContent key={tenantId ?? 'none'} route={route} connectors={connectors} />;
}

function WorkspaceContent({ route, connectors }: ConnectorsWorkspaceProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  // A suspended tenant (READ_ONLY mode) is read-only for everyone, whatever the grants say.
  const canManage = (permissions === undefined || permissions.includes(MANAGE_CONNECTOR_PERMISSION)) && mode !== 'READ_ONLY';
  const create = useCreateConnector();
  const move = useMoveConnector();
  const register = useMemo(() => inRegisterOrder(connectors), [connectors]);
  const [values, setValues] = useState<ConnectorValues>(EMPTY_CONNECTOR);
  const [errors, setErrors] = useState<ConnectorErrors>({});
  const [saved, setSaved] = useState(false);
  const [moving, setMoving] = useState<Moving | undefined>(undefined);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState(false);
  const createProblem = create.isError ? describeProblem(create.error) : undefined;
  const moveProblem = move.isError ? describeProblem(move.error) : undefined;
  const target = register.find((connector) => connector.id === moving?.id);

  const set = <K extends ConnectorField>(field: K, value: ConnectorValues[K]): void => {
    setValues((current) => ({ ...current, [field]: value }));
    setSaved(false);
  };

  const saveConnector = (event: FormEvent): void => {
    event.preventDefault();
    const found = validateConnector(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    create.mutate(connectorBody(values), { onSuccess: () => (setSaved(true), setValues(EMPTY_CONNECTOR)) });
  };

  const confirmMove = (event: FormEvent): void => {
    event.preventDefault();
    if (target === undefined || moving === undefined) return;
    const trimmed = reason.trim();
    if (trimmed.length < REASON_MIN_LENGTH || trimmed.length > REASON_MAX_LENGTH) {
      setReasonError(true);
      return;
    }
    move.mutate(
      { id: target.id, version: target.version, status: moving.status, reason: trimmed },
      {
        onSuccess: () => {
          setMoving(undefined);
          setReason('');
        },
      },
    );
  };
  const open = (id: string, status: Moving['status']): void => {
    setMoving({ id, status });
    setReason('');
    setReasonError(false);
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="adm-connectors">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('adm.connectors.page.title')}</h1>
          <p>{t('adm.connectors.page.subtitle')}</p>
        </div>
      </div>
      <p className="callout" role="note" data-testid="honesty-note">
        {t('adm.connectors.honesty.note')}
      </p>
      <div className="two">
        <div className="card">
          <h2>{t('adm.connectors.list.title')}</h2>
          {register.length === 0 ? <p className="muted">{t('adm.connectors.list.empty')}</p> : null}
          {moveProblem === undefined ? null : (
            <p className="callout warning" role="alert" data-testid="move-problem">
              {problemMessage(t, moveProblem)}
            </p>
          )}
          {register.length === 0 ? null : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('adm.connectors.col.code')}</th>
                    <th>{t('adm.connectors.col.mode')}</th>
                    <th>{t('adm.connectors.col.adapter')}</th>
                    <th>{t('adm.connectors.col.mapping')}</th>
                    <th>{t('adm.connectors.col.credential')}</th>
                    <th>{t('adm.connectors.col.status')}</th>
                    <th>
                      <span className="sr-only">{t('adm.connectors.col.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {register.map((connector) => (
                    <tr key={connector.id} data-connector-id={connector.id} data-adapter={connector.adapterStatus} data-status={connector.status}>
                      <td>
                        <strong>{connector.connectorCode}</strong>
                        <div className="sub">{connector.configKeys.length === 0 ? t('adm.connectors.config.none') : connector.configKeys.join(', ')}</div>
                      </td>
                      <td>{modeLabel(t, connector.mode)}</td>
                      <td>
                        <span className={adapterPill(connector.adapterStatus)}>{adapterLabel(t, connector.adapterStatus)}</span>
                      </td>
                      <td>{connector.mappingVersion ?? t('adm.connectors.mapping.none')}</td>
                      <td>{connector.credentialSecretRef ?? t('adm.connectors.credential.none')}</td>
                      <td>
                        <span className={connectorStatusPill(connector.status)}>{connectorStatusLabel(t, connector.status)}</span>
                      </td>
                      <td className="row-actions">
                        {!canManage ? null : (
                          <>
                            {connector.status === 'Active' ? null : mayBeActive(connector.adapterStatus) ? (
                              <button type="button" onClick={() => open(connector.id, 'Active')}>
                                {t('adm.connectors.activate.action')}
                              </button>
                            ) : (
                              <span className="sub" data-testid="not-activatable">
                                {t('adm.connectors.activate.blocked.hint')}
                              </span>
                            )}
                            {connector.status === 'Disabled' ? null : (
                              <button type="button" onClick={() => open(connector.id, 'Disabled')}>
                                {t('adm.connectors.disable.action')}
                              </button>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {target === undefined || moving === undefined ? null : (
            <form className="move-panel" onSubmit={confirmMove} aria-label={t('adm.connectors.move.title')} data-testid="move-panel">
              <h3>{t('adm.connectors.move.title')}</h3>
              <p>
                <strong>{target.connectorCode}</strong> · <span className={adapterPill(target.adapterStatus)}>{adapterLabel(t, target.adapterStatus)}</span> →{' '}
                {connectorStatusLabel(t, moving.status)}
              </p>
              <Field id="move-reason" label={t('adm.connectors.move.reason.label')} error={reasonError ? t('adm.connectors.move.reason.error') : undefined}>
                <textarea id="move-reason" value={reason} onChange={(event) => setReason(event.target.value)} />
              </Field>
              <div className="formfooter">
                <button type="submit" className="primary" disabled={move.isPending}>
                  {t('adm.connectors.move.confirm.action')}
                </button>
                <button type="button" onClick={() => setMoving(undefined)}>
                  {t('adm.connectors.move.cancel.action')}
                </button>
              </div>
            </form>
          )}
        </div>

        {canManage ? (
          <aside className="card" aria-label={t('adm.connectors.form.title')}>
            <h2>{t('adm.connectors.form.title')}</h2>
            <p className="sub">{t('adm.connectors.form.hint')}</p>
            <form onSubmit={saveConnector} noValidate>
              <Field id="connector-code" label={t('adm.connectors.form.code.label')} error={errors.connectorCode === undefined ? undefined : fieldMessage(t, errors.connectorCode)}>
                <input id="connector-code" value={values.connectorCode} aria-invalid={errors.connectorCode !== undefined} onChange={(event) => set('connectorCode', event.target.value)} />
              </Field>
              <Field id="connector-mode" label={t('adm.connectors.form.mode.label')} error={undefined}>
                <select id="connector-mode" value={values.mode} onChange={(event) => set('mode', event.target.value as ConnectorMode)}>
                  {CONNECTOR_MODES.map((candidate) => (
                    <option key={candidate} value={candidate}>
                      {modeLabel(t, candidate)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="connector-adapter" label={t('adm.connectors.form.adapter.label')} hint={t('adm.connectors.form.adapter.hint')} error={undefined}>
                <select id="connector-adapter" value={values.adapterStatus} onChange={(event) => set('adapterStatus', event.target.value as AdapterStatus)}>
                  {ADAPTER_STATUSES.map((candidate) => (
                    <option key={candidate} value={candidate}>
                      {adapterLabel(t, candidate)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="connector-config" label={t('adm.connectors.form.config.label')} hint={t('adm.connectors.form.config.hint')} error={errors.config === undefined ? undefined : fieldMessage(t, errors.config)}>
                <textarea id="connector-config" value={values.config} aria-invalid={errors.config !== undefined} onChange={(event) => set('config', event.target.value)} />
              </Field>
              <Field
                id="connector-credential"
                label={t('adm.connectors.form.credential.label')}
                hint={t('adm.connectors.form.credential.hint')}
                error={errors.credentialSecretRef === undefined ? undefined : fieldMessage(t, errors.credentialSecretRef)}
              >
                <input id="connector-credential" value={values.credentialSecretRef} aria-invalid={errors.credentialSecretRef !== undefined} onChange={(event) => set('credentialSecretRef', event.target.value)} />
              </Field>
              <Field id="connector-mapping" label={t('adm.connectors.form.mapping.label')} error={errors.mappingVersion === undefined ? undefined : fieldMessage(t, errors.mappingVersion)}>
                <input id="connector-mapping" value={values.mappingVersion} aria-invalid={errors.mappingVersion !== undefined} onChange={(event) => set('mappingVersion', event.target.value)} />
              </Field>
              {createProblem === undefined ? null : (
                <p className="callout warning" role="alert" data-testid="form-problem">
                  {problemMessage(t, createProblem)}
                </p>
              )}
              {saved ? (
                <p className="callout" role="status" data-testid="form-saved">
                  {t('adm.connectors.form.saved.text')}
                </p>
              ) : null}
              <div className="formfooter">
                <button type="submit" className="primary" disabled={create.isPending}>
                  {t('adm.connectors.form.submit.action')}
                </button>
              </div>
            </form>
          </aside>
        ) : null}
      </div>
      <p className="prototype-note">{t('adm.connectors.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
