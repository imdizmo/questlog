-- Email (server/email.ts). Every email goes through the outbox; the scheduler sends at most 20 per minute.
-- status: 'pending' (waits for next_attempt_at), 'sent', 'failed' (5 attempts, or a permanent 5xx), 'log' (the
-- server runs with EMAIL_TRANSPORT=log: nothing leaves the machine, last_error says "not sent (log mode)").
-- Kept to the newest 10000 rows.
CREATE TABLE email_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  text TEXT NOT NULL,
  html TEXT,
  kind TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'log')),
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT
);
CREATE INDEX email_outbox_due ON email_outbox (status, next_attempt_at);

-- Notification emails per person: 'off', a 'daily' digest at 08:00 in their timezone (the default, also without a
-- row), or 'instant' (unseen threads within minutes). last_sent_at: threads newer than this go in the next email;
-- digest_day: the local day of the last daily digest.
CREATE TABLE email_prefs (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  notifications TEXT NOT NULL DEFAULT 'daily' CHECK (notifications IN ('off', 'daily', 'instant')),
  updated_at INTEGER NOT NULL,
  last_sent_at INTEGER,
  digest_day TEXT
);

-- Addresses that unsubscribed from a kind of email (GET /email/unsubscribe). Lower-cased address.
CREATE TABLE email_unsubscribes (
  addr TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (addr, kind)
);

-- The daily report email looks up an address's last email (server/jobs.ts runReportEmails).
CREATE INDEX report_emails_email ON report_emails (email COLLATE NOCASE);
