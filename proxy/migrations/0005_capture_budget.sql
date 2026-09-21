ALTER TABLE budget ADD COLUMN capture_bytes INTEGER NOT NULL DEFAULT 0 CHECK (capture_bytes >= 0);
ALTER TABLE budget ADD COLUMN capture_allowance INTEGER NOT NULL DEFAULT 4000000000 CHECK (capture_allowance >= 0);

UPDATE budget SET capture_bytes = (SELECT COALESCE(SUM(bytes), 0) FROM captures WHERE state != 'deleted');

DROP TRIGGER admit_capture;
CREATE TRIGGER admit_capture BEFORE INSERT ON captures BEGIN
  SELECT RAISE(ABORT, 'capture_disabled') WHERE NOT EXISTS (SELECT 1 FROM turns t JOIN members m ON m.id = t.member_id
    WHERE t.id = NEW.turn_id AND t.capture = 1 AND m.capture = 1
    AND t.consent_epoch = m.consent_epoch AND t.deleted_at IS NULL AND m.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM consents c WHERE c.member_id = m.id AND c.version = 'quality-2026-09-17' AND c.enabled = 1
      AND c.id = (SELECT MAX(id) FROM consents WHERE member_id = m.id))
    AND t.created_at > NEW.created_at - 2592000000);
  SELECT RAISE(ABORT, 'capture_limit') WHERE (SELECT captured_bytes FROM turns WHERE id = NEW.turn_id) + NEW.bytes > 10485760
    OR (SELECT COUNT(*) FROM captures WHERE turn_id = NEW.turn_id) >= 256
    OR EXISTS (SELECT 1 FROM budget WHERE capture_bytes + NEW.bytes > capture_allowance);
END;

CREATE TRIGGER reserve_capture_budget AFTER INSERT ON captures
WHEN NEW.state != 'deleted' BEGIN
  UPDATE budget SET capture_bytes = capture_bytes + NEW.bytes WHERE id = 1;
END;

CREATE TRIGGER release_capture_budget AFTER UPDATE OF state ON captures
WHEN NEW.state = 'deleted' AND OLD.state != 'deleted' BEGIN
  UPDATE budget SET capture_bytes = capture_bytes - NEW.bytes WHERE id = 1;
END;
