CREATE TABLE IF NOT EXISTS groups (
  group_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER
);

CREATE TABLE IF NOT EXISTS members (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  excluded INTEGER NOT NULL DEFAULT 0,
  display_name TEXT,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_messages_group_ts ON messages(group_id, ts);
CREATE INDEX IF NOT EXISTS ix_messages_user ON messages(group_id, user_id);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS analysis_usage (
  group_id TEXT NOT NULL,
  day_start INTEGER NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, day_start)
);

CREATE TABLE IF NOT EXISTS search_usage (
  month TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bot_turns (
  message_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_bot_turns_group_user_ts ON bot_turns(group_id,user_id,ts);
