CREATE TABLE members (
  id TEXT PRIMARY KEY NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  period_end INTEGER NOT NULL,
  allowance INTEGER NOT NULL DEFAULT 5000000,
  spent INTEGER NOT NULL DEFAULT 0,
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  capture INTEGER NOT NULL DEFAULT 0,
  consent_epoch INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE invites (
  code_hash TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  redeemed_by TEXT UNIQUE,
  redeemed_at INTEGER
);
CREATE INDEX invites_email ON invites(email);

CREATE TABLE budget (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  allowance INTEGER NOT NULL DEFAULT 50000000,
  spent INTEGER NOT NULL DEFAULT 0,
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  paused INTEGER NOT NULL DEFAULT 0
);
INSERT INTO budget(id) VALUES (1);

CREATE TABLE turns (
  id TEXT PRIMARY KEY NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  app_version TEXT NOT NULL,
  wire_version INTEGER NOT NULL,
  consent_epoch INTEGER NOT NULL,
  capture INTEGER NOT NULL,
  captured_bytes INTEGER NOT NULL DEFAULT 0,
  incomplete INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',
  deleted_at INTEGER
);
CREATE INDEX turns_member ON turns(member_id, created_at);
CREATE INDEX turns_expiry ON turns(created_at);

CREATE TABLE requests (
  id TEXT PRIMARY KEY NOT NULL,
  turn_id TEXT NOT NULL REFERENCES turns(id),
  member_id TEXT NOT NULL REFERENCES members(id),
  round INTEGER NOT NULL CHECK (round BETWEEN 1 AND 6),
  body_hash TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  tool_hash TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  reserved INTEGER NOT NULL CHECK (reserved > 0),
  cost INTEGER CHECK (cost >= 0),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'dispatched', 'unknown', 'settled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  generation_id TEXT,
  model TEXT NOT NULL,
  provider TEXT,
  usage TEXT,
  finish_reason TEXT,
  error_code TEXT,
  duration_ms INTEGER,
  reconcile_after INTEGER NOT NULL DEFAULT 0,
  UNIQUE(turn_id, round)
);
CREATE INDEX requests_member_status ON requests(member_id, status);
CREATE INDEX requests_status_time ON requests(status, updated_at);

-- Admission and settlement share the write transaction with the request.
-- A read followed by separate balance writes lets two Workers spend one allowance.
CREATE TRIGGER admit_request BEFORE INSERT ON requests BEGIN
  SELECT RAISE(ABORT, 'access_denied') WHERE NOT EXISTS (SELECT 1 FROM members
    WHERE id = NEW.member_id AND revoked = 0 AND deleted_at IS NULL AND period_end > NEW.created_at);
  SELECT RAISE(ABORT, 'turn_closed') WHERE NOT EXISTS (SELECT 1 FROM turns WHERE id = NEW.turn_id
    AND member_id = NEW.member_id AND status = 'running' AND deleted_at IS NULL);
  SELECT RAISE(ABORT, 'invalid_round') WHERE NEW.round != 1 + (SELECT COUNT(*) FROM requests WHERE turn_id = NEW.turn_id)
    OR EXISTS (SELECT 1 FROM requests WHERE turn_id = NEW.turn_id AND status != 'settled');
  SELECT RAISE(ABORT, 'service_paused') WHERE EXISTS (SELECT 1 FROM budget WHERE paused = 1);
  SELECT RAISE(ABORT, 'allowance_exhausted') WHERE EXISTS (SELECT 1 FROM members WHERE id = NEW.member_id
    AND spent + reserved + NEW.reserved > allowance)
    OR EXISTS (SELECT 1 FROM budget WHERE spent + reserved + NEW.reserved > allowance);
  SELECT RAISE(ABORT, 'busy') WHERE EXISTS (SELECT 1 FROM requests WHERE member_id = NEW.member_id
    AND status IN ('reserved', 'dispatched', 'unknown'))
    OR (SELECT COUNT(*) FROM requests WHERE status IN ('reserved', 'dispatched', 'unknown')) >= 5;
END;

CREATE TRIGGER reserve_request AFTER INSERT ON requests BEGIN
  UPDATE members SET reserved = reserved + NEW.reserved WHERE id = NEW.member_id;
  UPDATE budget SET reserved = reserved + NEW.reserved WHERE id = 1;
END;

CREATE TRIGGER settle_request AFTER UPDATE OF status ON requests
WHEN NEW.status = 'settled' AND OLD.status != 'settled' BEGIN
  SELECT RAISE(ABORT, 'cost_required') WHERE NEW.cost IS NULL;
  UPDATE members SET reserved = reserved - OLD.reserved, spent = spent + NEW.cost
    WHERE id = NEW.member_id;
  UPDATE budget SET reserved = reserved - OLD.reserved, spent = spent + NEW.cost,
    paused = iif(NEW.cost > OLD.reserved, 1, paused) WHERE id = 1;
END;

CREATE TABLE consents (
  id INTEGER PRIMARY KEY,
  member_id TEXT NOT NULL,
  version TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE captures (
  id TEXT PRIMARY KEY NOT NULL,
  turn_id TEXT NOT NULL REFERENCES turns(id),
  object_key TEXT NOT NULL UNIQUE,
  bytes INTEGER NOT NULL,
  body_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('trace', 'feedback')),
  state TEXT NOT NULL CHECK (state IN ('writing', 'ready', 'deleting', 'deleted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX captures_turn ON captures(turn_id, state);
CREATE INDEX captures_state ON captures(state, updated_at);

CREATE TRIGGER admit_capture BEFORE INSERT ON captures BEGIN
  SELECT RAISE(ABORT, 'capture_disabled') WHERE NOT EXISTS (SELECT 1 FROM turns t JOIN members m ON m.id = t.member_id
    WHERE t.id = NEW.turn_id AND (NEW.kind = 'feedback' OR (t.capture = 1 AND m.capture = 1
    AND t.consent_epoch = m.consent_epoch)) AND t.deleted_at IS NULL AND m.deleted_at IS NULL
    AND t.created_at > NEW.created_at - 2592000000);
  SELECT RAISE(ABORT, 'capture_limit') WHERE (SELECT captured_bytes FROM turns WHERE id = NEW.turn_id) + NEW.bytes > 10485760
    OR (SELECT COUNT(*) FROM captures WHERE turn_id = NEW.turn_id) >= 256;
END;

CREATE TRIGGER reserve_capture AFTER INSERT ON captures BEGIN
  UPDATE turns SET captured_bytes = captured_bytes + NEW.bytes WHERE id = NEW.turn_id;
END;

CREATE TABLE deletion_jobs (
  member_id TEXT PRIMARY KEY NOT NULL,
  requested_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE api_limits (
  key TEXT PRIMARY KEY NOT NULL,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE operator_actions (
  id INTEGER PRIMARY KEY,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  detail TEXT NOT NULL
);
