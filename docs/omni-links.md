# What a conversation points to, and the issue it becomes (ST-OMNI-007, OMNI.md 3.4, BR-OMNI-07, OMNI-09)

An agent attaches a conversation to the projects, issues and contracts it is about, and may turn it into an issue of a project they are scoped to. Only a summary and the address of the conversation go into the issue; not one word of what the person wrote.

## The links

`conversation.resource_links` (a list kept on the conversation) holds one entry for each record: `resource_type` (`project`, `issue`, `contract`), `resource_id`, `linked_at`, `linked_by`. `ConversationView.resource_links` carries them (without `linked_by`).

`linkConversationResource` (`POST /conversations/{id}/links`, 200, If-Match, Idempotency-Key):

| Rule | Answer |
|---|---|
| the conversation is in the scope of the agent for `omni.conversation.reply`, else it is not there | 404 `RESOURCE_NOT_FOUND` |
| the conversation is closed | 409 `CONVERSATION_STATE_INVALID` |
| stale version | 409 `VERSION_CONFLICT` |
| the record is not in the tenant | 404 `RESOURCE_NOT_FOUND` |
| the agent may not read the record at its place (the permission to read a project, an issue or a contract, held at the unit and project of the record) | 403 `SCOPE_DENIED` |
| a record that is linked already | 200, nothing changes (not even the version); the repeat is on the trail |
| more than 20 links | 422 `VALIDATION_FAILED` on `resource_id` |

Each call leaves an audit row `conversation.linked` with the type and the id of the record, and nothing else.

## The conversion

`getConversionOptions` (`GET /conversation-conversion-options`, `omni.conversation.convert`) names what OMNI-09 offers: only the **projects whose scope the agent holds the permission to convert at** (`effectivePermissions(access, now, place)` of each project), and the categories of issues of the tenant (`ISSUE_CATEGORY`, by code and label).

`convertConversationToIssue` (`POST /conversations/{id}/issues`, 201, If-Match, Idempotency-Key). The conversation must be in the scope of the agent for `omni.conversation.convert` (404 else), not closed (409 `CONVERSATION_STATE_INVALID`), at the version read, and **not turned into an issue before** (409 `CONVERSATION_ALREADY_CONVERTED`: one issue for a conversation). Then:

- the project must be there (404) and one the agent may convert at (403 `SCOPE_DENIED`; UAT-AC198: an agent scoped to P-01 is refused for P-09 and the conversation does not change);
- `issue_type` is the code of an effective category of the tenant (422 on `issue_type`);
- `due_date` and `assignee_membership_id` of the contract are **refused (422 on the field), not ignored**: the deadline of an issue is the one of the SLA policy in force, and who works on it is decided by the issue's own assignment;
- the issue is made by the issue module **in the same transaction** (`IssIssueStore.create`) with source `MANUAL`, severity `MEDIUM`, the owner unit of the project, the summary as its title, and as its description the summary and `/omni/omni-02?id=<conversation>` and nothing more. Its operation id is a UUID taken from `omni:{conversation}:{version}`, so a retry never makes a second issue;
- whatever the issue module refuses (no SLA policy for the category, no calendar...) is 422 `ISSUE_COMMAND_REJECTED` with its own code in `issue_error_code`, and nothing is written;
- the conversation then points to the issue and the project, at the next version.

The trail has `iss.issue_opened` (the issue's own row) and `conversation.converted_to_issue`; the events are `iss.issue.opened.v1` and `omni.conversation.converted.v1`.

## The screen

**OMNI-09** `ConversationConvertScreen` (`/omni/omni-09?id=<conversation>`, reached from OMNI-02 by whoever holds `omni.conversation.convert` while the conversation is not closed): the project and the type are chosen among the options only, the summary is of up to 500 characters and the notice says what is copied. A conversation that was converted shows the issue it became (a link to ISS-03) and no form; a closed one says it cannot be converted. The screen needs `conversation.read` and `omni.conversation.convert`.
