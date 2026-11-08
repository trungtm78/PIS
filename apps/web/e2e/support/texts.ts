/**
 * The loader of the texts of the e2e layer. The Vietnamese text a guide seed or a tour writes into the product (names of organisations,
 * projects and people, titles, reasons, notes, narration) lives in `data/<file>.json` next to the code that uses it; the code only holds
 * keys. `textsOf(table)` returns the lookup of one table: the key is checked against the table by the compiler, and `{0}`, `{1}` in a
 * text are replaced by the arguments in order (the same text a template literal with those values would have made).
 */

export type TextTable = Readonly<Record<string, string>>;

export type TextLookup<T extends TextTable> = (key: keyof T & string, ...args: readonly unknown[]) => string;

export function textsOf<T extends TextTable>(table: T): TextLookup<T> {
  return (key, ...args) => {
    // the key is checked against the table by the compiler, so the entry exists
    const template = table[key] as string;
    if (args.length === 0) return template;
    return template.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)]));
  };
}
