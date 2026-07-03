-- CRO Engine v1 tables (AGI-9000326). Additive to the cro-engine D1 (DB_SITES = sites).
-- Namespaced cro_* so they don't touch the sites registry tables. All IF NOT EXISTS (idempotent).

CREATE TABLE IF NOT EXISTS cro_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  funnel_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cro_signals_tenant ON cro_signals(tenant, id DESC);

CREATE TABLE IF NOT EXISTS cro_diagnoses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant TEXT NOT NULL,
  signal_id INTEGER,
  leaks_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cro_diagnoses_tenant ON cro_diagnoses(tenant, id DESC);

CREATE TABLE IF NOT EXISTS cro_hypotheses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant TEXT NOT NULL,
  leak TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  rationale TEXT,
  rank INTEGER,
  status TEXT NOT NULL DEFAULT 'proposed',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cro_hypotheses_tenant ON cro_hypotheses(tenant, id DESC);
