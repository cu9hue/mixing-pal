-- One row per account that has ever opened Checkout. Stripe's state is applied
-- here and to members by subscriptions.ts; status is Stripe's, or 'none' before
-- a subscription exists.
CREATE TABLE subscriptions (
  member_id TEXT PRIMARY KEY NOT NULL,
  stripe_customer_id TEXT NOT NULL UNIQUE,
  stripe_subscription_id TEXT,
  plan TEXT CHECK (plan IN ('starter', 'pro')),
  status TEXT NOT NULL DEFAULT 'none',
  current_period_end INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  trial_used INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  -- The stamp of the Stripe read last applied here: its start in ms, times 1000, plus a random part. An older read loses.
  synced_at INTEGER NOT NULL DEFAULT 0,
  -- When renewals last read this row from Stripe, in ms. Each row is read at most once an hour.
  checked_at INTEGER NOT NULL DEFAULT 0
);

-- Free access granted by the operator. maintain renews it every 30 days.
ALTER TABLE members ADD COLUMN comp INTEGER NOT NULL DEFAULT 0;

-- A deletion cancels billing first, apart from content cleanup. Ordered by the last try, so a job Stripe keeps failing on cannot hold up the others.
ALTER TABLE deletion_jobs ADD COLUMN billing_cleared_at INTEGER;
ALTER TABLE deletion_jobs ADD COLUMN billing_checked_at INTEGER NOT NULL DEFAULT 0;
