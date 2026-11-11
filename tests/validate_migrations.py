#!/usr/bin/env python3
"""Validation locale des migrations SQLite/D1 de la badgeuse."""

from pathlib import Path
import sqlite3
import sys

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "backend" / "migrations"


def main():
    migration_files = sorted(MIGRATIONS.glob("*.sql"))
    if not migration_files:
        raise RuntimeError("Aucune migration SQL trouvée.")

    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys = ON")

    for migration in migration_files:
        print(f"Application de {migration.name}...")
        db.executescript(migration.read_text(encoding="utf-8"))

    expected_tables = {
        "users",
        "badges",
        "auth_codes",
        "auth_sessions",
        "sync_locks",
    }
    actual_tables = {
        row[0]
        for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        )
    }
    missing = expected_tables - actual_tables
    if missing:
        raise RuntimeError(f"Tables manquantes : {', '.join(sorted(missing))}")

    # Vérifie les contraintes d'unicité et la clé étrangère des badges.
    db.execute(
        "INSERT INTO users (twitch_user_id, twitch_login, display_name) "
        "VALUES ('u1', 'alice', 'Alice')"
    )
    db.execute(
        "INSERT INTO badges (twitch_user_id, badge_date, badge_time) "
        "VALUES ('u1', '2026-11-11', '08:30:00')"
    )
    try:
        db.execute(
            "INSERT INTO badges (twitch_user_id, badge_date, badge_time) "
            "VALUES ('u1', '2026-11-11', '09:00:00')"
        )
    except sqlite3.IntegrityError:
        pass
    else:
        raise RuntimeError("La contrainte un badge par utilisateur et par jour ne fonctionne pas.")

    # Vérifie la consommation atomique et à usage unique d'un code OAuth.
    db.execute(
        "INSERT INTO auth_codes "
        "(code_hash, twitch_user_id, twitch_login, display_name, expires_at) "
        "VALUES ('hash1', 'u1', 'alice', 'Alice', 9999999999)"
    )
    consumed = db.execute(
        "DELETE FROM auth_codes WHERE code_hash = ? RETURNING twitch_user_id",
        ("hash1",),
    ).fetchone()
    replay = db.execute(
        "DELETE FROM auth_codes WHERE code_hash = ? RETURNING twitch_user_id",
        ("hash1",),
    ).fetchone()
    if consumed != ("u1",) or replay is not None:
        raise RuntimeError("Le code OAuth n'est pas consommé de manière unique.")

    # Vérifie l'exclusivité du verrou et sa reprise après expiration.
    db.execute(
        "INSERT INTO sync_locks (lock_name, lock_token, expires_at) "
        "VALUES ('sheets', 'token-a', 200)"
    )
    db.execute(
        """
        INSERT INTO sync_locks (lock_name, lock_token, expires_at)
        VALUES ('sheets', 'token-b', 300)
        ON CONFLICT(lock_name) DO UPDATE SET
            lock_token = excluded.lock_token,
            expires_at = excluded.expires_at
        WHERE sync_locks.expires_at < 100
        """
    )
    token = db.execute(
        "SELECT lock_token FROM sync_locks WHERE lock_name = 'sheets'"
    ).fetchone()[0]
    if token != "token-a":
        raise RuntimeError("Le verrou actif a été écrasé.")

    db.execute(
        """
        INSERT INTO sync_locks (lock_name, lock_token, expires_at)
        VALUES ('sheets', 'token-c', 400)
        ON CONFLICT(lock_name) DO UPDATE SET
            lock_token = excluded.lock_token,
            expires_at = excluded.expires_at
        WHERE sync_locks.expires_at < 250
        """
    )
    token = db.execute(
        "SELECT lock_token FROM sync_locks WHERE lock_name = 'sheets'"
    ).fetchone()[0]
    if token != "token-c":
        raise RuntimeError("Le verrou expiré n'a pas pu être repris.")

    db.execute("PRAGMA foreign_key_check")
    print(f"OK : {len(migration_files)} migrations appliquées, contraintes vérifiées.")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ÉCHEC : {exc}", file=sys.stderr)
        sys.exit(1)
