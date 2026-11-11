
/**
 * BADGEUSE DU LABO
 * Cloudflare Worker - API principale
 *
 * Fichier : backend/src/index.js
 */

import {
    handleAuthStart,
    handleAuthCallback,
    handleLogout,
    getSession
} from "./auth.js";

import {
    getBadgeStatus,
    recordBadge
} from "./google-sheets.js";


/* ========================================
   CONFIGURATION
======================================== */

const API_VERSION = "1.0.0";


/* ========================================
   REPONSES HTTP
======================================== */

function jsonResponse(data, status = 200, headers = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            ...headers
        }
    });
}


function errorResponse(message, status = 400, code = "ERROR") {
    return jsonResponse({
        success: false,
        code,
        message
    }, status);
}


/* ========================================
   CORS
======================================== */

function getCorsHeaders(request, env) {
    const origin = request.headers.get("Origin");

    const allowedOrigin = env.FRONTEND_URL;

    // Pas d'accès depuis une origine inconnue.
    if (!origin || origin !== allowedOrigin) {
        return {};
    }

    return {
        "Access-Control-Allow-Origin": allowedOrigin,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin"
    };
}


function withCors(response, request, env) {
    const headers = new Headers(response.headers);
    const corsHeaders = getCorsHeaders(request, env);

    for (const [key, value] of Object.entries(corsHeaders)) {
        headers.set(key, value);
    }

    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
    });
}


/* ========================================
   DATE ET HEURE FRANCAISES
======================================== */

function getParisDate() {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Paris",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(new Date());

    const values = Object.fromEntries(
        parts.map(part => [part.type, part.value])
    );

    return `${values.year}-${values.month}-${values.day}`;
}


function getParisTime() {
    return new Intl.DateTimeFormat("fr-FR", {
        timeZone: "Europe/Paris",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
    }).format(new Date()).replace(":", "h");
}


/* ========================================
   AUTHENTIFICATION DES REQUETES
======================================== */

async function requireUser(request, env) {
    const session = await getSession(request, env);

    if (!session || !session.user) {
        return null;
    }

    return session.user;
}


/* ========================================
   ROUTES API
======================================== */

async function handleRequest(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Prévol CORS
    if (method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: getCorsHeaders(request, env)
        });
    }

    // Vérification du serveur
    if (path === "/health" && method === "GET") {
        return jsonResponse({
            success: true,
            application: "Badgeuse du Labo",
            version: API_VERSION,
            status: "online"
        });
    }

    // Démarrage OAuth Twitch
    if (path === "/auth/start" && method === "GET") {
        return await handleAuthStart(request, env);
    }

    // Retour de Twitch après authentification
    if (path === "/auth/callback" && method === "GET") {
        return await handleAuthCallback(request, env);
    }

    // Déconnexion
    if (path === "/auth/logout" && method === "POST") {
        return await handleLogout(request, env);
    }

    // Informations utilisateur et statut du badge
    if (path === "/api/me" && method === "GET") {
        const user = await requireUser(request, env);

        if (!user) {
            return errorResponse(
                "Tu dois être connecté avec Twitch.",
                401,
                "UNAUTHENTICATED"
            );
        }

        const date = getParisDate();

        const badgeStatus = await getBadgeStatus(
            env,
            user,
            date
        );

        return jsonResponse({
            success: true,
            user: {
                id: user.id,
                login: user.login
            },
            alreadyBadged: badgeStatus.alreadyBadged,
            date
        });
    }

    // Enregistrement du badge
    if (path === "/api/badge" && method === "POST") {
        const user = await requireUser(request, env);

        if (!user) {
            return errorResponse(
                "Tu dois être connecté avec Twitch.",
                401,
                "UNAUTHENTICATED"
            );
        }

        const date = getParisDate();
        const time = getParisTime();

        const result = await recordBadge(
            env,
            user,
            date,
            time
        );

        if (!result.success) {
            if (result.code === "ALREADY_BADGED") {
                return errorResponse(
                    "Tu as déjà badgé aujourd'hui.",
                    409,
                    "ALREADY_BADGED"
                );
            }

            if (result.code === "DATE_NOT_FOUND") {
                return errorResponse(
                    "La date du jour n'est pas présente dans la badgeuse.",
                    409,
                    "DATE_NOT_FOUND"
                );
            }

            if (result.code === "NO_FREE_ROW") {
                return errorResponse(
                    "Impossible d'ajouter un nouvel utilisateur : tableau complet.",
                    409,
                    "NO_FREE_ROW"
                );
            }

            throw new Error("Échec de l'enregistrement du badge.");
        }

        return jsonResponse({
            success: true,
            message: "Badge enregistré avec succès.",
            time,
            date
        });
    }

    // Route inconnue
    return errorResponse(
        "Cette route n'existe pas.",
        404,
        "NOT_FOUND"
    );
}


/* ========================================
   GESTION GLOBALE DES ERREURS
======================================== */

export default {
    async fetch(request, env, ctx) {
        try {
            const response = await handleRequest(
                request,
                env,
                ctx
            );

            return withCors(response, request, env);

        } catch (error) {
            // Ne pas exposer les détails internes au navigateur.
            console.error("Erreur API Badgeuse :", error);

            const response = errorResponse(
                "Une erreur interne est survenue. Réessaie plus tard.",
                500,
                "INTERNAL_ERROR"
            );

            return withCors(response, request, env);
        }
    }
};
