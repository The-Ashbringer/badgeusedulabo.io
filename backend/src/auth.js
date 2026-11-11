import {
  exchangeAuthorizationCode,
  validateAccessToken,
  getTwitchUser
} from "./twitch.js";

const SESSION_DURATION = 7 * 24 * 60 * 60;
const OAUTH_STATE_DURATION = 10 * 60;
const LOGIN_CODE_DURATION = 2 * 60;

function randomString(length = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes)
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hashToken(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );

  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

function getDatabase(env) {
  if (!env.DB) throw new Error("D1_DATABASE_MISSING");
  return env.DB;
}

function getBearerToken(request) {
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+([a-f0-9]{64})$/i);
  return match ? match[1] : null;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

/**
 * Récupère la session depuis un jeton Bearer opaque.
 * Seul le hash SHA-256 du jeton est conservé dans D1.
 */
export async function getSession(request, env) {
  const token = getBearerToken(request);
  if (!token) return null;

  const tokenHash = await hashToken(token);
  const now = Math.floor(Date.now() / 1000);

  const session = await getDatabase(env).prepare(`
    SELECT
      twitch_user_id AS id,
      twitch_login AS login,
      display_name AS displayName,
      profile_image_url AS profileImageUrl
    FROM auth_sessions
    WHERE token_hash = ?
      AND expires_at > ?
  `).bind(tokenHash, now).first();

  return session || null;
}

/**
 * Démarre le flux OAuth Twitch.
 */
export async function handleAuthStart(request, env) {
  if (!env.OAUTH_KV) throw new Error("OAUTH_KV_MISSING");

  const state = randomString();

  await env.OAUTH_KV.put(`oauth:${state}`, "valid", {
    expirationTtl: OAUTH_STATE_DURATION
  });

  const params = new URLSearchParams({
    client_id: env.TWITCH_CLIENT_ID,
    redirect_uri: env.TWITCH_REDIRECT_URI,
    response_type: "code",
    state
  });

  return Response.redirect(
    `https://id.twitch.tv/oauth2/authorize?${params}`,
    302
  );
}

/**
 * Retour OAuth Twitch : crée un code temporaire à usage unique.
 * Le code est transmis dans le fragment URL, jamais dans une requête HTTP.
 */
export async function handleAuthCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const twitchError = url.searchParams.get("error");

  if (twitchError) {
    return Response.redirect(`${env.FRONTEND_URL}?auth=cancelled`, 302);
  }

  if (!code || !state) {
    return Response.redirect(`${env.FRONTEND_URL}?auth=error`, 302);
  }

  if (!env.OAUTH_KV) throw new Error("OAUTH_KV_MISSING");

  const stateKey = `oauth:${state}`;
  const savedState = await env.OAUTH_KV.get(stateKey);

  if (!savedState) {
    return Response.redirect(`${env.FRONTEND_URL}?auth=invalid_state`, 302);
  }

  await env.OAUTH_KV.delete(stateKey);

  try {
    const tokenData = await exchangeAuthorizationCode(code, env);
    const validation = await validateAccessToken(tokenData.access_token, env);

    if (!validation) throw new Error("TWITCH_TOKEN_INVALID");

    const user = await getTwitchUser(tokenData.access_token, env);
    const loginCode = randomString(32);
    const codeHash = await hashToken(loginCode);
    const now = Math.floor(Date.now() / 1000);
    const db = getDatabase(env);

    // Nettoyage opportuniste des codes et sessions expirés.
    await db.prepare(`
      DELETE FROM auth_codes WHERE expires_at <= ?
    `).bind(now).run();

    await db.prepare(`
      DELETE FROM auth_sessions WHERE expires_at <= ?
    `).bind(now).run();

    await db.prepare(`
      INSERT INTO auth_codes (
        code_hash,
        twitch_user_id,
        twitch_login,
        display_name,
        profile_image_url,
        expires_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      codeHash,
      String(user.id),
      user.login,
      user.displayName,
      user.profileImageUrl || null,
      now + LOGIN_CODE_DURATION
    ).run();

    const destination = new URL(env.FRONTEND_URL);
    destination.hash = `auth_code=${loginCode}`;

    return new Response(null, {
      status: 302,
      headers: {
        Location: destination.toString(),
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer"
      }
    });
  } catch (error) {
    console.error("OAuth callback error:", error);
    return Response.redirect(`${env.FRONTEND_URL}?auth=error`, 302);
  }
}

/**
 * Échange atomiquement un code de connexion contre une session.
 * DELETE ... RETURNING empêche la réutilisation du code.
 */
export async function handleAuthExchange(request, env) {
  let body;

  try {
    body = await request.json();
  } catch {
    return jsonResponse({ code: "INVALID_REQUEST", message: "Requête invalide." }, 400);
  }

  const loginCode = body?.code;
  if (typeof loginCode !== "string" || !/^[a-f0-9]{64}$/i.test(loginCode)) {
    return jsonResponse({ code: "INVALID_LOGIN_CODE", message: "Code de connexion invalide." }, 400);
  }

  const db = getDatabase(env);
  const codeHash = await hashToken(loginCode);
  const now = Math.floor(Date.now() / 1000);

  const login = await db.prepare(`
    DELETE FROM auth_codes
    WHERE code_hash = ?
      AND expires_at > ?
    RETURNING
      twitch_user_id,
      twitch_login,
      display_name,
      profile_image_url
  `).bind(codeHash, now).first();

  if (!login) {
    return jsonResponse({ code: "LOGIN_CODE_EXPIRED", message: "Le code de connexion a expiré. Recommence la connexion Twitch." }, 401);
  }

  const sessionToken = randomString(32);
  const tokenHash = await hashToken(sessionToken);

  await db.prepare(`
    INSERT INTO auth_sessions (
      token_hash,
      twitch_user_id,
      twitch_login,
      display_name,
      profile_image_url,
      expires_at
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    tokenHash,
    login.twitch_user_id,
    login.twitch_login,
    login.display_name,
    login.profile_image_url,
    now + SESSION_DURATION
  ).run();

  return jsonResponse({
    token: sessionToken,
    expiresIn: SESSION_DURATION,
    user: {
      id: login.twitch_user_id,
      login: login.twitch_login,
      displayName: login.display_name,
      profileImageUrl: login.profile_image_url
    }
  });
}

/**
 * Révoque la session courante.
 */
export async function handleLogout(request, env) {
  const token = getBearerToken(request);

  if (token) {
    const tokenHash = await hashToken(token);

    await getDatabase(env).prepare(`
      DELETE FROM auth_sessions
      WHERE token_hash = ?
    `).bind(tokenHash).run();
  }

  return jsonResponse({ success: true });
}
