-- Plans and billing (shared/plans.ts, server/billing.ts). billing_mode 'off' (the default) means self-hosted: no limits.
-- It follows the server's Stripe keys at every start (server/billing.ts syncBillingMode): keys present → 'stripe',
-- absent → 'off'. The first switch to 'stripe' starts a 14-day Pro trial (trial_started_at keeps it to one).
ALTER TABLE account ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'off' CHECK (billing_mode IN ('off', 'stripe'));
ALTER TABLE account ADD COLUMN plan_type TEXT NOT NULL DEFAULT 'free' CHECK (plan_type IN ('free', 'plus', 'pro', 'enterprise'));
ALTER TABLE account ADD COLUMN plan_status TEXT NOT NULL DEFAULT 'active' CHECK (plan_status IN ('trialing', 'active', 'past_due', 'canceled'));
ALTER TABLE account ADD COLUMN trial_ends_at INTEGER;
ALTER TABLE account ADD COLUMN trial_started_at INTEGER;
ALTER TABLE account ADD COLUMN purchased_seats INTEGER NOT NULL DEFAULT 0;
-- Operator overrides for this workspace (JSON object, shared/plans.ts PlanOverwrites).
ALTER TABLE account ADD COLUMN plan_overwrites TEXT NOT NULL DEFAULT '{}';
-- Never sent to clients (server/commands/rows.ts accountRow).
ALTER TABLE account ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE account ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE account ADD COLUMN billing_cycle_end INTEGER;
ALTER TABLE account ADD COLUMN is_disabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE account ADD COLUMN disabled_reason TEXT;

-- Stripe webhook events already applied, by event id (a replay is acknowledged and ignored). Pruned after 30 days.
CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX stripe_events_received ON stripe_events (received_at);
