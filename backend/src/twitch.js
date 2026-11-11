
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
