-- Existing opt-ins cannot authorize sharing outcome reports.
UPDATE members SET capture = 0, consent_epoch = consent_epoch + 1 WHERE capture = 1;

DROP TRIGGER admit_capture;
CREATE TRIGGER admit_capture BEFORE INSERT ON captures BEGIN
  SELECT RAISE(ABORT, 'capture_disabled') WHERE NOT EXISTS (SELECT 1 FROM turns t JOIN members m ON m.id = t.member_id
    WHERE t.id = NEW.turn_id AND t.capture = 1 AND m.capture = 1
    AND t.consent_epoch = m.consent_epoch AND t.deleted_at IS NULL AND m.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM consents c WHERE c.member_id = m.id AND c.version = 'quality-2026-09-17' AND c.enabled = 1
      AND c.id = (SELECT MAX(id) FROM consents WHERE member_id = m.id))
    AND t.created_at > NEW.created_at - 2592000000);
  SELECT RAISE(ABORT, 'capture_limit') WHERE (SELECT captured_bytes FROM turns WHERE id = NEW.turn_id) + NEW.bytes > 10485760
    OR (SELECT COUNT(*) FROM captures WHERE turn_id = NEW.turn_id) >= 256;
END;
