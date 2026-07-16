-- Personal Access Tokens for server-mode MCP/agent access.
-- Local-only table: not part of device sync.
CREATE TABLE personal_access_tokens (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    token_prefix TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    scopes_json TEXT NOT NULL DEFAULT '[]',
    expires_at TEXT,
    last_used_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_pat_prefix ON personal_access_tokens (token_prefix);
-- Audit log for MCP/agent tool execution (desktop and server modes).
-- Local-only table: not part of device sync. Rows kept until manual purge.
CREATE TABLE mcp_audit_log (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL,
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('local_token', 'pat', 'desktop_bridge')),
    actor_fingerprint TEXT NOT NULL,
    tool TEXT NOT NULL,
    scopes_json TEXT NOT NULL DEFAULT '[]',
    args_summary TEXT,
    outcome TEXT NOT NULL CHECK (outcome IN ('success', 'denied', 'error')),
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_mcp_audit_created_tool ON mcp_audit_log (created_at, tool);
