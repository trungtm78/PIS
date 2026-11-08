-- WF-1: the Microsoft Teams channel of the notifications. The platform hands a card to an outbox that a relay of the operator reads and calls nobody, so the channel account of Teams has no webhook of its own and no
-- credential beyond the reference of the vault the relay uses. The only change to the schema is that a channel account may be of the channel TEAMS; the constraint is widened, every row that was valid stays valid.

ALTER TABLE machvon.channel_account DROP CONSTRAINT channel_account_channel_ck;
ALTER TABLE machvon.channel_account
  ADD CONSTRAINT channel_account_channel_ck CHECK (channel IN ('EMAIL', 'SMS', 'PUSH_FCM', 'PUSH_APNS', 'ZALO_OA', 'ZALO_ZNS', 'WHATSAPP', 'TEAMS'));
