CREATE TABLE IF NOT EXISTS subtasks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  parent_task TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed')),
  result TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_subtasks_session_parent
  ON subtasks(session_id, parent_task, created_at);
