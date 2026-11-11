
import {
  handleAuthStart,
  handleAuthCallback,
  handleLogout,
  getSession
} from "./auth.js";

import {
  upsertUser,
  getBadgeStatus,
  reserveBadge,
  markBadgeRecorded,
  markBadgeFailed
} from "./database.js";

import {
  getPlanning,
  recordBadge
} from "./google-sheets.js";


function getCorsHeaders(request, env) {
  const requestOrigin = request.headers.get("Origin");

  let allowedOrigin = "";

  try {
    allowedOrigin = new URL(env.FRONTEND_URL).origin;
  } catch {
    allowedOrigin = env.FRONTEND_URL;
  }

  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin"
  };

  if (requestOrigin === allowedOrigin) {
    headers["Access-Control-Allow-Origin"] = allowedOrigin;
  }

  return headers;
}


function jsonResponse(data, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders
    }
  });
}


function getParisDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}


function getParisTime() {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).format(new Date());
}


function getErrorStatus(error) {
  const message = error?.message || "";

  if (message === "UNAUTHORIZED") return 401;
  if (message === "BADGE_DAY_NOT_AVAILABLE") return 403;
  if (message === "ALREADY_BADGED") return 409;
  if (message === "BADGE_PENDING") return 409;

  return 500;
}


export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = getCorsHeaders(request, env);

    try {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: corsHeaders
        });
      }

      if (url.pathname === "/health" && request.method === "GET") {
        return jsonResponse({
          status: "ok",
          service: "badgeuse-twitch"
        }, 200, corsHeaders);
      }

      // Authentification Twitch
      if (url.pathname === "/auth/start" && request.method === "GET") {
        return handleAuthStart(request, env);
      }

      if (url.pathname === "/auth/callback" && request.method === "GET") {
        return handleAuthCallback(request, env);
      }

      if (url.pathname === "/auth/logout" && request.method === "POST") {
        return handleLogout(request, env);
      }

      // Vérification de la session et de l'état de badgeage
      if (url.pathname === "/api/me" && request.method === "GET") {
        const session = await getSession(request, env);

        if (!session) {
          return jsonResponse({
            error: "UNAUTHORIZED"
          }, 401, corsHeaders);
        }

        await upsertUser({
          id: session.id,
          login: session.login,
          displayName: session.displayName,
          profileImageUrl: session.profileImageUrl
        }, env);

        const date = getParisDate();
        const planning = await getPlanning(env);

        const today = planning.dates.find(
          item => item.date === date
        );

        const badgeStatus = await getBadgeStatus(
          session.id,
          date,
          env
        );

        return jsonResponse({
          user: {
            id: session.id,
            login: session.login,
            displayName: session.displayName,
            profileImageUrl: session.profileImageUrl
          },
          date,
          time: getParisTime(),
          plannedToday: Boolean(today?.enabled),
          alreadyBadged: badgeStatus.hasBadged,
          pending: badgeStatus.pending,
          badge: badgeStatus.badge
        }, 200, corsHeaders);
      }

      // Enregistrement du badge quotidien
      if (url.pathname === "/api/badge" && request.method === "POST") {
        const session = await getSession(request, env);

        if (!session) {
          return jsonResponse({
            error: "UNAUTHORIZED"
          }, 401, corsHeaders);
        }

        const date = getParisDate();
        const time = getParisTime();

        const planning = await getPlanning(env);

        const today = planning.dates.find(
          item => item.date === date
        );

        if (!today?.enabled) {
          return jsonResponse({
            error: "BADGE_DAY_NOT_AVAILABLE"
          }, 403, corsHeaders);
        }

        await upsertUser({
          id: session.id,
          login: session.login,
          displayName: session.displayName,
          profileImageUrl: session.profileImageUrl
        }, env);

        const reservation = await reserveBadge(
          session.id,
          date,
          time,
          env
        );

        if (!reservation.reserved) {
          if (reservation.reason === "already_recorded") {
            return jsonResponse({
              error: "ALREADY_BADGED"
            }, 409, corsHeaders);
          }

          return jsonResponse({
            error: "BADGE_PENDING"
          }, 409, corsHeaders);
        }

        try {
          const result = await recordBadge(
            session.id,
            date,
            env
          );

          await markBadgeRecorded(
            session.id,
            date,
            result.sheetRow,
            env
          );

          return jsonResponse({
            success: true,
            date,
            time,
            sheetRow: result.sheetRow
          }, 200, corsHeaders);

        } catch (error) {
          try {
            await markBadgeFailed(
              session.id,
              date,
              env
            );
          } catch (databaseError) {
            console.error(
              "Impossible de mettre à jour le statut du badge :",
              databaseError
            );
          }

          throw error;
        }
      }

      return jsonResponse({
        error: "NOT_FOUND"
      }, 404, corsHeaders);

    } catch (error) {
      console.error("Worker error:", error);

      const status = getErrorStatus(error);

      return jsonResponse({
        error: status === 500
          ? "INTERNAL_SERVER_ERROR"
          : error.message
      }, status, corsHeaders);
    }
  }
};
