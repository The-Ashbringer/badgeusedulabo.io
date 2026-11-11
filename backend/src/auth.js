
/**
 * BADGEUSE DU LABO
 * Authentification Twitch et gestion des sessions
 *
 * Fichier : backend/src/auth.js
 */

const TWITCH_AUTHORIZE_URL =
    "https://id.twitch.tv/oauth2/authorize";

const TWITCH_TOKEN_URL =
    "https://id.twitch.tv/oauth2/token";

const TWITCH_VALIDATE_URL =
    "https://id.twitch.tv/oauth2/validate";

const TWITCH_USERS_URL =
    "https://api.twitch.tv/helix/users";

const SESSION_COOKIE = "labo_session";
const SESSION_DURATION = 7 * 24 * 60 * 60;
const OAUTH_STATE_DURATION = 10 * 60;


/* ========================================
   OUTILS CRYPTOGRAPHIQUES
======================================== */

function toBase64Url(bytes) {
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}


function fromBase64Url(value) {
    const base64 = value
        .replace(/-/g, "+")
        .replace(/_/g, "/");

    const padded = base64.padEnd(
        Math.ceil(base64.length / 4) * 4,
        "="
    );

    const binary = atob(padded);

    return Uint8Array.from(
        binary,
        character => character.charCodeAt(0)
    );
}


function randomToken(length = 32) {
    const bytes = crypto.getRandomValues(
        new Uint8Array(length)
    );

    return toBase64Url(bytes);
}


async function getSigningKey(env) {
    if (!env.SESSION_SECRET) {
        throw new Error("SESSION_SECRET non configuré.");
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


async function signPayload(payload, env) {
    const encoded = toBase64Url(
        new TextEncoder().encode(
            JSON.stringify(payload)
        )
    );

    const key = await getSigningKey(env);

    const signature = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(encoded)
    );

    return `${encoded}.${toBase64Url(
        new Uint8Array(signature)
    )}`;
}


/* ========================================
   SESSION
======================================== */

async function createSession(user, env) {
    const now = Math.floor(Date.now() / 1000);

    const payload = {
        user: {
            id: String(user.id),
            login: String(user.login)
        },
        iat: now,
        exp: now + SESSION_DURATION
    };

    return signPayload(payload, env);
}


async function verifySession(token, env) {
    if (!token || token.length > 4096) {
        return null;
    }

    const parts = token.split(".");

    if (parts.length !== 2) {
        return null;
    }

    try {
        const [encoded, signature] = parts;

        const key = await getSigningKey(env);

        const valid = await crypto.subtle.verify(
            "HMAC",
            key,
            fromBase64Url(signature),
            new TextEncoder().encode(encoded)
        );

        if (!valid) {
            return null;
        }

        const payload = JSON.parse(
            new TextDecoder().decode(
                fromBase64Url(encoded)
            )
        );

        const now = Math.floor(Date.now() / 1000);

        if (
            !payload.user ||
            !payload.user.id ||
            !payload.user.login ||
            !Number.isInteger(payload.exp) ||
            payload.exp <= now
        ) {
            return null;
        }

        return payload;

    } catch {
        return null;
    }
}


function getCookie(request, name) {
    const cookies = request.headers.get("Cookie") || "";

    const entry = cookies
        .split(";")
        .map(cookie => cookie.trim())
        .find(cookie => cookie.startsWith(`${name}=`));

    return entry
        ? entry.substring(name.length + 1)
        : null;
}


function sessionCookie(token) {
    return [
        `${SESSION_COOKIE}=${token}`,
        "HttpOnly",
        "Secure",
        "SameSite=None",
        "Path=/",
        `Max-Age=${SESSION_DURATION}`
    ].join("; ");
}


function clearSessionCookie() {
    return [
        `${SESSION_COOKIE}=`,
        "HttpOnly",
        "Secure",
        "SameSite=None",
        "Path=/",
        "Max-Age=0"
    ].join("; ");
}


export async function getSession(request, env) {
    const token = getCookie(request, SESSION_COOKIE);

    if (!token) {
        return null;
    }

    return verifySession(token, env);
}


/* ========================================
   OAUTH : VERIFICATIONS
======================================== */

function validateConfig(env) {
    const required = [
        "TWITCH_CLIENT_ID",
        "TWITCH_CLIENT_SECRET",
        "TWITCH_REDIRECT_URI",
        "FRONTEND_URL",
        "SESSION_SECRET"
    ];

    for (const name of required) {
        if (!env[name]) {
            throw new Error(
                `Configuration manquante : ${name}`
            );
        }
    }

    if (!env.OAUTH_KV) {
        throw new Error("Binding OAUTH_KV manquant.");
    }
}


function frontendRedirect(env, status) {
    const url = new URL(env.FRONTEND_URL);

    if (status) {
        url.searchParams.set("auth_error", status);
    }

    return Response.redirect(url.toString(), 302);
}


/* ========================================
   OAUTH : DEMARRAGE
======================================== */

export async function handleAuthStart(request, env) {
    validateConfig(env);

    const state = randomToken(32);

    await env.OAUTH_KV.put(
        `oauth:${state}`,
        JSON.stringify({
            createdAt: Date.now()
        }),
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

    const redirectUrl =
        `${TWITCH_AUTHORIZE_URL}?${params.toString()}`;

    return Response.redirect(redirectUrl, 302);
}


/* ========================================
   OAUTH : ECHANGE DU CODE
======================================== */

async function exchangeCode(code, env) {
    const response = await fetch(TWITCH_TOKEN_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
            client_id: env.TWITCH_CLIENT_ID,
            client_secret: env.TWITCH_CLIENT_SECRET,
            code,
            grant_type: "authorization_code",
            redirect_uri: env.TWITCH_REDIRECT_URI
        })
    });

    if (!response.ok) {
        throw new Error("Échec de l'échange OAuth Twitch.");
    }

    const data = await response.json();

    if (!data.access_token) {
        throw new Error("Token Twitch absent.");
    }

    return data.access_token;
}


/* ========================================
   OAUTH : VALIDATION DU TOKEN
======================================== */

async function validateTwitchToken(token, env) {
    const response = await fetch(TWITCH_VALIDATE_URL, {
        headers: {
            Authorization: `OAuth ${token}`
        }
    });

    if (!response.ok) {
        throw new Error("Token Twitch invalide.");
    }

    const data = await response.json();

    if (data.client_id !== env.TWITCH_CLIENT_ID) {
        throw new Error("Client Twitch inattendu.");
    }

    if (!data.user_id) {
        throw new Error("Identité Twitch introuvable.");
    }

    return data;
}


/* ========================================
   RECUPERATION DU PROFIL TWITCH
======================================== */

async function getTwitchUser(token, env) {
    const response = await fetch(TWITCH_USERS_URL, {
        headers: {
            "Client-Id": env.TWITCH_CLIENT_ID,
            Authorization: `Bearer ${token}`
        }
    });

    if (!response.ok) {
        throw new Error("Impossible de récupérer le profil Twitch.");
    }

    const data = await response.json();
    const user = data.data?.[0];

    if (!user) {
        throw new Error("Profil Twitch introuvable.");
    }

    return {
        id: String(user.id),
        login: user.login
    };
}


/* ========================================
   OAUTH : CALLBACK
======================================== */

export async function handleAuthCallback(request, env) {
    validateConfig(env);

    const url = new URL(request.url);

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const oauthError = url.searchParams.get("error");

    if (oauthError) {
        return frontendRedirect(env, "access_denied");
    }

    if (!code || !state) {
        return frontendRedirect(env, "invalid_callback");
    }

    // Vérification et consommation du state.
    const stateKey = `oauth:${state}`;

    const storedState = await env.OAUTH_KV.get(stateKey);

    if (!storedState) {
        return frontendRedirect(env, "invalid_state");
    }

    await env.OAUTH_KV.delete(stateKey);

    try {
        const token = await exchangeCode(code, env);

        const validation = await validateTwitchToken(
            token,
            env
        );

        const user = await getTwitchUser(token, env);

        if (user.id !== String(validation.user_id)) {
            throw new Error("Identité Twitch incohérente.");
        }

        const session = await createSession(user, env);

        return new Response(null, {
            status: 302,
            headers: {
                Location: env.FRONTEND_URL,
                "Cache-Control": "no-store",
                "Set-Cookie": sessionCookie(session)
            }
        });

    } catch (error) {
        console.error("Erreur OAuth :", error);

        return frontendRedirect(env, "authentication_failed");
    }
}


/* ========================================
   DECONNEXION
======================================== */

export async function handleLogout(request, env) {
    return new Response(
        JSON.stringify({
            success: true,
            message: "Déconnexion effectuée."
        }),
        {
            status: 200,
            headers: {
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
                "Set-Cookie": clearSessionCookie()
            }
        }
    );
}
