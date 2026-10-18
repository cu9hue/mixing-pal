-- A sign-in code send in flight, keyed by a private hash of the email. A second concurrent
-- send for the same email is answered without sending: the first email carries the code.
CREATE TABLE sign_in_sends (email_hash TEXT PRIMARY KEY, until INTEGER NOT NULL);
