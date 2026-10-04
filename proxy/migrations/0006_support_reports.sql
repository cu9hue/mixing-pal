CREATE TABLE support_reports (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  turn_id TEXT,
  body_hash TEXT,
  object_key TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  state TEXT NOT NULL CHECK (state IN ('writing', 'ready', 'deleting', 'deleted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  accepted_at INTEGER,
  write_until INTEGER NOT NULL DEFAULT 0,
  mail_from TEXT,
  reply_to TEXT,
  staging INTEGER NOT NULL DEFAULT 1,
  mail_state TEXT NOT NULL DEFAULT 'pending' CHECK (mail_state IN ('pending', 'sending', 'accepted', 'attention', 'cancelled')),
  first_attempt_at INTEGER,
  lease_until INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  email_id TEXT,
  mail_error TEXT
);
CREATE INDEX support_reports_owner ON support_reports(user_id, created_at);
CREATE INDEX support_reports_turn ON support_reports(turn_id, user_id);
CREATE INDEX support_reports_mail ON support_reports(mail_state, next_attempt_at);

CREATE TRIGGER admit_report BEFORE INSERT ON support_reports
WHEN NEW.state = 'writing' AND NOT EXISTS (SELECT 1 FROM support_reports WHERE id = NEW.id) BEGIN
  SELECT RAISE(ABORT, 'report_account_deleted') WHERE EXISTS (
    SELECT 1 FROM deletion_jobs WHERE member_id = NEW.user_id
  ) OR NOT EXISTS (SELECT 1 FROM "user" WHERE id = NEW.user_id);
  SELECT RAISE(ABORT, 'report_turn_unavailable') WHERE EXISTS (
    SELECT 1 FROM turns WHERE id = NEW.turn_id AND (member_id != NEW.user_id OR deleted_at IS NOT NULL)
  );
  SELECT RAISE(ABORT, 'report_rate_limit') WHERE (
    SELECT COUNT(*) FROM support_reports WHERE user_id = NEW.user_id AND body_hash IS NOT NULL
      AND created_at > NEW.created_at - 86400000
  ) >= 5;
  SELECT RAISE(ABORT, 'report_storage_limit') WHERE EXISTS (
    SELECT 1 FROM budget WHERE capture_bytes + NEW.bytes > capture_allowance
  );
END;
CREATE TRIGGER reserve_report_budget AFTER INSERT ON support_reports
WHEN NEW.state != 'deleted' BEGIN
  UPDATE budget SET capture_bytes = capture_bytes + NEW.bytes WHERE id = 1;
END;
CREATE TRIGGER release_report_budget AFTER UPDATE OF state ON support_reports
WHEN NEW.state = 'deleted' AND OLD.state != 'deleted' BEGIN
  UPDATE budget SET capture_bytes = capture_bytes - OLD.bytes WHERE id = 1;
END;
