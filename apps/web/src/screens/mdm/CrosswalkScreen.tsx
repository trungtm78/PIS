import { useState } from "react";
import type { FormEvent } from "react";
import { useTranslation } from "../../i18n";
import type { ScreenProps } from "../../routes/types";
import { useSession } from "../../session/SessionContext";
import { StateBoundary } from "../../states/StateBoundary";
import { useScreenState } from "../../states/useScreenState";
import { Field } from "./components";
import { KitTable } from '../adm/KitTable';
import '../adm/adm-kit.css';
import {
  useCreateCrosswalk,
  useCrosswalks,
  useCursor,
  useCursors,
  useFindRecord,
  useResetCursor,
  useRetireCrosswalk,
} from "./hooks";
import {
  adapterLabel,
  crosswalkMethodLabel,
  crosswalkStatusLabel,
  cursorStatusLabel,
  fieldProblemMessage,
  problemMessage,
} from "./labels";
import {
  CROSSWALK_METHOD_LIST,
  CROSSWALK_PERMISSION,
  MASTER_READ_PERMISSION,
  CURSOR_READ_PERMISSION,
  CURSOR_RESET_PERMISSION,
  EMPTY_CROSSWALK_FORM,
  TENANT_ALIAS_SYSTEM,
  describeProblem,
  validateCrosswalk,
  validateCursorReset,
  validateRetireReason,
} from "./model";
import type {
  CrosswalkField,
  CrosswalkForm,
  CrosswalkMethod,
  CrosswalkStatus,
  CrosswalkView,
  CursorResetField,
  CursorView,
  FormErrors,
} from "./model";
import { StatusPill } from "../../ui";

const NEVER_EMPTY = (): boolean => false;
const NOT_FOUND = { reason: "notFound", field: undefined } as const;
const GENERAL = { reason: "general", field: undefined } as const;

/**
 * MDM-24: the mapping of the codes of other systems (Treasury, the national investment system, procurement, budget codes) to the entries of
 * master data, and the integration connectors with the position each has read to. A code stands for one entry at a time; a connector shows
 * whether its adapter is verified, and a position is moved by hand only for a stated reason (ST-MDM-007).
 */
export default function CrosswalkScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  // The filters, the forms and the open panels belong to one tenant: a switch starts the screen over.
  return <CrosswalkContent key={tenantId ?? "none"} route={route} />;
}

function CrosswalkContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const holds = (permission: string): boolean =>
    permissions === undefined || permissions.includes(permission);
  const frozen = mode === "READ_ONLY";
  const mayManage = holds(CROSSWALK_PERMISSION) && !frozen;
  const mayReset = holds(CURSOR_RESET_PERMISSION) && !frozen;
  const mayReadCursors = holds(CURSOR_READ_PERMISSION);
  // The mappings and the connectors have permissions of their own: someone who may only operate the connectors is not shut out by the 403 of the mappings.
  const mayReadMappings = holds(MASTER_READ_PERMISSION);
  const crosswalks = useCrosswalks({}, mayReadMappings);
  const cursors = useCursors(mayReadCursors);
  const state = useScreenState({
    isLoading: crosswalks.isLoading,
    error: crosswalks.error,
    data: crosswalks.data,
    isEmpty: NEVER_EMPTY,
  });
  const [system, setSystem] = useState("");
  const [type, setType] = useState("");
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<CrosswalkStatus | "">("");

  const needle = code.trim().toLowerCase();
  const rows = (crosswalks.data ?? []).filter(
    (row) =>
      (system === "" || row.sourceSystem === system) &&
      (type === "" || row.externalType === type) &&
      (status === "" || row.status === status) &&
      (needle === "" ||
        `${row.externalCode} ${row.businessKey}`
          .toLowerCase()
          .includes(needle)),
  );
  const systems = [
    ...new Set((crosswalks.data ?? []).map((row) => row.sourceSystem)),
  ].sort();
  const types = [
    ...new Set(
      (crosswalks.data ?? [])
        .filter((row) => system === "" || row.sourceSystem === system)
        .map((row) => row.externalType),
    ),
  ].sort();
  const filtering =
    system !== "" || type !== "" || code.trim() !== "" || status !== "";

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t("mdm.crosswalk.page.title")}</h1>
          <p>{t("mdm.crosswalk.page.subtitle")}</p>
        </div>
      </div>
      {mayReadMappings ? (
        <StateBoundary state={state} onRetry={() => void crosswalks.refetch()}>
          <div className="card">
            <form
              className="mdm-filters"
              role="search"
              onSubmit={(event) => event.preventDefault()}
              aria-label={t("mdm.crosswalk.filter.title")}
            >
              <div className="field">
                <label htmlFor="crosswalk-system">
                  {t("mdm.crosswalk.filter.system.label")}
                </label>
                <select
                  id="crosswalk-system"
                  value={system}
                  onChange={(event) => {
                    setSystem(event.target.value);
                    setType("");
                  }}
                >
                  <option value="">
                    {t("mdm.crosswalk.filter.all.option")}
                  </option>
                  {systems.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="crosswalk-type">
                  {t("mdm.crosswalk.filter.type.label")}
                </label>
                <select
                  id="crosswalk-type"
                  value={type}
                  onChange={(event) => setType(event.target.value)}
                >
                  <option value="">
                    {t("mdm.crosswalk.filter.all.option")}
                  </option>
                  {types.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="crosswalk-code">
                  {t("mdm.crosswalk.filter.code.label")}
                </label>
                <input
                  id="crosswalk-code"
                  type="search"
                  value={code}
                  placeholder={t("mdm.crosswalk.filter.code.placeholder")}
                  onChange={(event) => setCode(event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="crosswalk-status">
                  {t("mdm.crosswalk.filter.status.label")}
                </label>
                <select
                  id="crosswalk-status"
                  value={status}
                  onChange={(event) =>
                    setStatus(event.target.value as CrosswalkStatus | "")
                  }
                >
                  <option value="">
                    {t("mdm.crosswalk.filter.all.option")}
                  </option>
                  <option value="ACTIVE">
                    {crosswalkStatusLabel(t, "ACTIVE")}
                  </option>
                  <option value="RETIRED">
                    {crosswalkStatusLabel(t, "RETIRED")}
                  </option>
                </select>
              </div>
            </form>
            {rows.length === 0 ? (
              <p className="muted" data-testid="empty-crosswalk">
                {filtering
                  ? t("mdm.crosswalk.noMatch.text")
                  : t("mdm.crosswalk.empty.text")}
              </p>
            ) : (
              <KitTable caption={t('w2mdm.crosswalk.table.caption')}
                aria-label={t("mdm.crosswalk.table.aria")}
              >
                <thead>
                  <tr>
                    <th>{t("mdm.crosswalk.system.column")}</th>
                    <th>{t("mdm.crosswalk.type.column")}</th>
                    <th>{t("mdm.crosswalk.external.column")}</th>
                    <th>{t("mdm.crosswalk.internal.column")}</th>
                    <th>{t("mdm.crosswalk.validity.column")}</th>
                    <th>{t("mdm.crosswalk.method.column")}</th>
                    <th>{t("mdm.crosswalk.status.column")}</th>
                    <th>
                      <span className="sr-only">
                        {t("mdm.crosswalk.actions.column")}
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <CrosswalkRow
                      key={row.id}
                      row={row}
                      mayRetire={mayManage}
                    />
                  ))}
                </tbody>
              </KitTable>
            )}
            <p className="sub" data-testid="count">
              {t("mdm.crosswalk.count.text", { count: rows.length })}
            </p>
          </div>
          {mayManage ? <CreateCrosswalk /> : null}
        </StateBoundary>
      ) : null}
      {mayReadCursors ? (
        <Connectors cursors={cursors} mayReset={mayReset} />
      ) : null}
      <p className="prototype-note">
        {t("mdm.catalogue.footer.reference", {
          id: route.id,
          req: route.req ?? "",
        })}
      </p>
    </section>
  );
}

function CrosswalkRow({
  row,
  mayRetire,
}: {
  row: CrosswalkView;
  mayRetire: boolean;
}) {
  const { t } = useTranslation();
  const retire = useRetireCrosswalk();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [problem, setProblem] =
    useState<ReturnType<typeof validateRetireReason>>(undefined);
  const refused = retire.isError ? describeProblem(retire.error) : undefined;

  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (retire.isPending) return;
    const found = validateRetireReason(reason);
    setProblem(found);
    if (found !== undefined) return;
    retire.mutate(
      { id: row.id, version: row.version, reason: reason.trim() },
      { onSuccess: () => setOpen(false) },
    );
  };

  return (
    <>
      <tr
        data-crosswalk-id={row.id}
        data-status={row.status}
        data-external-code={row.externalCode}
      >
        <td>{row.sourceSystem}</td>
        <td>{row.externalType}</td>
        <td>
          <code>{row.externalCode}</code>
        </td>
        <td>
          <code>{row.businessKey}</code> · {row.masterType}
        </td>
        <td>{`${row.validFrom} → ${row.validUntil ?? ""}`}</td>
        <td>{crosswalkMethodLabel(t, row.matchMethod)}</td>
        <td>
          <StatusPill tone={row.status === "ACTIVE" ? "success" : "neutral"}>{crosswalkStatusLabel(t, row.status)}</StatusPill>
        </td>
        <td className="row-actions">
          {mayRetire && row.status === "ACTIVE" ? (
            <button
              type="button"
              onClick={() => setOpen((previous) => !previous)}
              aria-expanded={open}
            >
              {t("mdm.crosswalk.retire.action")}
            </button>
          ) : null}
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={8}>
            <form
              onSubmit={send}
              noValidate
              aria-label={t("mdm.crosswalk.retire.title", {
                code: row.externalCode,
              })}
            >
              {refused === undefined ? null : (
                <p className="callout warning" role="alert">
                  {problemMessage(t, refused)}
                </p>
              )}
              <Field
                id={`retire-${row.id}`}
                label={t("mdm.crosswalk.retire.reason.label")}
                error={
                  problem === undefined
                    ? undefined
                    : fieldProblemMessage(t, problem)
                }
              >
                <textarea
                  id={`retire-${row.id}`}
                  rows={2}
                  value={reason}
                  aria-invalid={problem !== undefined}
                  onChange={(event) => {
                    setReason(event.target.value);
                    setProblem(undefined);
                  }}
                />
              </Field>
              <div className="adm-kit-actions">
                <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setOpen(false)}>
                  {t("mdm.crosswalk.cancel.action")}
                </button>
                <button
                  type="submit"
                  className="primary"
                  disabled={retire.isPending}
                >
                  {t("mdm.crosswalk.retire.confirm.action")}
                </button>
              </div>
            </form>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function CreateCrosswalk() {
  const { t } = useTranslation();
  const create = useCreateCrosswalk();
  const find = useFindRecord();
  const [form, setForm] = useState<CrosswalkForm>(EMPTY_CROSSWALK_FORM);
  const [errors, setErrors] = useState<FormErrors<CrosswalkField>>({});
  const [missing, setMissing] = useState(false);
  const [lookupFailed, setLookupFailed] = useState(false);
  const [saved, setSaved] = useState(false);
  const refused = missing
    ? NOT_FOUND
    : lookupFailed
      ? GENERAL
      : create.isError
        ? describeProblem(create.error)
        : undefined;

  const setField = <Field extends CrosswalkField>(
    field: Field,
    value: CrosswalkForm[Field],
  ): void => {
    setForm((previous) => ({ ...previous, [field]: value }));
    setErrors((previous) => ({ ...previous, [field]: undefined }));
    setMissing(false);
    setLookupFailed(false);
    setSaved(false);
  };
  const error = (field: CrosswalkField): string | undefined => {
    const own = errors[field];
    return own === undefined ? undefined : fieldProblemMessage(t, own);
  };

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (create.isPending) return;
    const found = validateCrosswalk(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const target = await find(
      form.masterType.trim(),
      form.businessKey.trim(),
    ).catch(() => null);
    if (target === null) {
      setLookupFailed(true);
      return;
    }
    if (target === undefined) {
      setMissing(true);
      return;
    }
    create.mutate(
      {
        master_record_id: target.id,
        source_system: form.sourceSystem.trim(),
        external_type: form.externalType.trim(),
        external_code: form.externalCode.trim(),
        valid_from: form.validFrom,
        match_method: form.matchMethod,
      },
      {
        onSuccess: () => {
          setForm(EMPTY_CROSSWALK_FORM);
          setSaved(true);
        },
      },
    );
  };

  const text = (field: CrosswalkField, id: string, label: string) => (
    <Field id={id} label={label} error={error(field)}>
      <input
        id={id}
        value={form[field]}
        aria-invalid={error(field) !== undefined}
        onChange={(event) => setField(field, event.target.value as never)}
      />
    </Field>
  );

  return (
    <form
      className="card"
      onSubmit={(event) => void save(event)}
      noValidate
      aria-label={t("mdm.crosswalk.form.aria")}
    >
      <h2>{t("mdm.crosswalk.form.title")}</h2>
      {refused === undefined ? null : (
        <p className="callout warning" role="alert">
          {problemMessage(t, refused)}
        </p>
      )}
      {saved ? (
        <p className="callout" role="status" data-testid="crosswalk-saved">
          {t("mdm.crosswalk.saved.notice")}
        </p>
      ) : null}
      <div className="formgrid">
        {text(
          "masterType",
          "crosswalk-master-type",
          t("mdm.crosswalk.form.masterType.label"),
        )}
        {text(
          "businessKey",
          "crosswalk-business-key",
          t("mdm.crosswalk.form.businessKey.label"),
        )}
        {text(
          "sourceSystem",
          "crosswalk-form-system",
          t("mdm.crosswalk.form.system.label"),
        )}
        {text(
          "externalType",
          "crosswalk-form-type",
          t("mdm.crosswalk.form.type.label"),
        )}
        {text(
          "externalCode",
          "crosswalk-form-code",
          t("mdm.crosswalk.form.code.label"),
        )}
        <Field
          id="crosswalk-form-from"
          label={t("mdm.crosswalk.form.validFrom.label")}
          error={error("validFrom")}
        >
          <input
            id="crosswalk-form-from"
            type="date"
            value={form.validFrom}
            aria-invalid={error("validFrom") !== undefined}
            onChange={(event) => setField("validFrom", event.target.value)}
          />
        </Field>
        <Field
          id="crosswalk-form-method"
          label={t("mdm.crosswalk.form.method.label")}
          error={undefined}
        >
          <select
            id="crosswalk-form-method"
            value={form.matchMethod}
            onChange={(event) =>
              setField("matchMethod", event.target.value as CrosswalkMethod)
            }
          >
            {CROSSWALK_METHOD_LIST.map((method) => (
              <option key={method} value={method}>
                {crosswalkMethodLabel(t, method)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {form.sourceSystem.trim() === TENANT_ALIAS_SYSTEM ? (
        <p className="sub" data-testid="crosswalk-alias-note">
          {t("mdm.crosswalk.alias.note")}
        </p>
      ) : null}
      <div className="adm-kit-actions">
        <span className="sub">{t("mdm.crosswalk.form.hint")}</span>
        <button type="submit" className="ui-button ui-button--primary" disabled={create.isPending}>
          {t("mdm.crosswalk.save.action")}
        </button>
      </div>
    </form>
  );
}

function Connectors({
  cursors,
  mayReset,
}: {
  cursors: ReturnType<typeof useCursors>;
  mayReset: boolean;
}) {
  const { t } = useTranslation();
  const [resetting, setResetting] = useState<string | undefined>(undefined);
  return (
    <div className="card" data-testid="connectors">
      <h2>{t("mdm.cursor.title")}</h2>
      <p className="sub">{t("mdm.cursor.subtitle")}</p>
      {cursors.isError ? (
        <p className="callout warning" role="alert">
          {t("mdm.cursor.read.error")}
        </p>
      ) : null}
      {cursors.data === undefined || cursors.data.length === 0 ? (
        cursors.isError ? null : (
          <p className="muted" data-testid="empty-connectors">
            {t("mdm.cursor.empty.text")}
          </p>
        )
      ) : (
        <KitTable caption={t('w2mdm.crosswalk.table.cursors')} aria-label={t("mdm.cursor.table.aria")}>
          <thead>
            <tr>
              <th>{t("mdm.cursor.connector.column")}</th>
              <th>{t("mdm.cursor.scope.column")}</th>
              <th>{t("mdm.cursor.adapter.column")}</th>
              <th>{t("mdm.cursor.status.column")}</th>
              <th>{t("mdm.cursor.lastSuccess.column")}</th>
              <th>{t("mdm.cursor.lastError.column")}</th>
              <th>
                <span className="sr-only">
                  {t("mdm.cursor.actions.column")}
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {cursors.data.map((cursor) => (
              <tr
                key={cursor.id}
                data-cursor-id={cursor.id}
                data-connector={cursor.connectorCode}
                data-adapter={cursor.adapterStatus}
              >
                <td>
                  <code>{cursor.connectorCode}</code>
                </td>
                <td>{cursor.sourceScope}</td>
                <td>
                  <StatusPill tone={cursor.adapterStatus === "VERIFIED" ? "success" : "neutral"}>{adapterLabel(t, cursor.adapterStatus)}</StatusPill>
                </td>
                <td>{cursorStatusLabel(t, cursor.status)}</td>
                <td>{cursor.lastSuccessAt ?? t("mdm.cursor.never.text")}</td>
                <td>{cursor.lastErrorCode ?? ""}</td>
                <td className="row-actions">
                  {mayReset ? (
                    <button
                      type="button"
                      aria-expanded={resetting === cursor.id}
                      onClick={() =>
                        setResetting((previous) =>
                          previous === cursor.id ? undefined : cursor.id,
                        )
                      }
                    >
                      {t("mdm.cursor.reset.action")}
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </KitTable>
      )}
      {resetting === undefined ? null : (
        <ResetCursor
          key={resetting}
          cursorId={resetting}
          onDone={() => setResetting(undefined)}
        />
      )}
    </div>
  );
}

function ResetCursor({
  cursorId,
  onDone,
}: {
  cursorId: string;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const cursor = useCursor(cursorId);
  const reset = useResetCursor();
  const [reason, setReason] = useState("");
  const [position, setPosition] = useState<string | undefined>(undefined);
  const [errors, setErrors] = useState<FormErrors<CursorResetField>>({});
  const refused = reset.isError ? describeProblem(reset.error) : undefined;
  const current: CursorView | null | undefined = cursor.data;
  // The position is offered as it stands, so a reset changes what the person edits and nothing else.
  const shown =
    position ??
    (current === undefined || current === null || current.position === null
      ? ""
      : JSON.stringify(current.position, null, 2));

  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (reset.isPending || current === null || current === undefined) return;
    const found = validateCursorReset({ reason, position: shown });
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    reset.mutate(
      {
        id: current.id,
        version: current.version,
        reason: reason.trim(),
        position:
          shown.trim() === ""
            ? {}
            : (JSON.parse(shown) as Record<string, unknown>),
      },
      { onSuccess: onDone },
    );
  };

  return (
    <form
      onSubmit={send}
      noValidate
      aria-label={t("mdm.cursor.reset.title", {
        connector: current?.connectorCode ?? "",
      })}
      data-testid="reset-form"
    >
      <h3>
        {t("mdm.cursor.reset.title", {
          connector: current?.connectorCode ?? "",
        })}
      </h3>
      {cursor.isError ? (
        <p className="callout warning" role="alert">
          {t("mdm.cursor.read.error")}
        </p>
      ) : null}
      {refused === undefined ? null : (
        <p className="callout warning" role="alert">
          {problemMessage(t, refused)}
        </p>
      )}
      <Field
        id="cursor-reason"
        label={t("mdm.cursor.reset.reason.label")}
        error={
          errors.reason === undefined
            ? undefined
            : fieldProblemMessage(t, errors.reason)
        }
      >
        <textarea
          id="cursor-reason"
          rows={2}
          value={reason}
          aria-invalid={errors.reason !== undefined}
          onChange={(event) => {
            setReason(event.target.value);
            setErrors((previous) => ({ ...previous, reason: undefined }));
          }}
        />
      </Field>
      <Field
        id="cursor-position"
        label={t("mdm.cursor.reset.position.label")}
        error={
          errors.position === undefined
            ? undefined
            : fieldProblemMessage(t, errors.position)
        }
        hint={t("mdm.cursor.reset.position.hint")}
      >
        <textarea
          id="cursor-position"
          rows={5}
          value={shown}
          aria-invalid={errors.position !== undefined}
          onChange={(event) => {
            setPosition(event.target.value);
            setErrors((previous) => ({ ...previous, position: undefined }));
          }}
        />
      </Field>
      <div className="adm-kit-actions">
        <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onDone}>
          {t("mdm.crosswalk.cancel.action")}
        </button>
        <button
          type="submit"
          className="primary"
          disabled={
            reset.isPending || current === undefined || current === null
          }
        >
          {t("mdm.cursor.reset.submit.action")}
        </button>
      </div>
    </form>
  );
}
