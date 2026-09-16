ALTER TABLE members ADD COLUMN recovery_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE budget ADD COLUMN recovery_required INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER recovery_admission BEFORE INSERT ON requests BEGIN
  SELECT RAISE(ABORT, 'service_paused') WHERE EXISTS (SELECT 1 FROM budget WHERE recovery_required = 1)
    OR EXISTS (SELECT 1 FROM members WHERE id = NEW.member_id AND recovery_required = 1);
END;

CREATE TRIGGER recovery_resume BEFORE UPDATE OF paused ON budget
WHEN NEW.paused = 0 BEGIN
  SELECT RAISE(ABORT, 'recovery_required') WHERE NEW.recovery_required = 1 OR EXISTS (SELECT 1 FROM members WHERE recovery_required = 1);
END;
