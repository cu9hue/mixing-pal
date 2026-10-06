-- The model call's absolute end and the lease after which the call is dead.
ALTER TABLE requests ADD COLUMN deadline INTEGER;
ALTER TABLE requests ADD COLUMN lease_until INTEGER;
-- 1 while the call has ended and its cost is unknown; Mixing Pal pays that call.
ALTER TABLE requests ADD COLUMN provisional INTEGER NOT NULL DEFAULT 0 CHECK (provisional IN (0, 1));
-- What the member was charged. Set by settle_request; balances never read it.
ALTER TABLE requests ADD COLUMN member_cost INTEGER CHECK (member_cost >= 0);
ALTER TABLE budget ADD COLUMN loss INTEGER NOT NULL DEFAULT 0;

-- A final cost that a later trusted source disputes. Unresolved higher conflicts keep the service paused.
CREATE TABLE cost_conflicts (
  id INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  source TEXT NOT NULL,
  recorded INTEGER NOT NULL CHECK (recorded >= 0),
  reported INTEGER NOT NULL CHECK (reported >= 0),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolution TEXT,
  UNIQUE(request_id, source, reported)
);

CREATE INDEX requests_provisional ON requests(reconcile_after) WHERE provisional = 1;
CREATE INDEX cost_conflicts_open ON cost_conflicts(request_id) WHERE resolved_at IS NULL;

-- Replace the settlement trigger before any backfill settles a row.
-- A row that ended unknown (provisional now, or 'unknown' from a pre-0007 Worker) never charges the member.
DROP TRIGGER settle_request;
CREATE TRIGGER settle_request AFTER UPDATE OF status ON requests
WHEN NEW.status = 'settled' AND OLD.status != 'settled' BEGIN
  UPDATE members SET reserved = reserved - OLD.reserved,
    spent = spent + iif(NEW.provisional = 1 OR OLD.status = 'unknown', 0, MIN(NEW.cost, OLD.reserved))
    WHERE id = NEW.member_id;
  UPDATE budget SET reserved = reserved - OLD.reserved, spent = spent + NEW.cost,
    loss = loss + iif(NEW.provisional = 0, MAX(NEW.cost - OLD.reserved, 0), 0),
    paused = iif(NEW.provisional = 0 AND NEW.cost > OLD.reserved, 1, paused) WHERE id = 1;
  UPDATE requests SET member_cost = iif(NEW.provisional = 1 OR OLD.status = 'unknown', 0, MIN(NEW.cost, OLD.reserved))
    WHERE id = NEW.id;
END;

-- A provisional call that becomes known changes only the service budget.
CREATE TRIGGER finalize_provisional AFTER UPDATE OF provisional ON requests
WHEN OLD.provisional = 1 AND NEW.provisional = 0 BEGIN
  UPDATE budget SET spent = spent + NEW.cost - OLD.cost,
    loss = loss + MAX(NEW.cost - NEW.reserved, 0),
    paused = iif(NEW.cost > NEW.reserved, 1, paused) WHERE id = 1;
END;

CREATE TRIGGER request_transitions BEFORE UPDATE ON requests BEGIN
  SELECT RAISE(ABORT, 'immutable_request') WHERE NEW.id IS NOT OLD.id OR NEW.member_id IS NOT OLD.member_id
    OR NEW.turn_id IS NOT OLD.turn_id OR NEW.round IS NOT OLD.round OR NEW.reserved IS NOT OLD.reserved;
  SELECT RAISE(ABORT, 'settled_is_terminal') WHERE OLD.status = 'settled' AND NEW.status != 'settled';
  SELECT RAISE(ABORT, 'final_is_immutable') WHERE OLD.status = 'settled' AND OLD.provisional = 0
    AND (NEW.provisional != 0 OR NEW.cost IS NOT OLD.cost);
  SELECT RAISE(ABORT, 'cost_required') WHERE NEW.status = 'settled' AND (NEW.cost IS NULL OR NEW.cost < 0);
  SELECT RAISE(ABORT, 'invalid_provisional') WHERE NEW.provisional = 1
    AND (NEW.status != 'settled' OR NEW.cost IS NOT NEW.reserved);
  -- Only settle_request sets member_cost, once, on a row that is already settled.
  SELECT RAISE(ABORT, 'member_cost_derived') WHERE NEW.member_cost IS NOT OLD.member_cost
    AND (OLD.member_cost IS NOT NULL OR OLD.status != 'settled');
END;

-- Unresolved accounting is never pruned, and a pre-0007 Worker's maintenance cannot prune it either.
CREATE TRIGGER request_retention BEFORE DELETE ON requests BEGIN
  SELECT RAISE(ABORT, 'unresolved_accounting') WHERE OLD.status != 'settled' OR OLD.provisional = 1
    OR EXISTS (SELECT 1 FROM cost_conflicts WHERE request_id = OLD.id AND resolved_at IS NULL);
END;

-- A higher conflict keeps the service paused until an operator resolves it.
CREATE TRIGGER conflict_resume BEFORE UPDATE OF paused ON budget
WHEN NEW.paused = 0 BEGIN
  SELECT RAISE(ABORT, 'cost_conflict_open') WHERE EXISTS (SELECT 1 FROM cost_conflicts
    WHERE resolved_at IS NULL AND reported > recorded);
END;

CREATE TRIGGER conflict_pause AFTER INSERT ON cost_conflicts WHEN NEW.reported > NEW.recorded BEGIN
  UPDATE budget SET paused = 1 WHERE id = 1;
END;

-- Resolving a higher conflict books only the liability not already booked for that request, and its loss once.
-- The member's charge never changes.
CREATE TRIGGER conflict_resolve AFTER UPDATE OF resolved_at ON cost_conflicts
WHEN OLD.resolved_at IS NULL AND NEW.resolved_at IS NOT NULL AND NEW.resolution = 'booked' BEGIN
  UPDATE budget SET spent = spent + MAX(NEW.reported - MAX(NEW.recorded, (SELECT COALESCE(MAX(reported), 0) FROM cost_conflicts
      WHERE request_id = NEW.request_id AND resolution = 'booked' AND resolved_at IS NOT NULL AND id != NEW.id)), 0),
    loss = loss + MAX(NEW.reported - MAX(NEW.recorded, (SELECT reserved FROM requests WHERE id = NEW.request_id),
      (SELECT COALESCE(MAX(reported), 0) FROM cost_conflicts
        WHERE request_id = NEW.request_id AND resolution = 'booked' AND resolved_at IS NOT NULL AND id != NEW.id)), 0)
    WHERE id = 1;
END;

CREATE TRIGGER conflict_transitions BEFORE UPDATE ON cost_conflicts BEGIN
  SELECT RAISE(ABORT, 'conflict_immutable') WHERE NEW.request_id IS NOT OLD.request_id OR NEW.recorded IS NOT OLD.recorded
    OR NEW.reported IS NOT OLD.reported OR OLD.resolved_at IS NOT NULL;
  SELECT RAISE(ABORT, 'conflict_resolution') WHERE NEW.resolved_at IS NOT NULL AND NEW.resolution NOT IN ('booked', 'dismissed');
END;

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
    WHERE status IN ('reserved', 'dispatched') AND lease_until > NEW.created_at) >= 5;
END;

-- Backfill, after the triggers above. Safe to run again.
UPDATE requests SET deadline = COALESCE(deadline, updated_at + 270000), lease_until = COALESCE(lease_until, updated_at + 290000)
  WHERE status IN ('reserved', 'dispatched', 'unknown') AND lease_until IS NULL;
UPDATE requests SET status = 'settled', provisional = 1, cost = reserved,
  error_code = COALESCE(error_code, 'legacy_unknown'), reconcile_after = MAX(reconcile_after, lease_until)
  WHERE status = 'unknown';
-- History keeps what was actually charged; the reservation cap applies to new settlements only.
UPDATE requests SET member_cost = cost WHERE status = 'settled' AND provisional = 0 AND member_cost IS NULL;
