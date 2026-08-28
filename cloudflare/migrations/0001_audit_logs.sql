CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requested_at INTEGER NOT NULL,
  day TEXT NOT NULL,
  ip TEXT NOT NULL,
  account_name TEXT NOT NULL DEFAULT '',
  route TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS audit_logs_day_time ON audit_logs(day, requested_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_account_time ON audit_logs(account_name, requested_at DESC);
