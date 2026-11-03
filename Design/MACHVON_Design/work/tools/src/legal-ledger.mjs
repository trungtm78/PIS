import { finding } from './checks/finding.mjs';

// Legal confirmation ledger (decision R4): every [CXN-<n>] marker in the specs is an unverified legal
// basis. A slice that uses an unconfirmed rule cannot be DONE; rules and templates are data with a
// legal_basis, so a confirmation changes data, not code.

// An id is CXN-<number> or CXN-<LETTERS>[-<LETTERS>...]-<number> (for example CXN-ORG-01).
const ID_PATTERN = 'CXN-(?:[A-Z]+-)*\\d+';
const MARKER = new RegExp(`\\[(CXN(?:-(?:[A-Z]+-)*\\d+)?(?:\\s*,\\s*${ID_PATTERN})*)\\]`, 'g');
const ID = new RegExp(ID_PATTERN, 'g');
export const DEFAULT_OWNER = 'Pháp chế';
const STATUS = { awaiting: 'AWAITING_CONFIRMATION', confirmed: 'CONFIRMED', invalid: 'INVALID_CONFIRMATION' };

export function extractMarkers(markdown, file) {
  const markers = [];
  markdown.split(/\r?\n/).forEach((text, index) => {
    for (const match of text.matchAll(MARKER)) {
      const ids = match[1].match(ID) ?? [null];
      for (const id of ids) markers.push({ id, file, line: index + 1, context: text.trim() });
    }
  });
  return markers;
}

function isValidConfirmation(entry) {
  return Boolean(entry.evidence && entry.confirmed_by);
}

function statusOf(entry) {
  if (entry.status !== STATUS.confirmed) return entry.status ?? STATUS.awaiting;
  return isValidConfirmation(entry) ? STATUS.confirmed : STATUS.invalid;
}

export function buildLedger(markers, register) {
  const byId = new Map();
  for (const marker of markers.filter((item) => item.id)) {
    const row = byId.get(marker.id) ?? { id: marker.id, files: new Set(), occurrences: 0, statement: marker.context };
    row.files.add(marker.file);
    row.occurrences += 1;
    byId.set(marker.id, row);
  }
  return [...byId.values()]
    .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
    .map((row) => {
      const entry = register[row.id] ?? {};
      return {
        id: row.id,
        statement: row.statement,
        files: [...row.files].sort(),
        occurrences: row.occurrences,
        owner: entry.owner ?? DEFAULT_OWNER,
        evidence: entry.evidence ?? null,
        status: statusOf(entry),
        confirmed_by: entry.confirmed_by ?? null,
        confirmed_at: entry.confirmed_at ?? null,
        // A waiver (ST-KERNEL-110) is the named owner accepting the risk of going on without a confirmation; its fields travel to the ledger when the register has them.
        ...(entry.status === 'WAIVED' ? { waived_by: entry.waived_by ?? null, waived_at: entry.waived_at ?? null, waiver_reason: entry.waiver_reason ?? null } : {}),
      };
    });
}

export function checkLedgerMarkers(markers) {
  return markers.filter((marker) => marker.id === null).map((marker) => finding('CXN_MARKER_WITHOUT_ID', { file: marker.file, line: marker.line }));
}
