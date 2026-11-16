import type { ReactNode } from 'react';

interface Props {
  /** The name of the block in the page (`block-<id>` for tests and anchors). */
  id: string;
  title: string;
  /** What is worth saying before the block is open (a count of what waits). */
  note?: ReactNode;
  open: boolean;
  onToggle: (open: boolean) => void;
  children: ReactNode;
}

/**
 * A collapsible block of PWF-04 (the deadline, the legal grounds, the exceptions, the history, the KPI): closed it is one line with what is worth knowing without opening it, open it is the block. The caller keeps whether it is open,
 * so a link or an action elsewhere on the page (a waiver started from the completion check) can open it. A native `details`: the keyboard opens it with Enter or Space and a screen reader says it is expanded or not.
 */
export function FoldBlock({ id, title, note, open, onToggle, children }: Props) {
  return (
    <details className="pwf-fold pwft-block" data-testid={`block-${id}`} open={open}>
      <summary
        onClick={(event) => {
          event.preventDefault();
          onToggle(!open);
        }}
      >
        {title}
        {note === undefined ? null : <span className="pwf-fold__note">{note}</span>}
      </summary>
      <div className="pwf-fold__body">{children}</div>
    </details>
  );
}
