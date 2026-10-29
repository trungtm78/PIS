# DOC: overview of the documents (ST-DOC-014, slice DOC-1)

DOC-01 shows how many documents wait at each step, in the scope of whoever looks. It is a read model: no table, no migration, one read (`getDocumentOverview`, `GET /document-overview`, `doc.overview.read`).

| tile | counts | leads to |
|---|---|---|
| `drafts_in_review` | outgoing documents `IN_REVIEW` | DOC-03 `?status=IN_REVIEW` |
| `awaiting_leader_signature` | outgoing `SUBMITTED` | DOC-03 `?status=SUBMITTED` |
| `awaiting_number` | outgoing `SIGNED` | DOC-03 `?status=SIGNED` |
| `awaiting_seal` | outgoing `NUMBERED` | DOC-03 `?status=NUMBERED` |
| `overdue_incoming` | incoming letters `ASSIGNED` or `PROCESSING` and overdue now | DOC-12 `?overdue=true` |
| `interop_errors` | always 0 until the interoperability exists (ST-DOC-021) | nowhere |
| `templates_pending_confirmation` | `PUBLISHED` templates whose legal confirmation is pending (shows the label `[CXN-DOC-01]`) | DOC-14 |

The answer is `{ as_of, tiles: [{ key, count }] }`, counted in the database at `as_of`. Each tile is judged by the right to read its own kind: outgoing documents by `doc.outgoing.read` over the drafting unit
(the same scope as the list), incoming letters by `doc.incoming.read` (the scope of the ledger), templates by `doc.template.read`. A kind the viewer may not read has `count: null` and the screen says so: a figure that
cannot be given is never shown as 0. Another tenant has no way to this read (403), and a user with no right to the overview is refused.

**One definition of overdue.** The tile and the filter `overdue` of the ledger count the same letters: those assigned or being processed whose deadline has passed on a working day (`is_overdue` and a workable state). A
letter resolved late keeps its `late_days` and is not overdue any more; `is_overdue` in the reads says the same.

The links carry the filter: DOC-03 reads `?status=` (a value that is not a state is ignored) and DOC-12 reads `?status=` and `?overdue=true`. The screen has the seven states, a reload button and the moment of counting.
