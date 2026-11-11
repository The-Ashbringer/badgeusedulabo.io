
/**
 * BADGEUSE DU LABO
 * Intégration Google Sheets
 *
 * Fichier : backend/src/google-sheets.js
 */

const GOOGLE_TOKEN_URL =
    "https://oauth2.googleapis.com/token";

const GOOGLE_API =
    "https://sheets.googleapis.com/v4/spreadsheets";

const SHEET_RANGE = "A1:Q1014";
const TOTAL_COLUMNS = 17;

// Cache temporaire du token Google.
let cachedGoogleToken = null;
let googleTokenExpiry = 0;


/* ========================================
   AUTHENTIFICATION GOOGLE
======================================== */

function base64UrlEncode(value) {
    const bytes = typeof value === "string"
        ? new TextEncoder().encode(value)
        : value;

    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}


function pemToArrayBuffer(pem) {
    const base64 = pem
        .replace(/-----BEGIN PRIVATE KEY-----/g, "")
        .replace(/-----END PRIVATE KEY-----/g, "")
        .replace(/\s/g, "");

    const binary = atob(base64);

    const bytes = Uint8Array.from(
        binary,
        character => character.charCodeAt(0)
    );

    return bytes.buffer;
}


async function getGoogleAccessToken(env) {
    if (
        cachedGoogleToken &&
        Date.now() < googleTokenExpiry - 60000
    ) {
        return cachedGoogleToken;
    }

    if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) {
        throw new Error(
            "Compte de service Google non configuré."
        );
    }

    const serviceAccount = JSON.parse(
        env.GOOGLE_SERVICE_ACCOUNT_JSON
    );

    const now = Math.floor(Date.now() / 1000);

    const jwtHeader = {
        alg: "RS256",
        typ: "JWT"
    };

    const jwtPayload = {
        iss: serviceAccount.client_email,
        scope: "https://www.googleapis.com/auth/spreadsheets",
        aud: GOOGLE_TOKEN_URL,
        iat: now,
        exp: now + 3600
    };

    const unsignedToken = [
        base64UrlEncode(JSON.stringify(jwtHeader)),
        base64UrlEncode(JSON.stringify(jwtPayload))
    ].join(".");

    const privateKey = await crypto.subtle.importKey(
        "pkcs8",
        pemToArrayBuffer(serviceAccount.private_key),
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

    const jwt = `${unsignedToken}.${base64UrlEncode(
        new Uint8Array(signature)
    )}`;

    const response = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
            grant_type:
                "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion: jwt
        })
    });

    if (!response.ok) {
        throw new Error(
            "Impossible d'obtenir le token Google."
        );
    }

    const data = await response.json();

    cachedGoogleToken = data.access_token;
    googleTokenExpiry = Date.now() +
        (data.expires_in * 1000);

    return cachedGoogleToken;
}


/* ========================================
   APPELS GOOGLE SHEETS
======================================== */

async function googleRequest(env, endpoint, options = {}) {
    const token = await getGoogleAccessToken(env);

    const response = await fetch(
        `${GOOGLE_API}/${env.SPREADSHEET_ID}${endpoint}`,
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
        const details = await response.text();

        console.error(
            "Erreur Google Sheets :",
            response.status,
            details
        );

        throw new Error(
            `Google Sheets a retourné ${response.status}.`
        );
    }

    if (response.status === 204) {
        return null;
    }

    return response.json();
}


/* ========================================
   CONFIGURATION DU CLASSEUR
======================================== */

function validateConfiguration(env) {
    if (!env.SPREADSHEET_ID) {
        throw new Error("SPREADSHEET_ID manquant.");
    }

    if (!env.SHEET_TAB) {
        throw new Error("SHEET_TAB manquant.");
    }

    if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) {
        throw new Error("Compte Google manquant.");
    }
}


function getSheetTitle(env) {
    // Le nom de l'onglet est échappé pour A1 notation.
    return `'${env.SHEET_TAB.replace(/'/g, "''")}'`;
}


async function getSheetMetadata(env) {
    validateConfiguration(env);

    const metadata = await googleRequest(
        env,
        "?fields=sheets.properties"
    );

    const sheet = metadata.sheets?.find(
        item => item.properties.title === env.SHEET_TAB
    );

    if (!sheet) {
        throw new Error(
            `Onglet ${env.SHEET_TAB} introuvable.`
        );
    }

    return sheet.properties;
}


/* ========================================
   LECTURE DE LA BADGEUSE
======================================== */

async function readBadgeuse(env) {
    validateConfiguration(env);

    const range = `${getSheetTitle(env)}!${SHEET_RANGE}`;

    const result = await googleRequest(
        env,
        `/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`
    );

    return result.values || [];
}


/* ========================================
   NORMALISATION DES DATES
======================================== */

function normalizeDate(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }

    // Google Sheets stocke souvent les dates
    // sous forme de numéro de série.
    if (typeof value === "number") {
        const milliseconds =
            Date.UTC(1899, 11, 30) +
            Math.round(value * 86400000);

        return new Date(milliseconds)
            .toISOString()
            .slice(0, 10);
    }

    const text = String(value).trim();

    // Format ISO.
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        return text;
    }

    // Format français : JJ/MM/AAAA.
    const frenchDate = text.match(
        /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/
    );

    if (frenchDate) {
        const [, day, month, year] = frenchDate;

        return [
            year,
            month.padStart(2, "0"),
            day.padStart(2, "0")
        ].join("-");
    }

    return null;
}


/* ========================================
   IDENTIFICATION DES COLONNES
======================================== */

function findDateColumn(rows, targetDate) {
    // Ligne 6 = index 5.
    const dateRow = rows[5] || [];

    // C à J = index 2 à 9.
    for (let column = 2; column <= 9; column++) {
        const cellDate = normalizeDate(
            dateRow[column]
        );

        if (cellDate === targetDate) {
            return column;
        }
    }

    return null;
}


/* ========================================
   IDENTIFICATION DES SECTIONS
======================================== */

function getSectionMarker(value) {
    if (value === null || value === undefined) {
        return null;
    }

    const text = String(value).trim();

    if (/^[A-Z]$/i.test(text)) {
        return text.toUpperCase();
    }

    if (/^0\s*[àa]\s*9$/i.test(text)) {
        return "0";
    }

    return null;
}


function getSectionForLogin(login) {
    const firstCharacter = login
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .charAt(0)
        .toUpperCase();

    if (/^\d$/.test(firstCharacter)) {
        return "0";
    }

    if (/^[A-Z]$/.test(firstCharacter)) {
        return firstCharacter;
    }

    return null;
}


/* ========================================
   RECHERCHE D'UN UTILISATEUR
======================================== */

function findUserRow(rows, login) {
    const normalizedLogin = login.toLowerCase();

    for (let index = 0; index < rows.length; index++) {
        const value = rows[index]?.[0];

        if (!value) continue;

        // Ignorer les séparateurs alphabétiques.
        if (getSectionMarker(value)) continue;

        if (
            String(value).trim().toLowerCase() ===
            normalizedLogin
        ) {
            return index;
        }
    }

    return null;
}


/* ========================================
   RECHERCHE D'UNE PLACE ALPHABETIQUE
======================================== */

function findInsertionPosition(rows, login) {
    const section = getSectionForLogin(login);

    if (!section) {
        return {
            success: false,
            code: "INVALID_LOGIN"
        };
    }

    let sectionStart = null;
    let sectionEnd = rows.length;

    // Recherche du séparateur de section.
    for (let index = 0; index < rows.length; index++) {
        if (
            getSectionMarker(rows[index]?.[0]) === section
        ) {
            sectionStart = index;
            break;
        }
    }

    if (sectionStart === null) {
        return {
            success: false,
            code: "SECTION_NOT_FOUND"
        };
    }

    // Délimitation par le prochain séparateur.
    for (
        let index = sectionStart + 1;
        index < rows.length;
        index++
    ) {
        if (getSectionMarker(rows[index]?.[0])) {
            sectionEnd = index;
            break;
        }
    }

    const target = login.toLowerCase();

    let insertionRow = null;
    let lastOccupiedRow = sectionStart;

    for (
        let index = sectionStart + 1;
        index < sectionEnd;
        index++
    ) {
        const row = rows[index] || [];

        const name = row[0];

        const hasData = row.some(
            value => value !== null &&
                value !== undefined &&
                value !== ""
        );

        if (hasData) {
            lastOccupiedRow = index;
        }

        if (!name) continue;

        if (getSectionMarker(name)) continue;

        const existing = String(name).trim().toLowerCase();

        if (
            insertionRow === null &&
            existing.localeCompare(
                target,
                "fr",
                { sensitivity: "base" }
            ) > 0
        ) {
            insertionRow = index;
        }
    }

    if (insertionRow === null) {
        insertionRow = lastOccupiedRow + 1;
    }

    // Vérifier qu'une ligne entière est disponible.
    if (lastOccupiedRow + 1 >= sectionEnd) {
        return {
            success: false,
            code: "NO_FREE_ROW"
        };
    }

    const freeRow = rows[lastOccupiedRow + 1] || [];

    const hasFreeRowData = freeRow.some(
        value => value !== null &&
            value !== undefined &&
            value !== ""
    );

    if (hasFreeRowData) {
        return {
            success: false,
            code: "NO_FREE_ROW"
        };
    }

    return {
        success: true,
        insertionRow,
        lastOccupiedRow
    };
}


/* ========================================
   VERIFICATION DE LA CASE DE POINTAGE
======================================== */

function getBadgeCell(rows, rowIndex, columnIndex) {
    return rows[rowIndex]?.[columnIndex] ?? "";
}


export async function getBadgeStatus(env, user, date) {
    const rows = await readBadgeuse(env);

    const column = findDateColumn(rows, date);

    if (column === null) {
        throw new Error("DATE_NOT_FOUND");
    }

    const row = findUserRow(rows, user.login);

    if (row === null) {
        return {
            alreadyBadged: false,
            registered: false
        };
    }

    const value = getBadgeCell(
        rows,
        row,
        column
    );

    return {
        alreadyBadged: value !== "",
        registered: true
    };
}


/* ========================================
   ECRITURE DANS GOOGLE SHEETS
======================================== */

function isDateMissing(result) {
    return result.code === "DATE_NOT_FOUND";
}


async function writeValues(env, updates) {
    const data = updates.map(update => ({
        range: update.range,
        values: [[update.value]]
    }));

    return googleRequest(
        env,
        "/values:batchUpdate",
        {
            method: "POST",
            body: JSON.stringify({
                valueInputOption: "RAW",
                data
            })
        }
    );
}


/* ========================================
   DEPLACEMENT DES LIGNES
======================================== */

async function shiftRowsDown(
    env,
    sheetId,
    firstRow,
    lastRow
) {
    // Déplacement de bas en haut pour éviter
    // d'écraser les données encore à déplacer.
    const requests = [];

    for (
        let row = lastRow;
        row >= firstRow;
        row--
    ) {
        requests.push({
            copyPaste: {
                source: {
                    sheetId,
                    startRowIndex: row,
                    endRowIndex: row + 1,
                    startColumnIndex: 0,
                    endColumnIndex: TOTAL_COLUMNS
                },
                destination: {
                    sheetId,
                    startRowIndex: row + 1,
                    endRowIndex: row + 2,
                    startColumnIndex: 0,
                    endColumnIndex: TOTAL_COLUMNS
                },
                pasteType: "PASTE_NORMAL"
            }
        });
    }

    if (requests.length === 0) {
        return;
    }

    await googleRequest(
        env,
        ":batchUpdate",
        {
            method: "POST",
            body: JSON.stringify({
                requests
            })
        }
    );
}


/* ========================================
   ENREGISTREMENT DU BADGE
======================================== */

export async function recordBadge(
    env,
    user,
    date,
    time
) {
    try {
        const rows = await readBadgeuse(env);

        const column = findDateColumn(rows, date);

        if (column === null) {
            return {
                success: false,
                code: "DATE_NOT_FOUND"
            };
        }

        let userRow = findUserRow(
            rows,
            user.login
        );

        // Nouvel utilisateur : insertion alphabétique.
        if (userRow === null) {
            const position = findInsertionPosition(
                rows,
                user.login
            );

            if (!position.success) {
                return position;
            }

            const metadata = await getSheetMetadata(env);

            await shiftRowsDown(
                env,
                metadata.sheetId,
                position.insertionRow,
                position.lastOccupiedRow
            );

            userRow = position.insertionRow;

            // Ecriture du nouveau pseudo.
            const pseudoRange =
                `${getSheetTitle(env)}!A${userRow + 1}`;

            await writeValues(env, [
                {
                    range: pseudoRange,
                    value: user.login
                }
            ]);
        }

        // Vérification de la case avant écriture.
        const currentValue = getBadgeCell(
            rows,
            userRow,
            column
        );

        if (currentValue !== "") {
            return {
                success: false,
                code: "ALREADY_BADGED"
            };
        }

        // C = index 2, donc colonne Google Sheets C.
        const columnLetter = String.fromCharCode(
            65 + column
        );

        const badgeRange =
            `${getSheetTitle(env)}!${columnLetter}${userRow + 1}`;

        await writeValues(env, [
            {
                range: badgeRange,
                value: time
            }
        ]);

        return {
            success: true,
            time,
            date,
            row: userRow + 1,
            column: columnLetter
        };

    } catch (error) {
        console.error(
            "Erreur d'enregistrement Google Sheets :",
            error
        );

        if (isDateMissing(error)) {
            return {
                success: false,
                code: "DATE_NOT_FOUND"
            };
        }

        throw error;
    }
}
