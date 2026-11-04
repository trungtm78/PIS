/** Whether a text holds a control character: a C0 character (U+0000 to U+001F) or DEL (U+007F). Such a character is never part of a name, a code or a reason a person types. */
export function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
