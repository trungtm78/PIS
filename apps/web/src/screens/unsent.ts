/**
 * Whether a form still holds what was sent. A form that stays editable while its request is in flight is cleared when the request succeeds only if this is so: what the person went on typing in the meantime was
 * never sent, and it stays.
 */
export function unchanged<T>(current: T, sent: T): boolean {
  return JSON.stringify(current) === JSON.stringify(sent);
}
