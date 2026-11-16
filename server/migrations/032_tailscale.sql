-- Sign-in by Tailscale: a person's tailnet login, how a session was made, and the people who asked to join.
ALTER TABLE users ADD COLUMN tailscale_login TEXT COLLATE NOCASE;
CREATE UNIQUE INDEX users_tailscale_login ON users(tailscale_login) WHERE tailscale_login IS NOT NULL;
ALTER TABLE sessions ADD COLUMN via TEXT;
CREATE TABLE access_requests (
  login TEXT PRIMARY KEY COLLATE NOCASE,
  display_name TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
