-- Verrou atomique pour sérialiser les reconstructions de la grille Google Sheets.
-- Le bail expire automatiquement après cinq minutes en cas d'arrêt brutal du Worker.

CREATE TABLE IF NOT EXISTS sync_locks (
    lock_name TEXT PRIMARY KEY,
    lock_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_locks_expiry
ON sync_locks(expires_at);
