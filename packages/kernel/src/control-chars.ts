/** The C0 control characters (U+0000..U+001F) and DEL (U+007F), tested by code, so no pattern needs the control-regex rule. */
const isControlCode = (code: number): boolean => code <= 0x1f || code === 0x7f;

/** A text that holds any C0 control character or DEL. */
export function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (isControlCode(text.charCodeAt(i))) return true;
  }
  return false;
}

/** A text that holds a C0 control character or DEL other than tab, line feed and carriage return. */
export function hasControlCharExceptWhitespace(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (isControlCode(code) && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true;
  }
  return false;
}

/** A text with the characters XML 1.0 cannot hold removed: the control ones except tab, line feed and carriage return, and U+FFFE and U+FFFF. */
export function withoutXmlForbiddenChars(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const forbidden = (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0xfffe || code === 0xffff;
    if (!forbidden) out += text[i];
  }
  return out;
}
