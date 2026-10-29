-- Each time an account agrees to the Terms: which version, and when. It holds no email, so it stays
-- after an account deletion as the record of what the paying account agreed to.
CREATE TABLE terms_acceptances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id TEXT NOT NULL,
  version TEXT NOT NULL,
  accepted_at INTEGER NOT NULL
);
CREATE INDEX terms_acceptances_member ON terms_acceptances(member_id, version);
