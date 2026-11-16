import { useCallback, useEffect, useRef, useState } from 'react';
import type { SchedulePreview } from '../model';
import { useDebouncedValue, usePreviewTemplate } from './hooks';
import type { PreviewInput } from './hooks';
import { paramsOfTemplate } from './template-model';
import type { Template } from './template-model';

/** The diagram waits this long after the last change of the table before it asks the server (R56). */
export const PREVIEW_DELAY_MS = 400;

export type PreviewStatus =
  /** Nothing asked yet. */
  | 'idle'
  /** The answer on screen is for the table as it is now. */
  | 'ready'
  /** The table changed and the server is asked (the answer on screen, if any, is the one before). */
  | 'loading'
  /** The answer on screen is not for the table as it is now: the table has cells to put right, or the screen is not asked. */
  | 'stale'
  /** The server could not be reached or refused: the table stays editable, the diagram says it is not up to date. */
  | 'error';

export interface LivePreview {
  status: PreviewStatus;
  /** The last answer that came, and the key of the table it was asked for. */
  result: { preview: SchedulePreview; key: string } | undefined;
  /** The answer on screen is for the table as it is now. */
  current: boolean;
  error: unknown;
  retry: () => void;
}

export interface LivePreviewInput {
  template: Template;
  /** The sample start day (a valid day). */
  start: string;
  facts: PreviewInput['facts'];
  /** Asked at all (the person may read, the template is read). */
  enabled: boolean;
  /** The table has cells the editor itself finds wrong: the server is not asked about it, the last diagram stays and says it is not up to date. */
  blocked: boolean;
}

/**
 * The server's schedule of the template on a sample day, kept in step with the table: it is asked after the table has stayed the same for 400 ms, and an answer that arrives after a newer question was sent is dropped
 * (a number is taken for each question), so the diagram is never the picture of an older table. Counted on the published calendars with the draft of a year taken where there is none (PROVISIONAL, R74).
 */
export function useLivePreview({ template, start, facts, enabled, blocked }: LivePreviewInput): LivePreview {
  const { mutateAsync } = usePreviewTemplate();
  const key = JSON.stringify([paramsOfTemplate(template), start, facts]);
  const settled = useDebouncedValue(key, PREVIEW_DELAY_MS);
  const latest = useRef({ template, start, facts, key });
  latest.current = { template, start, facts, key };
  const sequence = useRef(0);
  const [result, setResult] = useState<LivePreview['result']>(undefined);
  const [state, setState] = useState<{ status: 'idle' | 'loading' | 'error'; error: unknown }>({ status: 'idle', error: undefined });
  const [again, setAgain] = useState(0);

  useEffect(() => {
    if (!enabled || blocked) {
      // A question in flight is not wanted any more.
      sequence.current += 1;
      setState((old) => (old.status === 'loading' ? { status: 'idle', error: undefined } : old));
      return;
    }
    const sent = latest.current;
    const mine = (sequence.current += 1);
    setState({ status: 'loading', error: undefined });
    mutateAsync({ template: sent.template, plannedStartDate: sent.start, facts: sent.facts, calendarMode: 'PROVISIONAL' }).then(
      (preview) => {
        if (mine !== sequence.current) return;
        setResult({ preview, key: sent.key });
        setState({ status: 'idle', error: undefined });
      },
      (error: unknown) => {
        if (mine !== sequence.current) return;
        setState({ status: 'error', error });
      },
    );
    // The question is sent when the table has settled, when the screen may ask, and when the person asks again.
  }, [settled, enabled, blocked, again, mutateAsync]);

  const current = result !== undefined && result.key === key;
  const waiting = enabled && !blocked && key !== settled;
  const status: PreviewStatus = state.status === 'error' ? 'error' : state.status === 'loading' || waiting ? 'loading' : current ? 'ready' : result === undefined && enabled && !blocked ? 'idle' : 'stale';
  const retry = useCallback(() => setAgain((n) => n + 1), []);
  return { status, result, current, error: state.error, retry };
}
