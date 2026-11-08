// A small CSV reader for the exports of the Finance application: UTF-8 with or without a byte order mark, CRLF or LF, comma, semicolon or tab, quoted cells that may run over lines.
// It uses nothing but the language, so it runs wherever Node runs.

const DELIMITERS = [',', ';', '\t'];

/** The delimiter of a text: the one of the three that appears most in its first line outside quotes (comma when none appears). */
export function delimiterOf(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  let best = ',';
  let most = 0;
  for (const candidate of DELIMITERS) {
    let inQuotes = false;
    let count = 0;
    for (const char of firstLine) {
      if (char === '"') inQuotes = !inQuotes;
      else if (char === candidate && !inQuotes) count += 1;
    }
    if (count > most) {
      most = count;
      best = candidate;
    }
  }
  return best;
}

/** Splits a text into records of cells. A doubled quote inside a quoted cell is one quote. Blank lines are dropped. */
export function parseCells(text, delimiter) {
  const records = [];
  let cells = [];
  let cell = '';
  let inQuotes = false;
  const endCell = () => {
    cells.push(cell);
    cell = '';
  };
  const endRecord = () => {
    endCell();
    if (!(cells.length === 1 && cells[0] === '')) records.push(cells);
    cells = [];
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else inQuotes = false;
      } else cell += char;
    } else if (char === '"') inQuotes = true;
    else if (char === delimiter) endCell();
    else if (char === '\n') endRecord();
    else if (char === '\r') {
      if (text[index + 1] === '\n') index += 1;
      endRecord();
    } else cell += char;
  }
  if (cell !== '' || cells.length > 0) endRecord();
  return records;
}

/** Reads the bytes of an export as a table: the header names (trimmed) and the rows as arrays padded to the width of the header. */
export function readTable(bytes) {
  let text = new TextDecoder('utf-8').decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const records = parseCells(text, delimiterOf(text));
  const [head, ...body] = records;
  if (head === undefined || head.every((name) => name.trim() === '')) return { headers: [], rows: [] };
  const headers = head.map((name) => name.trim());
  return { headers, rows: body.map((row) => headers.map((_name, index) => (row[index] ?? '').trim())) };
}
