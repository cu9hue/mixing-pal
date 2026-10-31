-- The service-wide cap on live model calls. set-capacity changes it.
ALTER TABLE budget ADD COLUMN max_in_flight INTEGER NOT NULL DEFAULT 20 CHECK (max_in_flight >= 1);

-- 0007's admission, with only the busy checks changed.
DROP TRIGGER admit_request;
CREATE TRIGGER admit_request BEFORE INSERT ON requests BEGIN
  -- A pause is reported first, so even a pre-0007 Worker tells the app the service is paused.
  SELECT RAISE(ABORT, 'service_paused') WHERE EXISTS (SELECT 1 FROM budget WHERE paused = 1);
  -- A Worker that does not set a lease predates this schema; it may not admit calls.
  SELECT RAISE(ABORT, 'lease_required') WHERE NEW.lease_until IS NULL OR NEW.deadline IS NULL;
  SELECT RAISE(ABORT, 'invalid_new_request') WHERE NEW.status != 'reserved' OR NEW.provisional != 0
    OR NEW.cost IS NOT NULL OR NEW.member_cost IS NOT NULL;
  SELECT RAISE(ABORT, 'access_denied') WHERE NOT EXISTS (SELECT 1 FROM members
    WHERE id = NEW.member_id AND revoked = 0 AND deleted_at IS NULL AND period_end > NEW.created_at);
  SELECT RAISE(ABORT, 'turn_closed') WHERE NOT EXISTS (SELECT 1 FROM turns WHERE id = NEW.turn_id
    AND member_id = NEW.member_id AND status = 'running' AND deleted_at IS NULL);
  SELECT RAISE(ABORT, 'invalid_round') WHERE NEW.round != 1 + (SELECT COUNT(*) FROM requests WHERE turn_id = NEW.turn_id)
    OR EXISTS (SELECT 1 FROM requests WHERE turn_id = NEW.turn_id AND status != 'settled');
  SELECT RAISE(ABORT, 'allowance_exhausted') WHERE EXISTS (SELECT 1 FROM members WHERE id = NEW.member_id
    AND spent + reserved + NEW.reserved > allowance);
  SELECT RAISE(ABORT, 'budget_exhausted') WHERE EXISTS (SELECT 1 FROM budget WHERE spent + reserved + NEW.reserved > allowance);
  SELECT RAISE(ABORT, 'busy') WHERE (SELECT COUNT(*) FROM requests
    WHERE status IN ('reserved', 'dispatched') AND lease_until > NEW.created_at) >= (SELECT max_in_flight FROM budget WHERE id = 1);
  -- Two per member: a crashed call holds its slot until its lease ends, about five minutes,
  -- so a second slot lets the member keep asking.
  SELECT RAISE(ABORT, 'busy') WHERE (SELECT COUNT(*) FROM requests WHERE member_id = NEW.member_id
    AND status IN ('reserved', 'dispatched') AND lease_until > NEW.created_at) >= 2;
END;
