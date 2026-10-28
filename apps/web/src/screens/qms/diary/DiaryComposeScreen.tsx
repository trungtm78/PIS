import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ContentFields, CorrectDialog, SignDialog } from './DiaryDialogs';
import { DiaryContent, DiaryTitle, OtherContent, LegalNote, SignatureChain } from './DiaryParts';
import { useDiary, useReviseDiary } from './hooks';
import { formProblemMessage, problemMessage } from './labels';
import { canAct, catalogueLink, contentOf, describeProblem, formOf, reviewLink, validateDiary } from './model';
import type { DiaryForm, DiaryLine } from './model';
import '../qms.css';

/**
 * QMS-02: composing and signing the diary of a day (ST-QMS-001, QMS 3.1, BR-QMS-01, BR-QMS-03). A draft is written here and saved as often as needed; the contractor signs it once, over the hash of what it
 * says, and from then on it is no longer edited here. A diary that was locked is corrected with a new revision that is signed again. The note on the value of an in-app signature is always on the screen.
 */
export default function DiaryComposeScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const [search] = useSearchParams();
  // The diary and the dialogs belong to one membership and to the diary that is open: a switch of tenant or of membership, or of diary (to the correction that was just made, say), starts the screen over, with no dialog, edits or notice of the one before.
  return <ComposeContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}:${search.get('diary') ?? ''}`} route={route} />;
}

type Dialog = { kind: 'sign' } | { kind: 'correct' };

function ComposeContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { mode } = useSession();
  const [search, setSearch] = useSearchParams();
  const wanted = search.get('diary') ?? undefined;
  const diary = useDiary(wanted);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  // The save of a draft is told here, not in the form: a saved draft is a new version of the diary, which opens the form again.
  const [saved, setSaved] = useState(false);
  // What is typed and not saved is not what the contractor would sign: while it differs from the draft, signing and correcting wait for the save.
  const [dirty, setDirty] = useState(false);
  // The draft the typed edits were made over: while there are edits, a refresh of the diary does not take the form away (and the save is still asked at the version that was read, so that the server refuses it if the draft moved).
  const [pinned, setPinned] = useState<DiaryLine | undefined>(undefined);
  const track = useCallback((unsaved: boolean, over: DiaryLine): void => {
    setDirty(unsaved);
    setPinned(unsaved ? over : undefined);
  }, []);
  const state = useScreenState({ isLoading: diary.isLoading, error: diary.error, data: wanted === undefined ? undefined : diary.data, isEmpty: (data) => data === null });
  const line = diary.data ?? undefined;
  const writable = canAct(mode);
  const formLine = line !== undefined && dirty && pinned !== undefined && pinned.id === line.id ? pinned : line;
  const moved = line !== undefined && formLine !== undefined && formLine.version !== line.version;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('qms.diary.compose.title')}</h1>
          <p>{t('qms.diary.compose.subtitle')}</p>
        </div>
        <div className="actions">
          <Link className="button" to={catalogueLink()}>
            {t('qms.diary.back.action')}
          </Link>
        </div>
      </div>
      {wanted === undefined ? (
        <p className="callout" role="status" data-testid="no-diary-chosen">
          {t('qms.diary.compose.choose')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void diary.refetch()}>
          {line === undefined ? (
            <p className="callout warning" role="alert" data-testid="diary-missing">
              {t('qms.diary.error.notFound')}
            </p>
          ) : (
            <div className="card">
              <DiaryTitle line={line} />
              <LegalNote line={line} />
              {/* A form with edits that are not saved stays, even if the diary stopped being a draft meanwhile: the edits are kept to be copied or dropped on purpose, not replaced by what is signed. */}
              {writable && formLine !== undefined && (line.actions.revise || dirty) ? (
                <DraftForm
                  key={`${formLine.id}:${formLine.version}`}
                  line={formLine}
                  onSaved={() => {
                    setSaved(true);
                    track(false, formLine);
                  }}
                  onDirty={track}
                />
              ) : (
                <DiaryContent line={line} />
              )}
              {moved ? (
                <p className="callout warning" role="alert" data-testid="moved">
                  {t('qms.diary.draft.moved')}{' '}
                  <button type="button" data-action="reload" onClick={() => track(false, line)}>
                    {t('qms.diary.draft.reload')}
                  </button>
                </p>
              ) : null}
              {saved && line.actions.revise ? (
                <p className="sub" role="status" data-testid="saved">
                  {t('qms.diary.draft.saved')}
                </p>
              ) : null}
              <h2>{t('qms.diary.signatures.title')}</h2>
              <SignatureChain line={line} />
              {writable ? (
                <div className="actions">
                  {line.actions.contractorSign ? (
                    <button type="button" className="primary" data-action="sign" disabled={dirty} onClick={() => setDialog({ kind: 'sign' })}>
                      {t('qms.diary.sign.contractor.action')}
                    </button>
                  ) : null}
                  {line.actions.correct ? (
                    <button type="button" data-action="correct" disabled={dirty} onClick={() => setDialog({ kind: 'correct' })}>
                      {t('qms.diary.correct.action')}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {dirty ? (
                <p className="sub" role="status" data-testid="unsaved">
                  {t('qms.diary.draft.unsaved')}
                </p>
              ) : null}
              {line.status === 'DRAFT' || line.status === 'SUPERSEDED' ? null : (
                <Link className="button" to={reviewLink(line.id)} data-testid="to-review">
                  {t('qms.diary.review.action')}
                </Link>
              )}
            </div>
          )}
        </StateBoundary>
      )}
      {dialog?.kind === 'sign' && line !== undefined ? <SignDialog line={line} kind="contractor" onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'correct' && line !== undefined ? (
        <CorrectDialog
          line={line}
          onClose={() => setDialog(undefined)}
          onSaved={(id) => {
            setDialog(undefined);
            if (id !== '') setSearch({ diary: id });
          }}
        />
      ) : null}
      <p className="prototype-note">{t('qms.diary.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** The draft as a form: saved as the revision of the draft it was read at, so that someone else's change made meanwhile is refused instead of overwritten. */
function DraftForm({ line, onSaved, onDirty }: { line: DiaryLine; onSaved(): void; onDirty(dirty: boolean, over: DiaryLine): void }) {
  const { t } = useTranslation();
  const revise = useReviseDiary();
  const [form, setTyped] = useState<DiaryForm>(() => formOf(line));
  // One save, one identifier: a retry of this save is this save (the identifier is made when the form opens, and a new version of the diary opens a new form).
  const [operation, setOperation] = useState(() => crypto.randomUUID());
  // The identifier belongs to the payload: a save that is sent again keeps it, and one that was changed after a send that got no answer is another operation (the server replays an operation it saw).
  const setForm = (next: DiaryForm): void => {
    setTyped(next);
    setOperation(crypto.randomUUID());
  };
  const [submitted, setSubmitted] = useState(false);
  const problems = validateDiary(form, '9999-12-31', false);
  const shown = (field: keyof DiaryForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const unsaved = JSON.stringify(form) !== JSON.stringify(formOf(line));
  useEffect(() => {
    onDirty(unsaved, line);
    return () => onDirty(false, line);
  }, [unsaved, onDirty, line]);
  const save = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (revise.isPending || Object.keys(problems).length > 0) return;
    revise.mutate({ id: line.id, version: line.version, body: { content: contentOf(form, line.content), client_operation_id: operation } }, { onSuccess: onSaved });
  };
  return (
    <form onSubmit={save} noValidate data-testid="draft-form" aria-label={t('qms.diary.draft.title')}>
      {revise.isError ? (
        <p className="callout warning" role="alert" data-testid="refusal">
          {problemMessage(t, describeProblem(revise.error))}
        </p>
      ) : null}
      {/* While the save is on its way the fields wait: what is typed after the send is not in it, and the form that opens on the saved version would drop it. */}
      <fieldset className="qms-plain" disabled={revise.isPending}>
        <ContentFields form={form} set={(change) => setForm({ ...form, ...change })} shown={shown} prefix="draft" />
      </fieldset>
      <OtherContent content={line.content} />
      <div className="actions">
        <button type="submit" disabled={revise.isPending} data-action="save">
          {revise.isPending ? t('qms.diary.dialog.pending') : t('qms.diary.draft.save')}
        </button>
      </div>
    </form>
  );
}
