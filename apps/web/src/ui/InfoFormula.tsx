import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

/** The words the control owns, already translated by the caller (the kit's rule: strings come from the screen). */
export interface InfoFormulaLabels {
  /** The accessible name of the "i" button; the caller puts the name of the figure in it ("Formula and source of …"). */
  open: string;
  close: string;
  formula: string;
  numerator: string;
  denominator: string;
  exclusions: string;
  source: string;
  asOf: string;
  owner: string;
  version: string;
  /** Said when the numbers of the definition are a starting value nobody confirmed. */
  unverified?: string;
}

export interface InfoFormulaProps {
  /** The name of the figure: the title of the panel. */
  name: string;
  formula: string;
  numerator?: string | null | undefined;
  denominator?: string | null | undefined;
  exclusions?: readonly string[] | undefined;
  source: string;
  /** The day the figure is counted up to, as the caller writes it. */
  asOf: string;
  owner: string;
  /** The version of the definition, as the caller writes it ("Version 0 (default)"). */
  version: string;
  unverified?: boolean | undefined;
  labels: InfoFormulaLabels;
}

/**
 * The "i" of a figure (G0-4): one button that opens the definition the number is made by: the formula in words, what is above and below the line, what is left out, the source, the day it is as of, who answers for
 * it and which version of the definition it is. It reads nothing of its own: every word comes from the KPI register through the caller. Keyboard: the button opens and closes it, Escape closes and gives the focus back,
 * a click outside closes it. It is a dialog without a backdrop (it does not hide the figure it explains).
 */
export function InfoFormula({ name, formula, numerator, denominator, exclusions, source, asOf, owner, version, unverified = false, labels }: InfoFormulaProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const outside = (event: MouseEvent): void => {
      if (root.current !== null && event.target instanceof Node && !root.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);

  const close = (): void => {
    setOpen(false);
    button.current?.focus();
  };
  const onKeyDown = (event: ReactKeyboardEvent): void => {
    if (event.key === 'Escape' && open) {
      event.stopPropagation();
      close();
    }
  };
  const rows: Array<{ key: string; label: string; value: string }> = [
    { key: 'formula', label: labels.formula, value: formula },
    ...(numerator === undefined || numerator === null || numerator === '' ? [] : [{ key: 'numerator', label: labels.numerator, value: numerator }]),
    ...(denominator === undefined || denominator === null || denominator === '' ? [] : [{ key: 'denominator', label: labels.denominator, value: denominator }]),
    { key: 'source', label: labels.source, value: source },
    { key: 'asOf', label: labels.asOf, value: asOf },
    { key: 'owner', label: labels.owner, value: owner },
    { key: 'version', label: labels.version, value: version },
  ];
  return (
    <span className="ui-info" ref={root} onKeyDown={onKeyDown}>
      <button ref={button} type="button" className="ui-info__button" aria-label={labels.open} aria-expanded={open} aria-controls={open ? panelId : undefined} aria-haspopup="dialog" onClick={() => setOpen((value) => !value)}>
        <span className="ui-info__glyph" aria-hidden="true" />
      </button>
      {open && (
        <div id={panelId} className="ui-info__panel" role="dialog" aria-label={name}>
          <strong className="ui-info__title">{name}</strong>
          <dl className="ui-info__list">
            {rows.map((row) => (
              <div key={row.key} className="ui-info__row" data-field={row.key}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
            {exclusions !== undefined && exclusions.length > 0 && (
              <div className="ui-info__row" data-field="exclusions">
                <dt>{labels.exclusions}</dt>
                <dd>
                  <ul className="ui-info__exclusions">
                    {exclusions.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </dd>
              </div>
            )}
          </dl>
          {unverified && labels.unverified !== undefined && (
            <p className="ui-info__note" data-field="unverified">
              {labels.unverified}
            </p>
          )}
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={close}>
            {labels.close}
          </button>
        </div>
      )}
    </span>
  );
}
