# Broadcast campaigns with preview and maker-checker (ST-NOT-009, NOT 3.5, BR-NOT-12, NOT-09, NOT-10, NOT-16)

## The flow

`createCampaign` → `previewCampaignRecipients` → `submitCampaign` → `decideCampaign` → (the time of the campaign) → `Sending` → `Completed`; `cancelCampaign` before it ends. States: `Draft`, `Previewed`, `PendingApproval`, `Approved`, `Scheduled`, `Sending`, `Completed`, `Rejected`, `Cancelled` (`campaignAfter` in `packages/kernel/src/campaign.ts` is the table; V1447 holds the same table in a trigger).

| Step | Who | Rule |
|---|---|---|
| `createCampaign` (`POST /notification-campaigns`, `notification.campaign.manage`) | maker | a name (1 to 120), a purpose (`ANNOUNCEMENT`, `REMINDER`, `OPERATIONAL`), an **Active** template of a channel the engine sends on (not the inbox: 422 `TEMPLATE_INVALID`), a segment that names someone (units, roles, or both: 409 `SEGMENT_INVALID` when empty), a time at least a minute ahead and within a year, or none (as soon as approved) |
| `previewCampaignRecipients` (If-Match, a reason of 10 to 2000) | maker | resolves the segment and answers the count, the people left out **by reason**, the hash, a few masked names; a draft or an earlier preview is replaced; the audit row holds the counts and the hash, never a person |
| `submitCampaign` (If-Match, `preview_hash`) | maker | the set is resolved again: the hash held, the hash sent and the hash now must be the same, else 409 `PREVIEW_STALE`; a campaign that would write to nobody is 409 `SEGMENT_INVALID` |
| `decideCampaign` (If-Match, `notification.campaign.approve` on the whole tenant) | approver | `approve`, `return` (back to `Draft`) or `reject`; **the maker, or the same user under another membership, is 403 `SELF_APPROVAL_DENIED`** for all three; an approval resolves the set a third time and a changed one is 409 `PREVIEW_STALE`; the template must still be Active and the channel must have an Active account (422 `CHANNEL_UNVERIFIED`) |
| `cancelCampaign` (If-Match, a reason) | maker | what is not yet taken up (Created, Scheduled, Queued) is Cancelled with its waiting sends; what is going out is asked to stop like a single notification (`DeliveryEngine.cancel`) |

`listCampaigns` and `getCampaign` (`notification.campaign.read`) read them; whoever does not hold the permission on the whole tenant reads the campaigns they made.

## The preview

The candidates are the live memberships (`Invited`, `Active`, `Suspended`) of the segment: the subtree of each unit named, narrowed to the holders of the roles named when roles are given, staff only unless the segment includes guest contractors. Each person is counted under **one** reason, the first that applies: `inactive` (the membership is not Active now), `duplicate` (one person with several memberships is written to once, through the Active one with the smallest id), `opted_out` (the person turned the channel off for the category `campaign` or for `*`, NOT-03), `no_consent` (the consent BR-NOT-07 asks for the channel and the purpose is missing, withdrawn or expired). `preview_hash = sha256(sorted recipient ids | template_version_id | scheduled_at)`.

A segment is within the scope of **whoever acts**: each unit must be one the grant of the actor contains (`mayActOnUnit`), a segment of roles alone needs the permission on the whole tenant (403 `SCOPE_DENIED`), a unit that is not there is 404. This is judged on create, preview, submit and cancel; the decision resolves the same segment without the scope of the approver. At most 5,000 recipients (409 `SEGMENT_INVALID`).

## The approval makes the notifications

In the transaction of the decision (`NotificationCampaignStore.launch`): one `notification_instance` for each recipient (`source_event_type = campaign.broadcast`, `event_id = campaign id`, the dedupe key of BR-NOT-01 with the campaign as the source event, so a second run makes none twice; `campaign_id`, `scheduled_for`; `priority NORMAL`), one first send each on the **pinned** template and the first Active account of the channel, due at the time of the campaign (`next_retry_at`) or at once; the notification expires 7 days after its time. The campaign is then `Scheduled` (a time ahead) or `Sending`, and `not.campaign.approved.v1` is written to the outbox. The notifications hang on a system workflow `campaign.broadcast` (kind NOTIFICATION, published by the first approval, one for the tenant) because a notification belongs to a published workflow version; it is visible in NOT-06 and gives the category `campaign` to NOT-03 so a person can turn campaigns off.

The sends go out through the ordinary delivery engine: consent, preference, quiet hours, the cap and the budget of the account (ST-NOT-010) and the circuit all apply at the moment of sending. The job `notification-campaign-progress` (every minute) moves `Scheduled` to `Sending` at the time of the campaign and `Sending` to `Completed` when none of its notifications is still Created, Scheduled, Queued or Sending.

## The database (V1447)

`notification_campaign` (V002) gets `created_at`, `preview_excluded`, `submitted_at`, `decided_by`, `decided_at`, `decision_reason`, `cancelled_at`, `completed_at`, `notification_count`. A trigger refuses a delete, a change of what the campaign is (name, purpose, template, segment, time, maker), any change to what ended, a change of the preview once it was sent to approval, and any move the state table does not allow. The checks of V002 (approver is not maker, approved means previewed) stay; `decided_by <> created_by` is added.

## Screens

- **NOT-09** (`SegmentScreen`): makes a draft (name, purpose, an Active template of an outside channel, the units of the tenant, roles, guests, a time) judged before sending the way the server does, and previews it with a reason: count, people left out by reason, hash, masked samples.
- **NOT-10** (`CampaignScheduleScreen`): the campaigns with their time, the zone (Asia/Ho_Chi_Minh), the validity (time plus 7 days), the recipients, the hash and the state; sends a previewed one to approval with its hash and cancels one that has not ended, with a reason. Read again every 30 seconds.
- **NOT-16** (`CampaignApprovalScreen`): the campaigns that wait, with the scope, the template, the count, the exclusions per reason, the hash and the maker; the maker sees a notice and no working button; approve, send back or reject with a reason.

The entitlement `notification.campaign` gates `manage` and `approve` (`features.ts`: 403 `ENTITLEMENT_DENIED` in grace and expired); the reads are not gated.
