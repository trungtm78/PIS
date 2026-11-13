import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { SectionCard } from '../../../ui';
import { useEffective, useRule } from '../../adm/governance/hooks';
import { isRuleCode, isUuid, textParam } from '../../adm/governance/model';
import { UnverifiedLabel } from '../components';
import { PATHS, PERMISSIONS, RULE_PERMISSIONS, TEMPLATE_RULE_TYPE, editorLink, holds } from '../model';
import type { SchedulePreview, TemplateValidation } from '../model';
import { StepsEditor } from './editor-steps';
import { PhasesPanel, TasksPanel } from './editor-panels';
import { PreviewPanel, ValidationPanel } from './editor-checks';
import { TextField, problemMapOf } from './editor-fields';
import { useDebouncedValue, usePreviewTemplate, useValidateTemplate } from './hooks';
import { RuleSavePanel, RuleVersionList } from './store';
import { addPhase, blankTemplate, localProblems, paramsOfTemplate, readTemplate } from './template-model';
import type { Template } from './template-model';
import '../pwf.css';
import './templates.css';

/** The editor waits this long after the last change before it asks the server to check the template. */
export const VALIDATE_DELAY_MS = 500;

/**
 * PWF-02: the editor of a workflow template. Phases with the commands of the project they hold shut, the task tree, links of four kinds with a lag, branches by the facts of the project, documents, forms, checklist and
 * KPI codes. The server checks the template while it is written and tries its schedule; a draft is written into the rule store, where a different person approves it (maker and checker).
 */
export default function TemplateEditorScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <EditorContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function EditorContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [params] = useSearchParams();
  const mayUse = holds(permissions, PERMISSIONS.templateManage);
  const writable = mode !== 'READ_ONLY';
  const canEdit = mayUse && writable;
  const canStore = writable && (permissions === undefined || permissions.includes(RULE_PERMISSIONS.manage));
  const canApprove = writable && (permissions === undefined || permissions.includes(RULE_PERMISSIONS.approve));
  const fromRaw = textParam(params.get('from'));
  const fromParam = fromRaw !== undefined && isUuid(fromRaw) ? fromRaw : undefined;
  const base = useRule(mayUse ? fromParam : undefined);
  const [typedCode, setTypedCode] = useState<string | undefined>(undefined);
  const code = typedCode ?? textParam(params.get('code')) ?? base.data?.code ?? '';
  const codeOk = isRuleCode(code);
  const effective = useEffective(TEMPLATE_RULE_TYPE, codeOk ? code : undefined, undefined, mayUse && codeOk);
  // Only the first read holds the form back: a code typed later reads the rule in force quietly and the form stays where it is.
  const loading = typedCode === undefined && (base.isLoading || (codeOk && effective.isLoading));
  const [edited, setEdited] = useState<Template | undefined>(undefined);
  const [attempted, setAttempted] = useState(false);
  const [selected, setSelected] = useState<number | undefined>(undefined);

  const baseParams = base.data?.params ?? effective.data?.params;
  const initial = useMemo(() => (baseParams === undefined ? addPhase(blankTemplate()) : readTemplate(baseParams)), [baseParams]);
  const template = edited ?? initial;
  const local = useMemo(() => localProblems(template), [template]);
  const problems = useMemo(() => problemMapOf(local), [local]);
  const queryState = useScreenState({ isLoading: loading, error: base.error ?? effective.error, data: loading ? undefined : true, isEmpty: () => false });
  const state = !mayUse ? 'denied' : queryState;

  // ---- the checks of the server ---------------------------------------------------------------------------------------------------------------------------------------
  const validate = useValidateTemplate();
  const preview = usePreviewTemplate();
  const key = useMemo(() => JSON.stringify(paramsOfTemplate(template)), [template]);
  const [validated, setValidated] = useState<{ key: string; result: TemplateValidation } | undefined>(undefined);
  const [previewed, setPreviewed] = useState<{ key: string; result: SchedulePreview } | undefined>(undefined);
  const latest = useRef(template);
  latest.current = template;
  const settledKey = useDebouncedValue(key, VALIDATE_DELAY_MS);
  const { mutate: runValidate } = validate;
  useEffect(() => {
    // The live check waits for the person to stop typing and asks nothing of a template the editor itself finds wrong (the problems are shown next to the fields).
    const sent = latest.current;
    if (!canEdit || loading || localProblems(sent).length > 0) return;
    const sentKey = JSON.stringify(paramsOfTemplate(sent));
    runValidate(sent, { onSuccess: (result) => setValidated({ key: sentKey, result }) });
  }, [settledKey, canEdit, loading, runValidate]);

  const checkNow = (): void => {
    setAttempted(true);
    if (local.length === 0) validate.mutate(template, { onSuccess: (result) => setValidated({ key, result }) });
  };

  const baseNote =
    fromParam !== undefined && base.data !== null && base.data !== undefined
      ? t('pwf.templates.editor.base.version', { version: base.data.version })
      : effective.data === null || effective.data === undefined
        ? t('pwf.templates.editor.base.blank')
        : effective.data.source === 'RULE'
          ? t('pwf.templates.editor.base.rule', { version: effective.data.version })
          : t('pwf.templates.editor.base.default');
  const unverified = effective.data?.unverified === true;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pwf.templates.editor.title.text')}</h1>
          <p>{t('pwf.templates.editor.subtitle.text')}</p>
        </div>
        <nav aria-label={t('pwf.templates.editor.links.label')}>
          <Link to={PATHS.library} data-testid="link-library">
            {t('pwf.templates.editor.library.link')}
          </Link>
        </nav>
      </div>
      <StateBoundary state={state} onRetry={() => void (base.refetch(), effective.refetch())}>
        {fromParam !== undefined && base.data === null ? (
          <p className="callout warning" role="status" data-testid="from-missing">
            {t('pwf.templates.editor.fromMissing.text')}
          </p>
        ) : null}
        {canEdit ? null : (
          <p className="callout" role="status" data-testid="read-only">
            {t('pwf.templates.editor.readOnly.text')}
          </p>
        )}
        <SectionCard title={t('pwf.templates.editor.identity.title')} status={unverified ? <UnverifiedLabel /> : undefined}>
          <p className="adm-kit-sub" data-testid="base-note">
            {baseNote}
          </p>
          {unverified ? <p className="callout warning" role="status" data-testid="unverified-note">{t('pwf.templates.editor.unverified.hint')}</p> : null}
          <div className="pwf-tpl-row">
            <TextField
              label={t('pwf.templates.editor.code.label')}
              path="code"
              hint={t('pwf.templates.editor.code.hint')}
              problems={problemMapOf(attempted && !codeOk ? [{ path: 'code', problem: code === '' ? 'required' : 'pattern' }] : [])}
              show={attempted}
              value={code}
              disabled={!canEdit}
              onChange={(value) => setTypedCode(value.toUpperCase())}
            />
            <TextField label={t('pwf.templates.editor.name.label')} path="name" problems={problems} show={attempted} value={template.name} disabled={!canEdit} onChange={(value) => setEdited({ ...template, name: value })} />
            <TextField
              label={t('pwf.templates.editor.projectType.label')}
              path="project_type"
              hint={t('pwf.templates.editor.projectType.hint')}
              problems={problems}
              show={attempted}
              value={template.project_type ?? ''}
              disabled={!canEdit}
              onChange={(value) => setEdited({ ...template, project_type: value === '' ? null : value })}
            />
          </div>
        </SectionCard>
        <PhasesPanel template={template} onChange={setEdited} problems={problems} show={attempted} disabled={!canEdit} />
        <StepsEditor template={template} onChange={setEdited} problems={problems} show={attempted} disabled={!canEdit} />
        <TasksPanel template={template} onChange={setEdited} problems={problems} show={attempted} disabled={!canEdit} selected={selected} onSelect={setSelected} />
        <ValidationPanel
          local={local}
          attempted={attempted}
          result={validated?.result}
          current={validated?.key === key}
          pending={validate.isPending}
          error={validate.error}
          canRun={canEdit}
          onRun={checkNow}
        />
        <PreviewPanel
          template={template}
          canRun={canEdit}
          pending={preview.isPending}
          error={preview.error}
          result={previewed?.result}
          current={previewed?.key === key}
          onRun={(input) => preview.mutate(input, { onSuccess: (result) => setPreviewed({ key, result }) })}
        />
        {canStore && canEdit ? (
          <RuleSavePanel ruleType={TEMPLATE_RULE_TYPE} code={code} codeValid={codeOk} params={() => paramsOfTemplate(template)} formOk={local.length === 0} onAttempt={() => setAttempted(true)} disabled={false} />
        ) : (
          <p className="callout" role="status" data-testid="no-store">
            {t('pwf.templates.editor.noStore.text')}
          </p>
        )}
        {codeOk ? (
          <RuleVersionList
            ruleType={TEMPLATE_RULE_TYPE}
            code={code}
            canManage={canStore}
            canApprove={canApprove}
            writable={writable}
            editLink={(id) => editorLink(code, id)}
            diffLink={(id, against) => `${PATHS.ruleDiff}?rule=${id}${against === undefined ? '' : `&against=${against}`}`}
          />
        ) : null}
      </StateBoundary>
      <p className="adm-kit-foot" data-testid="footer">
        {t('gova1.footer.reference', { id: route.id, req: route.req ?? '' })}
      </p>
    </section>
  );
}
