-- BOTHook control plane schema (SQLite)
-- Target: 10万+ instances with single-writer pattern

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- Instance asset ledger (current snapshot)
CREATE TABLE IF NOT EXISTS instances (
  instance_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  region TEXT NOT NULL,
  zone TEXT,

  public_ip TEXT,
  private_ip TEXT,
  bundle_id TEXT,
  blueprint_id TEXT,

  created_at TEXT,
  terminated_at TEXT,
  expired_at TEXT,

  lifecycle_status TEXT NOT NULL DEFAULT 'IN_POOL',
  health_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  last_probe_at TEXT,
  last_ok_at TEXT,

  assigned_user_id TEXT,
  assigned_order_id TEXT,
  assigned_at TEXT,

  meta_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_instances_lifecycle ON instances(lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_instances_health ON instances(health_status);
CREATE INDEX IF NOT EXISTS idx_instances_expired ON instances(expired_at);
CREATE INDEX IF NOT EXISTS idx_instances_assigned ON instances(assigned_user_id, assigned_order_id);

-- SSH credential records (private keys stored encrypted)
CREATE TABLE IF NOT EXISTS ssh_credentials (
  cred_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  login_user TEXT NOT NULL,
  auth_type TEXT NOT NULL, -- keypair|password

  key_fingerprint TEXT,
  private_key_ciphertext BLOB,
  private_key_iv BLOB,
  private_key_tag BLOB,
  private_key_alg TEXT,

  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  rotated_at TEXT,
  revoked_at TEXT,

  FOREIGN KEY(instance_id) REFERENCES instances(instance_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ssh_instance ON ssh_credentials(instance_id);
CREATE INDEX IF NOT EXISTS idx_ssh_status ON ssh_credentials(status);

-- Subscription snapshot (current)
CREATE TABLE IF NOT EXISTS subscriptions (
  provider_sub_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  user_id TEXT NOT NULL,
  plan TEXT NOT NULL,
  status TEXT NOT NULL,

  -- Stripe timestamps (ISO strings)
  current_period_end TEXT,
  cancel_at TEXT,
  canceled_at TEXT,
  ended_at TEXT,

  cancel_at_period_end INTEGER DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sub_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_sub_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_sub_cpe ON subscriptions(current_period_end);

-- Delivery state machine
CREATE TABLE IF NOT EXISTS deliveries (
  delivery_id TEXT PRIMARY KEY,
  order_id TEXT UNIQUE,
  user_id TEXT NOT NULL,
  instance_id TEXT,
  status TEXT NOT NULL,
  provision_uuid TEXT,

  -- Bind this provisioning UUID to a WhatsApp identity (prevents takeover on relink)
  wa_jid TEXT,
  wa_e164 TEXT,
  bound_at TEXT,

  -- user preferred language (from p-site)
  user_lang TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  meta_json TEXT,

  FOREIGN KEY(instance_id) REFERENCES instances(instance_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_deliveries_user ON deliveries(user_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries(status);
CREATE INDEX IF NOT EXISTS idx_deliveries_instance ON deliveries(instance_id);

-- Append-only events for audit/debug
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_type, entity_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type, ts);

-- Local queue table for single-writer ingestion
CREATE TABLE IF NOT EXISTS write_queue (
  qid INTEGER PRIMARY KEY AUTOINCREMENT,
  enqueued_at TEXT NOT NULL,
  kind TEXT NOT NULL,          -- instance_upsert|event|subscription_upsert|delivery_upsert|ssh_cred_upsert
  key TEXT,                   -- optional natural key
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_wq_kind ON write_queue(kind, qid);


-- Shortlink map (code -> long URL)
CREATE TABLE IF NOT EXISTS shortlinks (
  code TEXT PRIMARY KEY,
  long_url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  kind TEXT,
  delivery_id TEXT,
  provision_uuid TEXT,
  meta_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_shortlinks_expires ON shortlinks(expires_at);


-- Shortlink generation locks (provision_uuid+kind)
CREATE TABLE IF NOT EXISTS shortlink_locks (
  lock_key TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  code TEXT
);

-- Encrypted secrets tied to provision_uuid (OpenAI keys, etc.)
CREATE TABLE IF NOT EXISTS delivery_secrets (
  secret_id TEXT PRIMARY KEY,
  provision_uuid TEXT NOT NULL,
  kind TEXT NOT NULL,
  ciphertext BLOB NOT NULL,
  iv BLOB NOT NULL,
  tag BLOB NOT NULL,
  alg TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  meta_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_delivery_secrets_uuid ON delivery_secrets(provision_uuid, kind);

-- Outbound messaging tasks (welcome/guide retries with readiness gating)
CREATE TABLE IF NOT EXISTS outbound_tasks (
  task_id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  provision_uuid TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  lang TEXT,
  to_jid TEXT,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  next_run_at TEXT,
  last_error_code TEXT,
  last_error_detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  done_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbound_tasks_due ON outbound_tasks(status, next_run_at, created_at);
CREATE INDEX IF NOT EXISTS idx_outbound_tasks_delivery ON outbound_tasks(delivery_id, kind, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_tasks_active_unique ON outbound_tasks(delivery_id, kind) WHERE status IN ('QUEUED','RUNNING');
