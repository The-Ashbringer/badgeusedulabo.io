
const TWITCH_TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const TWITCH_VALIDATE_URL = "https://id.twitch.tv/oauth2/validate";
const TWITCH_USERS_URL = "https://api.twitch.tv/helix/users";

/**
 * Échange le code OAuth reçu de Twitch
 * contre un access token.
 */
export async function exchangeAuthorizationCode(code, env) {
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

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `TWITCH_TOKEN_ERROR: ${data.message || response.status}`
    );
  }

  if (!data.access_token) {
    throw new Error("TWITCH_TOKEN_MISSING");
  }

  return data;
}

/**
 * Vérifie la validité d'un access token Twitch.
 */
export async function validateAccessToken(accessToken, env) {
  const response = await fetch(TWITCH_VALIDATE_URL, {
    headers: {
      Authorization: `OAuth ${accessToken}`
    }
  });

  if (response.status === 401) {
    return null;
  }

  if (!response.ok) {
    throw new Error(
      `TWITCH_VALIDATION_ERROR: ${response.status}`
    );
  }

  const data = await response.json();

  // Vérification que le token appartient
  // bien à notre application Twitch.
  if (data.client_id !== env.TWITCH_CLIENT_ID) {
    throw new Error("TWITCH_CLIENT_ID_MISMATCH");
  }

  return data;
}

/**
 * Récupère le profil Twitch associé au token.
 */
export async function getTwitchUser(accessToken, env) {
  const response = await fetch(TWITCH_USERS_URL, {
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Client-Id": env.TWITCH_CLIENT_ID
    }
  });

  if (!response.ok) {
    throw new Error(
      `TWITCH_USER_ERROR: ${response.status}`
    );
  }

  const data = await response.json();
  const user = data.data?.[0];

  if (!user) {
    throw new Error("TWITCH_USER_NOT_FOUND");
  }

  return {
    id: user.id,
    login: user.login,
    displayName: user.display_name,
    profileImageUrl: user.profile_image_url
  };
}


let appTokenCache = null;
let appTokenExpiresAt = 0;

/**
 * Obtient un jeton applicatif Twitch (client credentials).
 * Ce jeton reste côté Worker et n'est jamais transmis au navigateur.
 */
async function getAppAccessToken(env) {
  if (appTokenCache && Date.now() < appTokenExpiresAt) {
    return appTokenCache;
  }

  const response = await fetch(TWITCH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      grant_type: "client_credentials"
    })
  });

  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(`TWITCH_APP_TOKEN_ERROR: ${data.message || response.status}`);
  }

  appTokenCache = data.access_token;
  appTokenExpiresAt = Date.now() + Math.max(0, data.expires_in - 60) * 1000;
  return appTokenCache;
}

async function helixGet(path, env) {
  const token = await getAppAccessToken(env);
  const response = await fetch(`https://api.twitch.tv/helix/${path}`, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Client-Id": env.TWITCH_CLIENT_ID
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`TWITCH_HELIX_ERROR: ${response.status} ${body.slice(0, 200)}`);
  }
  return response.json();
}

function normalizeTwitchName(value) {
  return String(value || "").normalize("NFKC").trim().toLocaleLowerCase("fr");
}

/**
 * Résout des pseudos historiques sans écrire en base.
 * La recherche Helix /users est exacte sur le login.
 * En complément, /search/channels ne couvre que les diffuseurs :
 * ses résultats sont donc des pistes, jamais des associations automatiques.
 */
export async function lookupLegacyTwitchAccounts(names, env) {
  if (!Array.isArray(names) || names.length > 50 ||
      names.some(name =>
        typeof name !== "string" ||
        name.trim().length === 0 ||
        name.length > 100
      )) {
    throw new Error("INVALID_LOOKUP_NAMES");
  }

  const cleaned = [...new Set(names
    .filter(name => typeof name === "string")
    .map(name => name.trim())
    .filter(Boolean))];

  // Get Users accepte jusqu'à 100 logins dans un seul appel.
  // Les pseudos historiques qui ne peuvent pas être des logins Twitch
  // (espaces, emoji, caractères spéciaux) sont exclus de cette recherche exacte.
  const exactLogins = cleaned.filter(name => /^[a-z0-9_]{1,25}$/i.test(name));
  const exactParams = new URLSearchParams();
  for (const login of exactLogins) exactParams.append("login", login.toLowerCase());

  const exactUsers = exactLogins.length
    ? await helixGet(`users?${exactParams}`, env)
    : { data: [] };

  const exactByLogin = new Map(
    (exactUsers.data || []).map(user => [user.login.toLowerCase(), user])
  );

  const results = [];
  for (const legacyName of cleaned) {
    const exactUser = exactByLogin.get(legacyName.toLowerCase()) || null;
    const channelSearch = await helixGet(
      `search/channels?${new URLSearchParams({ query: legacyName, first: "100", live_only: "false" })}`,
      env
    );

    const channelCandidates = (channelSearch.data || [])
      .filter(item =>
        normalizeTwitchName(item.display_name) === normalizeTwitchName(legacyName) ||
        normalizeTwitchName(item.broadcaster_login) === normalizeTwitchName(legacyName)
      )
      .map(item => ({
        id: item.id,
        login: item.broadcaster_login,
        displayName: item.display_name
      }));

    results.push({
      legacyName,
      exactLoginMatch: exactUser ? {
        id: exactUser.id,
        login: exactUser.login,
        displayName: exactUser.display_name
      } : null,
      channelCandidates,
      status: exactUser ? "exact_login_match" :
        channelCandidates.length === 1 ? "channel_candidate" :
        channelCandidates.length > 1 ? "multiple_candidates" : "not_found"
    });
  }

  return results;
}
