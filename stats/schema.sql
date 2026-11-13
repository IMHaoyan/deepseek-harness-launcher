-- stats/schema.sql — 只存"按天 + 版本组合"的聚合计数，没有逐条用户记录，也没有安装 ID。
CREATE TABLE IF NOT EXISTS daily_counts (
  day             TEXT    NOT NULL,
  dshl_version    TEXT    NOT NULL,
  dshl_channel    TEXT    NOT NULL,
  dsh_version     TEXT    NOT NULL,
  dsh_channel     TEXT    NOT NULL,
  windows_version TEXT    NOT NULL,
  reports         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, dshl_version, dshl_channel, dsh_version, dsh_channel, windows_version)
);

CREATE INDEX IF NOT EXISTS daily_counts_day ON daily_counts (day);
