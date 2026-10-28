-- Authored by hand (not generated): the amounts a counter and a reservation hold are as wide as the limit they are held under (ST-LLM-003).
-- contract: the settled and open amounts of the counters and the amounts of the reservations are numeric(32,8), wider than numeric(24,8); release M3

-- A limit has up to 24 digits (numeric(24,0)); what is settled and what is held are sums of amounts under it, kept with eight places, and must hold as many digits: they were numeric(24,8), which holds only 16 before the point.
ALTER TABLE machvon.ai_budget_counter ALTER COLUMN settled_vnd TYPE numeric(32,8);
ALTER TABLE machvon.ai_budget_counter ALTER COLUMN reserved_open_vnd TYPE numeric(32,8);
ALTER TABLE machvon.budget_reservation ALTER COLUMN reserved_amount TYPE numeric(32,8);
ALTER TABLE machvon.budget_reservation ALTER COLUMN settled_amount TYPE numeric(32,8);
ALTER TABLE machvon.budget_reservation ALTER COLUMN released_amount TYPE numeric(32,8);
