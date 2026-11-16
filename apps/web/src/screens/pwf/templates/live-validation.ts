import { useEffect, useRef, useState } from 'react';
import type { TemplateValidation } from '../model';
import { useDebouncedValue, useValidateTemplate } from './hooks';
import { paramsOfTemplate } from './template-model';
import type { Template } from './template-model';

/** The server checks the template after the table has stayed the same this long (cycles, references to other rules, the quality of the schedule). */
export const VALIDATE_DELAY_MS = 500;

export interface LiveValidation {
  result: { key: string; value: TemplateValidation } | undefined;
  /** The result is for the table as it is now. */
  current: boolean;
  pending: boolean;
  error: unknown;
}

/** The server's checks of the template kept in step with the table; an answer that comes after a newer question was sent is dropped. The server is not asked about a table the editor itself finds wrong. */
export function useLiveValidation(template: Template, enabled: boolean): LiveValidation {
  const { mutateAsync } = useValidateTemplate();
  const key = JSON.stringify(paramsOfTemplate(template));
  const settled = useDebouncedValue(key, VALIDATE_DELAY_MS);
  const latest = useRef({ template, key });
  latest.current = { template, key };
  const sequence = useRef(0);
  const [result, setResult] = useState<LiveValidation['result']>(undefined);
  const [state, setState] = useState<{ pending: boolean; error: unknown }>({ pending: false, error: undefined });
  useEffect(() => {
    if (!enabled) {
      sequence.current += 1;
      return;
    }
    const sent = latest.current;
    const mine = (sequence.current += 1);
    setState({ pending: true, error: undefined });
    mutateAsync(sent.template).then(
      (value) => {
        if (mine !== sequence.current) return;
        setResult({ key: sent.key, value });
        setState({ pending: false, error: undefined });
      },
      (error: unknown) => {
        if (mine === sequence.current) setState({ pending: false, error });
      },
    );
  }, [settled, enabled, mutateAsync]);
  return { result, current: result?.key === key, pending: state.pending, error: state.error };
}
