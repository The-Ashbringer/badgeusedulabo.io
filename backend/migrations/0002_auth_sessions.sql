-- -----------------------------------------------------
-- AUTHENTIFICATION : CODES OAUTH ET SESSIONS
-- Migration additive : compatible avec une base ayant
-- déjà appliqué 0001_initial.sql.
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS auth_codes (
    code_hash TEXT PRIMARY KEY,
    twitch_user_id TEXT NOT NULL,
    twitch_login TEXT NOT NULL,
    display_name TEXT NOT NULL,
    profile_image_url TEXT,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_auth_codes_expiry
ON auth_codes(expires_at);


CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY,
    twitch_user_id TEXT NOT NULL,
    twitch_login TEXT NOT NULL,
    display_name TEXT NOT NULL,
    profile_image_url TEXT,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user
ON auth_sessions(twitch_user_id);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry
ON auth_sessions(expires_at);
