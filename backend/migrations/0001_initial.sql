
-- =====================================================
-- BADGEUSE TWITCH
-- Migration initiale de la base D1
-- =====================================================

PRAGMA foreign_keys = ON;


-- -----------------------------------------------------
-- UTILISATEURS TWITCH
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
    twitch_user_id TEXT PRIMARY KEY,

    twitch_login TEXT NOT NULL,
    display_name TEXT NOT NULL,
    profile_image_url TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);


CREATE INDEX IF NOT EXISTS idx_users_login
ON users(twitch_login COLLATE NOCASE);


-- -----------------------------------------------------
-- BADGES QUOTIDIENS
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS badges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    twitch_user_id TEXT NOT NULL,
    badge_date TEXT NOT NULL,
    badge_time TEXT NOT NULL,

    sheet_row INTEGER,

    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (
            status IN ('pending', 'recorded', 'failed')
        ),

    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (twitch_user_id)
        REFERENCES users(twitch_user_id)
        ON DELETE CASCADE,

    UNIQUE (twitch_user_id, badge_date)
);


-- -----------------------------------------------------
-- INDEX DE PERFORMANCE
-- -----------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_badges_date
ON badges(badge_date);


CREATE INDEX IF NOT EXISTS idx_badges_user
ON badges(twitch_user_id);


CREATE INDEX IF NOT EXISTS idx_badges_status
ON badges(status);


CREATE INDEX IF NOT EXISTS idx_badges_pending
ON badges(status, badge_date)
WHERE status IN ('pending', 'failed');
