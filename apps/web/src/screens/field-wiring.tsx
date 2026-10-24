import { cloneElement, isValidElement } from 'react';
import type { ReactElement, ReactNode } from 'react';

interface ControlProps {
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
}

/** The id of the hint under a field; the control names it in aria-describedby. */
export const hintIdOf = (id: string): string => `${id}-hint`;
/** The id of the error under a field; the control names it in aria-describedby. */
export const errorIdOf = (id: string): string => `${id}-error`;

/**
 * Ties the control of a field to the words under it (WCAG 1.3.1, 3.3.1): the hint and the error are named in `aria-describedby`, and a control that has an
 * error is `aria-invalid`, so a person who comes back to the field with a screen reader hears what is wrong with it and not only the label. Only the plain
 * element whose id is the id of the field is touched (the one the label points at); a description the screen already gave it is kept.
 */
export function wireControl(children: ReactNode, id: string, described: { hint: boolean; error: boolean }): ReactNode {
  if (!described.hint && !described.error) return children;
  if (!isValidElement<ControlProps>(children) || typeof children.type !== 'string' || children.props.id !== id) return children;
  const own = children.props['aria-describedby'];
  const ids = [own, described.hint ? hintIdOf(id) : undefined, described.error ? errorIdOf(id) : undefined].filter((part): part is string => part !== undefined && part !== '');
  const patch: ControlProps = { 'aria-describedby': ids.join(' ') };
  if (described.error) patch['aria-invalid'] = true;
  return cloneElement(children as ReactElement<ControlProps>, patch);
}
