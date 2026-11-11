
/**
 * google-sheets.js
 *
 * Synchronisation entre D1 et Google Sheets.
 *
 * Onglet BADGEUSE :
 *   Ligne 1 : titre (préservé)
 *   Ligne 2 : pseudo + dates
 *   Ligne 3+ : utilisateurs triés alphabétiquement
 *
 * Onglet CONFIG :
 *   C2 : date de début
 *   C3 : date de fin
 *   C5 : fuseau horaire
 *   A8:B21 : dates et journées prévues
 */

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_SCOPE =
  "https://www.googleapis.com/auth/spreadsheets";

const DEFAULT_BADGEUSE_TAB = "BADGEUSE";
const DEFAULT_CONFIG_TAB = "CONFIG";
const TIMEZONE = "Europe/Paris";

let cachedToken = null;
let tokenExpiration = 0;

/* =====================================================
   OUTILS GÉNÉRAUX
===================================================== */

function base64UrlEncode(bytes) {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function stringToBase64Url(value) {
  return base64UrlEncode(
    new TextEncoder().encode(value)
  );
}

function getTabName(env, variable, fallback) {
  return env[variable] || fallback;
}

function escapeSheetName(name) {
  return `'${name.replace(/'/g, "''")}'`;
}

function normalizeDate(value) {
  if (typeof value === "number") {
    const date = new Date(
      Date.UTC(1899, 11, 30) +
      value * 86400000
    );

    return date.toISOString().slice(0, 10);
  }

  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const input = value.trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const parsed = new Date(`${input}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === input
      ? input
      : null;
  }

  const frenchDate = input.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/
  );

  if (frenchDate) {
    const [, day, month, year] = frenchDate;

    const normalized = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    const parsed = new Date(`${normalized}T00:00:00Z`);

    return !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === normalized
      ? normalized
      : null;
  }

  return null;
}

function formatDate(date) {
  const [year, month, day] = date.split("-");

  return `${day}/${month}`;
}

function getWeekday(date) {
  return new Intl.DateTimeFormat("fr-FR", {
    weekday: "short",
    timeZone: "UTC"
  }).format(new Date(`${date}T12:00:00Z`));
}

function makeColumnLetter(index) {
  let result = "";

  while (index > 0) {
    const remainder = (index - 1) % 26;

    result =
      String.fromCharCode(65 + remainder) + result;

    index = Math.floor((index - 1) / 26);
  }

  return result;
}

/* =====================================================
   AUTHENTIFICATION GOOGLE
===================================================== */

async function getGoogleAccessToken(env) {
  if (
    cachedToken &&
    Date.now() < tokenExpiration
  ) {
    return cachedToken;
  }

  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_MISSING");
  }

  let serviceAccount;

  try {
    serviceAccount = JSON.parse(
      env.GOOGLE_SERVICE_ACCOUNT_JSON
    );
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_INVALID_JSON");
  }

  if (
    !serviceAccount.client_email ||
    !serviceAccount.private_key
  ) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_INVALID");
  }

  const now = Math.floor(Date.now() / 1000);

  const header = stringToBase64Url(
    JSON.stringify({
      alg: "RS256",
      typ: "JWT"
    })
  );

  const payload = stringToBase64Url(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope: GOOGLE_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: now,
      exp: now + 3600
    })
  );

  const unsignedToken = `${header}.${payload}`;

  const privateKeyPem = serviceAccount.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");

  const privateKeyBytes = Uint8Array.from(
    atob(privateKeyPem),
    character => character.charCodeAt(0)
  );

  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    privateKeyBytes,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(unsignedToken)
  );

  const jwt =
    `${unsignedToken}.${base64UrlEncode(new Uint8Array(signature))}`;

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    })
  });

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    throw new Error(
      `GOOGLE_AUTH_ERROR: ${data.error_description || data.error || response.status}`
    );
  }

  cachedToken = data.access_token;
  tokenExpiration = Date.now() + (data.expires_in - 60) * 1000;

  return cachedToken;
}

/* =====================================================
   APPELS GOOGLE SHEETS API
===================================================== */

async function googleRequest(path, env, options = {}) {
  const token = await getGoogleAccessToken(env);

  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}${path}`,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...options.headers
      }
    }
  );

  if (!response.ok) {
    const error = await response.text();

    throw new Error(
      `GOOGLE_SHEETS_ERROR: ${response.status} ${error}`
    );
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function getSheetMetadata(env) {
  const data = await googleRequest(
    "?fields=sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))",
    env
  );

  return data.sheets || [];
}

async function getSheetId(tabName, env) {
  const sheets = await getSheetMetadata(env);

  const sheet = sheets.find(
    item => item.properties.title === tabName
  );

  if (!sheet) {
    throw new Error(`SHEET_NOT_FOUND: ${tabName}`);
  }

  return sheet.properties.sheetId;
}

async function readRange(range, env) {
  const data = await googleRequest(
    `/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`,
    env
  );

  return data.values || [];
}

/* =====================================================
   CONFIGURATION DU PLANNING
===================================================== */

export async function getPlanning(env) {
  if (!env.SPREADSHEET_ID) {
    throw new Error("SPREADSHEET_ID_MISSING");
  }

  const configTab = getTabName(
    env,
    "CONFIG_TAB",
    DEFAULT_CONFIG_TAB
  );

  const quotedTab = escapeSheetName(configTab);

  const [generalConfig, planningRows] = await Promise.all([
    readRange(`${quotedTab}!C2:C5`, env),
    readRange(`${quotedTab}!A8:B21`, env)
  ]);

  const startDate = normalizeDate(
    generalConfig[0]?.[0]
  );

  const endDate = normalizeDate(
    generalConfig[1]?.[0]
  );

  const timezone = generalConfig[3]?.[0] || TIMEZONE;

  if (timezone !== TIMEZONE) {
    throw new Error("UNSUPPORTED_TIMEZONE");
  }

  if (!startDate || !endDate || startDate > endDate) {
    throw new Error("INVALID_PLANNING_PERIOD");
  }

  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const dayCount = Math.round((end - start) / 86400000) + 1;

  if (dayCount < 1 || dayCount > 14) {
    throw new Error("PLANNING_PERIOD_MUST_BE_1_TO_14_DAYS");
  }

  const configuredByDate = new Map();

  for (const row of planningRows) {
    const date = normalizeDate(row[0]);
    if (!date || date < startDate || date > endDate) continue;

    if (configuredByDate.has(date)) {
      throw new Error("DUPLICATE_PLANNING_DATE");
    }

    const rawEnabled = row[1];
    const normalizedEnabled = String(rawEnabled).trim().toUpperCase();

    if (
      rawEnabled !== true &&
      rawEnabled !== false &&
      normalizedEnabled !== "TRUE" &&
      normalizedEnabled !== "FALSE"
    ) {
      throw new Error("INVALID_PLANNING_ENABLED_VALUE");
    }

    configuredByDate.set(date, {
      date,
      enabled: rawEnabled === true || normalizedEnabled === "TRUE"
    });
  }

  const dates = [];

  for (let offset = 0; offset < dayCount; offset++) {
    const date = new Date(start.getTime() + offset * 86400000)
      .toISOString()
      .slice(0, 10);

    const configured = configuredByDate.get(date);

    if (!configured) {
      throw new Error("MISSING_PLANNING_DATE");
    }

    dates.push(configured);
  }

  return {
    startDate,
    endDate,
    timezone,
    dates
  };
}

/* =====================================================
   DONNÉES D1
===================================================== */

async function getGridData(env, planning) {
  if (!env.DB) {
    throw new Error("D1_DATABASE_MISSING");
  }

  const firstDate = planning.dates[0].date;
  const lastDate = planning.dates[
    planning.dates.length - 1
  ].date;

  const [usersResult, badgesResult] = await Promise.all([
    env.DB.prepare(`
      SELECT
        twitch_user_id,
        twitch_login,
        display_name
      FROM users
      ORDER BY display_name COLLATE NOCASE ASC
    `).all(),

    env.DB.prepare(`
      SELECT
        twitch_user_id,
        badge_date,
        badge_time,
        status
      FROM badges
      WHERE badge_date >= ?
        AND badge_date <= ?
        AND status IN ('pending', 'recorded')
    `).bind(firstDate, lastDate).all()
  ]);

  const users = usersResult.results || [];
  const badges = badgesResult.results || [];

  const enabledDates = new Set(
    planning.dates
      .filter(item => item.enabled)
      .map(item => item.date)
  );

  const collator = new Intl.Collator("fr", {
    sensitivity: "base",
    numeric: true
  });

  users.sort((a, b) =>
    collator.compare(a.display_name || a.twitch_login, b.display_name || b.twitch_login) ||
    collator.compare(a.twitch_login, b.twitch_login) ||
    a.twitch_user_id.localeCompare(b.twitch_user_id)
  );

  const badgeMap = new Map();

  for (const badge of badges) {
    if (!enabledDates.has(badge.badge_date)) {
      continue;
    }

    const key =
      `${badge.twitch_user_id}:${badge.badge_date}`;

    badgeMap.set(key, badge.badge_time);
  }

  return {
    users,
    badgeMap
  };
}

/* =====================================================
   CONSTRUCTION DE LA GRILLE
===================================================== */

function buildGrid(planning, users, badgeMap) {
  const headers = [
    "Pseudo",
    ...planning.dates.map(item => {
      const weekday = getWeekday(item.date);
      const date = formatDate(item.date);

      return item.enabled
        ? `${weekday} ${date}`
        : `${weekday} ${date} (fermé)`;
    })
  ];

  const rows = [headers];

  for (const user of users) {
    const row = [
      user.display_name || user.twitch_login
    ];

    for (const item of planning.dates) {
      if (!item.enabled) {
        row.push("");
        continue;
      }

      const key =
        `${user.twitch_user_id}:${item.date}`;

      row.push(badgeMap.get(key) || "");
    }

    rows.push(row);
  }

  return rows;
}

/* =====================================================
   SYNCHRONISATION DE LA GRILLE
===================================================== */

export async function syncBadgeuse(env, targetUserId = null) {
  if (!env.DB) {
    throw new Error("D1_DATABASE_MISSING");
  }

  // Verrou D1 : une seule reconstruction complète de la grille à la fois.
  const lockToken = crypto.randomUUID();
  const lockExpiresAt = Math.floor(Date.now() / 1000) + 300;
  let acquired = false;

  for (let attempt = 0; attempt < 20; attempt++) {
    const lock = await env.DB.prepare(`
      INSERT INTO sync_locks (lock_name, lock_token, expires_at)
      VALUES ('badgeuse_grid', ?, ?)
      ON CONFLICT(lock_name) DO UPDATE SET
        lock_token = excluded.lock_token,
        expires_at = excluded.expires_at
      WHERE sync_locks.expires_at <= ?
      RETURNING lock_token
    `).bind(
      lockToken,
      lockExpiresAt,
      Math.floor(Date.now() / 1000)
    ).first();

    if (lock?.lock_token === lockToken) {
      acquired = true;
      break;
    }

    await new Promise(resolve => setTimeout(resolve, 300));
  }

  if (!acquired) {
    throw new Error("SHEET_SYNC_BUSY");
  }

  try {
    const badgeuseTab = getTabName(
      env,
      "SHEET_TAB",
      DEFAULT_BADGEUSE_TAB
    );

    const planning = await getPlanning(env);

    const sheetId = await getSheetId(
      badgeuseTab,
      env
    );

    const sheets = await getSheetMetadata(env);

    const sheet = sheets.find(
      item => item.properties.sheetId === sheetId
    );

    const currentRows =
      sheet.properties.gridProperties.rowCount;

    const currentColumns =
      sheet.properties.gridProperties.columnCount;

    const { users, badgeMap } = await getGridData(
      env,
      planning
    );

    const grid = buildGrid(
      planning,
      users,
      badgeMap
    );

    const requiredRows = Math.max(
      currentRows,
      users.length + 2
    );

    // La grille utilise A:O au maximum (pseudo + 14 jours).
    // Les éventuelles colonnes au-delà de O sont conservées.
    const requiredColumns = Math.max(currentColumns, 15);

    const requests = [];

    if (
      requiredRows !== currentRows ||
      requiredColumns !== currentColumns
    ) {
      requests.push({
        updateSheetProperties: {
          properties: {
            sheetId,
            gridProperties: {
              rowCount: requiredRows,
              columnCount: requiredColumns
            }
          },
          fields: "gridProperties.rowCount,gridProperties.columnCount"
        }
      });
    }

    requests.push({
      updateCells: {
        range: {
          sheetId,
          startRowIndex: 1,
          endRowIndex: requiredRows,
          startColumnIndex: 0,
          endColumnIndex: 15
        },
        fields: "userEnteredValue"
      }
    });

    requests.push({
      updateCells: {
        start: {
          sheetId,
          rowIndex: 1,
          columnIndex: 0
        },
        rows: grid.map(row => ({
          values: row.map(value => ({
            userEnteredValue: {
              stringValue: String(value)
            }
          }))
        })),
        fields: "userEnteredValue"
      }
    });

    await googleRequest(":batchUpdate", env, {
      method: "POST",
      body: JSON.stringify({ requests })
    });

    const targetIndex = targetUserId == null
      ? -1
      : users.findIndex(user => user.twitch_user_id === String(targetUserId));

    return {
      success: true,
      usersCount: users.length,
      datesCount: planning.dates.length,
      sheetId,
      ...(targetUserId == null ? {} : {
        sheetRow: targetIndex === -1 ? null : targetIndex + 3
      })
    };
  } finally {
    // Libération conditionnelle : ne jamais supprimer le verrou
    // éventuellement repris après expiration par une autre requête.
    await env.DB.prepare(`
      DELETE FROM sync_locks
      WHERE lock_name = 'badgeuse_grid'
        AND lock_token = ?
    `).bind(lockToken).run();
  }
}

/* =====================================================
   ENREGISTREMENT D'UN BADGE
===================================================== */

export async function recordBadge(
  userId,
  date,
  env
) {
  const planning = await getPlanning(env);

  const plannedDay = planning.dates.find(
    item => item.date === date
  );

  if (!plannedDay || !plannedDay.enabled) {
    throw new Error("BADGE_DAY_NOT_AVAILABLE");
  }

  const badge = await env.DB.prepare(`
    SELECT
      b.badge_time,
      b.status,
      u.twitch_login
    FROM badges b
    INNER JOIN users u
      ON u.twitch_user_id = b.twitch_user_id
    WHERE b.twitch_user_id = ?
      AND b.badge_date = ?
  `).bind(
    String(userId),
    date
  ).first();

  if (!badge || !["pending", "recorded"].includes(badge.status)) {
    throw new Error("BADGE_NOT_FOUND_IN_DATABASE");
  }

  const syncResult = await syncBadgeuse(env, userId);

  if (!syncResult.sheetRow) {
    throw new Error("BADGE_USER_NOT_FOUND");
  }

  return {
    success: true,
    time: badge.badge_time,
    sheetRow: syncResult.sheetRow,
    ...syncResult
  };
}
