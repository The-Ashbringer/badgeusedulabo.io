
-- =====================================================
-- BADGEUSE TWITCH
-- Migration initiale
-- =====================================================

-- Comptes Twitch connus
CREATE TABLE IF NOT EXISTS users (
    twitch_user_id TEXT PRIMARY KEY,
    twitch_login TEXT NOT NULL,
    display_name TEXT NOT NULL,
    profile_image_url TEXT,
    created_at TEXT NOT NULL DEFAULT (
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    ),
    updated_at TEXT NOT NULL DEFAULT (
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
);

-- Historique des badges
CREATE TABLE IF NOT EXISTS badges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    twitch_user_id TEXT NOT NULL,

    -- Date au format YYYY-MM-DD
    -- Calculée côté Worker avec Europe/Paris
    badge_date TEXT NOT NULL,

    -- Heure au format HH:MM:SS
    badge_time TEXT NOT NULL,

    -- Ligne correspondante dans Google Sheets
    sheet_row INTEGER,

    -- pending : écriture en cours
    -- recorded : écriture confirmée
    -- failed : échec à traiter
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'recorded', 'failed')),

    created_at TEXT NOT NULL DEFAULT (
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    ),

    updated_at TEXT NOT NULL DEFAULT (
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    ),

    FOREIGN KEY (twitch_user_id)
        REFERENCES users(twitch_user_id)
        ON DELETE RESTRICT,

    -- Un seul badge par compte et par journée
    UNIQUE (twitch_user_id, badge_date)
);

-- Accélère la consultation de l'historique
CREATE INDEX IF NOT EXISTS idx_badges_date
ON badges(badge_date);

CREATE INDEX IF NOT EXISTS idx_badges_user
ON badges(twitch_user_id);

CREATE INDEX IF NOT EXISTS idx_badges_status
ON badges(status);
