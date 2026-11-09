-- Authored by hand (lane WEBPUSH, YCK.01): a rung of the channel ladder of an alert may be carried by Microsoft Teams, after the push that nobody acknowledged and next to the e-mail.
-- The only change is that the channel of a rung may be TEAMS; every row that was valid stays valid. The rung is sent the same way as the others (an event of the outbox that the
-- notification workflows of the tenant turn into a notification, which the delivery engine carries over the Teams channel adapter), and its receipt is read back from the same tables.
ALTER TABLE machvon.alert_ladder_rung DROP CONSTRAINT alert_ladder_rung_channel_check;
ALTER TABLE machvon.alert_ladder_rung
  ADD CONSTRAINT alert_ladder_rung_channel_check CHECK (channel IN ('IN_APP', 'PUSH', 'EMAIL', 'TEAMS', 'ZALO', 'SMS'));
