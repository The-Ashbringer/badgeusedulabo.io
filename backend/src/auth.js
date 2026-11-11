
import {
  exchangeAuthorizationCode,
  validateAccessToken,
  getTwitchUser
} from "./twitch.js";

const SESSION_COOKIE = "labo_session";
const SESSION_DURATION = 7 * 24 * 60 * 60;
const OAUTH_STATE_DURATION = 10 * 60;

/**
 * Génère une chaîne aléatoire sécurisée.
 */
function randomString(length = 32) {
  const bytes = crypto.getRandomValues(
    new Uint8Array(length)
  );

  return Array.from(bytes)
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Encode une chaîne en Base64 URL-safe.
 */
function base64UrlEncode(value) {
  const bytes = new TextEncoder().encode(value);

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Décode une chaîne Base64 URL-safe.
 */
function base64UrlDecode(value) {
  const normalized = value
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  const padded = normalized.padEnd(
    Math.ceil(normalized.length / 4) * 4,
    "="
  );

  const binary = atob(padded);

  const bytes = Uint8Array.from(
    binary,
    character => character.charCodeAt(0)
  );

  return new TextDecoder().decode(bytes);
}

/**
 * Importe la clé de signature des sessions.
 */
async function getSigningKey(env) {
  if (!env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET_MISSING");
  }

  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.SESSION_SECRET),
    {
      name: "HMAC",
      hash: "SHA-256"
    },
    false,
    ["sign", "verify"]
  );
}

/**
 * Crée une session signée.
 */
async function createSession(user, env) {
  const payload = {
    id: user.id,
    login: user.login,
    displayName: user.displayName,
    profileImageUrl: user.profileImageUrl,
    exp: Math.floor(Date.now() / 1000) + SESSION_DURATION
  };

  const encodedPayload = base64UrlEncode(
    JSON.stringify(payload)
  );

  const key = await getSigningKey(env);

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(encodedPayload)
  );

  const encodedSignature = base64UrlEncode(
    String.fromCharCode(...new Uint8Array(signature))
  );

  return `${encodedPayload}.${encodedSignature}`;
}

/**
 * Vérifie une session signée.
 */
async function verifySession(token, env) {
  try {
    const parts = token.split(".");

    if (parts.length !== 2) {
      return null;
    }

    const [payload, signature] = parts;

    const key = await getSigningKey(env);

    const signatureBytes = Uint8Array.from(
      atob(
        signature
          .replace(/-/g, "+")
          .replace(/_/g, "/")
          .padEnd(
            Math.ceil(signature.length / 4) * 4,
            "="
          )
      ),
      character => character.charCodeAt(0)
    );

    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      signatureBytes,
      new TextEncoder().encode(payload)
    );

    if (!valid) {
      return null;
    }

    const session = JSON.parse(
      base64UrlDecode(payload)
    );

    if (!session.exp || session.exp <= Date.now() / 1000) {
      return null;
    }

    return session;
  } catch {
    return null;
  }
}

/**
 * Récupère le cookie de session.
 */
function getCookie(request, name) {
  const cookies = request.headers.get("Cookie") || "";

  const cookie = cookies
    .split(";")
    .map(value => value.trim())
    .find(value => value.startsWith(`${name}=`));

  return cookie
    ? cookie.substring(name.length + 1)
    : null;
}

/**
 * Retourne les informations de session.
 */
export async function getSession(request, env) {
  const token = getCookie(request, SESSION_COOKIE);

  if (!token) {
    return null;
  }

  return verifySession(token, env);
}

/**
 * Démarre l'authentification Twitch.
 */
export async function handleAuthStart(request, env) {
  if (!env.OAUTH_KV) {
    throw new Error("OAUTH_KV_MISSING");
  }

  const state = randomString();

  await env.OAUTH_KV.put(
    `oauth:${state}`,
    "valid",
    {
      expirationTtl: OAUTH_STATE_DURATION
    }
  );

  const params = new URLSearchParams({
    client_id: env.TWITCH_CLIENT_ID,
    redirect_uri: env.TWITCH_REDIRECT_URI,
    response_type: "code",
    scope: "",
    state
  });

  return Response.redirect(
    `https://id.twitch.tv/oauth2/authorize?${params}`,
    302
  );
}

/**
 * Traite le retour de Twitch après authentification.
 */
export async function handleAuthCallback(request, env) {
  const url = new URL(request.url);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const twitchError = url.searchParams.get("error");

  if (twitchError) {
    return Response.redirect(
      `${env.FRONTEND_URL}?auth=cancelled`,
      302
    );
  }

  if (!code || !state) {
    return Response.redirect(
      `${env.FRONTEND_URL}?auth=error`,
      302
    );
  }

  const stateKey = `oauth:${state}`;

  const savedState = await env.OAUTH_KV.get(stateKey);

  if (!savedState) {
    return Response.redirect(
      `${env.FRONTEND_URL}?auth=invalid_state`,
      302
    );
  }

  // Le state est supprimé avant de poursuivre :
  // il ne peut donc pas être réutilisé.
  await env.OAUTH_KV.delete(stateKey);

  try {
    const tokenData = await exchangeAuthorizationCode(
      code,
      env
    );

    const validation = await validateAccessToken(
      tokenData.access_token,
      env
    );

    if (!validation) {
      throw new Error("TWITCH_TOKEN_INVALID");
    }

    const user = await getTwitchUser(
      tokenData.access_token,
      env
    );

    const sessionToken = await createSession(user, env);

    const headers = new Headers({
      Location: `${env.FRONTEND_URL}?auth=success`,
      "Set-Cookie":
        `${SESSION_COOKIE}=${sessionToken}; ` +
        `HttpOnly; Secure; SameSite=None; Path=/; ` +
        `Max-Age=${SESSION_DURATION}`
    });

    return new Response(null, {
      status: 302,
      headers
    });
  } catch (error) {
    console.error("OAuth callback error:", error);

    return Response.redirect(
      `${env.FRONTEND_URL}?auth=error`,
      302
    );
  }
}

/**
 * Déconnecte l'utilisateur.
 */
export async function handleLogout(request, env) {
  return new Response(
    JSON.stringify({
      success: true
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie":
          `${SESSION_COOKIE}=; ` +
          "HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0"
      }
    }
  );
}
