
/**
 * database.js
 *
 * Gestion centralisée de la base D1.
 * Binding Cloudflare : env.DB
 */

/**
 * Vérifie que la base D1 est disponible.
 */
function getDatabase(env) {
  if (!env.DB) {
    throw new Error("D1_DATABASE_MISSING");
  }

  return env.DB;
}

/**
 * Enregistre ou actualise un utilisateur Twitch.
 */
export async function upsertUser(user, env) {
  const db = getDatabase(env);

  if (!user?.id || !user?.login) {
    throw new Error("INVALID_TWITCH_USER");
  }

  await db.prepare(`
    INSERT INTO users (
      twitch_user_id,
      twitch_login,
      display_name,
      profile_image_url
    )
    VALUES (?, ?, ?, ?)
    ON CONFLICT(twitch_user_id)
    DO UPDATE SET
      twitch_login = excluded.twitch_login,
      display_name = excluded.display_name,
      profile_image_url = excluded.profile_image_url,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).bind(
    String(user.id),
    user.login,
    user.displayName || user.login,
    user.profileImageUrl || null
  ).run();

  return true;
}

/**
 * Récupère les informations d'un utilisateur.
 */
export async function getUser(userId, env) {
  const db = getDatabase(env);

  const result = await db.prepare(`
    SELECT *
    FROM users
    WHERE twitch_user_id = ?
  `).bind(String(userId)).first();

  return result || null;
}

/**
 * Récupère le badge d'un utilisateur pour une date.
 */
export async function getBadge(userId, date, env) {
  const db = getDatabase(env);

  return await db.prepare(`
    SELECT *
    FROM badges
    WHERE twitch_user_id = ?
      AND badge_date = ?
  `).bind(
    String(userId),
    date
  ).first();
}

/**
 * Vérifie si l'utilisateur a déjà badgé.
 */
export async function getBadgeStatus(userId, date, env) {
  const db = getDatabase(env);

  const badge = await db.prepare(`
    SELECT *,
      CASE
        WHEN status = 'pending'
          AND julianday(updated_at) >= julianday('now', '-2 minutes')
        THEN 1
        ELSE 0
      END AS active_pending
    FROM badges
    WHERE twitch_user_id = ?
      AND badge_date = ?
  `).bind(String(userId), date).first();

  return {
    hasBadged: badge?.status === "recorded",
    pending: Boolean(badge?.active_pending),
    badge: badge || null
  };
}

/**
 * Réserve un badge pour un utilisateur et une date.
 *
 * La contrainte UNIQUE de D1 empêche deux réservations
 * simultanées pour le même compte et la même journée.
 *
 * Un badge en échec peut être repris.
 */
export async function reserveBadge(
  userId,
  date,
  time,
  env
) {
  const db = getDatabase(env);

  const id = String(userId);

  // Première tentative : création d'une réservation.
  const insertion = await db.prepare(`
    INSERT INTO badges (
      twitch_user_id,
      badge_date,
      badge_time,
      status,
      attempt_count
    )
    VALUES (?, ?, ?, 'pending', 1)
    ON CONFLICT(twitch_user_id, badge_date)
    DO NOTHING
  `).bind(id, date, time).run();

  if (insertion.meta?.changes > 0) {
    return {
      success: true,
      status: "reserved",
      created: true
    };
  }

  // Une réservation existe déjà.
  const existing = await getBadge(id, date, env);

  if (!existing) {
    throw new Error("BADGE_RESERVATION_INCONSISTENT");
  }

  if (existing.status === "recorded") {
    return {
      success: false,
      status: "already_recorded",
      badge: existing
    };
  }

  // Reprise d'un badge échoué ou d'une réservation pending
  // abandonnée depuis plus de deux minutes (crash/interruption Worker).
  if (existing.status === "failed" || existing.status === "pending") {
    const retry = await db.prepare(`
      UPDATE badges
      SET
        badge_time = ?,
        status = 'pending',
        attempt_count = attempt_count + 1,
        last_error = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE twitch_user_id = ?
        AND badge_date = ?
        AND (
          status = 'failed'
          OR (
            status = 'pending'
            AND julianday(updated_at) < julianday('now', '-2 minutes')
          )
        )
    `).bind(time, id, date).run();

    if (retry.meta?.changes > 0) {
      return {
        success: true,
        status: "reserved",
        created: false
      };
    }

    return {
      success: false,
      status: "already_pending",
      badge: await getBadge(id, date, env)
    };
  }

  throw new Error("UNKNOWN_BADGE_STATUS");
}

/**
 * Confirme l'écriture dans Google Sheets.
 */
export async function markBadgeRecorded(
  userId,
  date,
  sheetRow,
  env
) {
  const db = getDatabase(env);

  const result = await db.prepare(`
    UPDATE badges
    SET
      status = 'recorded',
      sheet_row = ?,
      last_error = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE twitch_user_id = ?
      AND badge_date = ?
      AND status = 'pending'
  `).bind(
    sheetRow ?? null,
    String(userId),
    date
  ).run();

  return result.meta?.changes > 0;
}

/**
 * Signale un échec d'écriture.
 * Le badge pourra être repris ultérieurement.
 */
export async function markBadgeFailed(
  userId,
  date,
  error,
  env
) {
  const db = getDatabase(env);

  const result = await db.prepare(`
    UPDATE badges
    SET
      status = 'failed',
      last_error = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE twitch_user_id = ?
      AND badge_date = ?
      AND status = 'pending'
  `).bind(
    String(error?.message || error || "UNKNOWN_ERROR").slice(0, 500),
    String(userId),
    date
  ).run();

  return result.meta?.changes > 0;
}

/**
 * Liste les badges qui nécessitent une reprise.
 */
export async function getPendingBadges(env) {
  const db = getDatabase(env);

  const result = await db.prepare(`
    SELECT
      b.*,
      u.twitch_login,
      u.display_name
    FROM badges b
    INNER JOIN users u
      ON u.twitch_user_id = b.twitch_user_id
    WHERE b.status IN ('pending', 'failed')
    ORDER BY b.badge_date ASC, b.badge_time ASC
  `).all();

  return result.results || [];
}
