import {
  handleAuthStart,
  handleAuthCallback,
  handleAuthExchange,
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
    allowedOrigin = env.FRONTEND_URL || "";
  }

  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin"
  };

  if (requestOrigin && requestOrigin === allowedOrigin) {
    headers["Access-Control-Allow-Origin"] = allowedOrigin;
  }

  return headers;
}


function jsonResponse(data, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
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


function errorResponse(code, status, corsHeaders, message = code) {
  return jsonResponse({ code, message }, status, corsHeaders);
}


function getErrorStatus(error) {
  const code = error?.message || "";

  if (code === "UNAUTHORIZED") return 401;
  if (code === "SHEET_SYNC_BUSY") return 503;
  if (code === "BADGE_DAY_NOT_AVAILABLE") return 403;
  if (code === "ALREADY_BADGED" || code === "BADGE_PENDING") return 409;

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

      if (url.pathname === "/auth/start" && request.method === "GET") {
        return handleAuthStart(request, env);
      }

      if (url.pathname === "/auth/callback" && request.method === "GET") {
        return handleAuthCallback(request, env);
      }

      if (url.pathname === "/auth/exchange" && request.method === "POST") {
        const response = await handleAuthExchange(request, env);
        const headers = new Headers(response.headers);
        for (const [key, value] of Object.entries(corsHeaders)) {
          headers.set(key, value);
        }
        return new Response(response.body, {
          status: response.status,
          headers
        });
      }

      if (url.pathname === "/auth/logout" && request.method === "POST") {
        const response = await handleLogout(request, env);
        const headers = new Headers(response.headers);
        for (const [key, value] of Object.entries(corsHeaders)) {
          headers.set(key, value);
        }
        return new Response(response.body, {
          status: response.status,
          headers
        });
      }

      if (url.pathname === "/api/me" && request.method === "GET") {
        const session = await getSession(request, env);

        if (!session) {
          return errorResponse("UNAUTHORIZED", 401, corsHeaders);
        }

        await upsertUser({
          id: session.id,
          login: session.login,
          displayName: session.displayName,
          profileImageUrl: session.profileImageUrl
        }, env);

        const date = getParisDate();
        const planning = await getPlanning(env);
        const today = planning.dates.find(item => item.date === date);

        const badgeStatus = await getBadgeStatus(session.id, date, env);

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

      if (url.pathname === "/api/badge" && request.method === "POST") {
        const session = await getSession(request, env);

        if (!session) {
          return errorResponse("UNAUTHORIZED", 401, corsHeaders);
        }

        const date = getParisDate();
        const time = getParisTime();

        const planning = await getPlanning(env);
        const today = planning.dates.find(item => item.date === date);

        if (!today?.enabled) {
          return errorResponse("BADGE_DAY_NOT_AVAILABLE", 403, corsHeaders);
        }

        await upsertUser({
          id: session.id,
          login: session.login,
          displayName: session.displayName,
          profileImageUrl: session.profileImageUrl
        }, env);

        const reservation = await reserveBadge(session.id, date, time, env);

        if (!reservation.success) {
          if (reservation.status === "already_recorded") {
            return errorResponse("ALREADY_BADGED", 409, corsHeaders);
          }

          return errorResponse("BADGE_PENDING", 409, corsHeaders);
        }

        try {
          const result = await recordBadge(session.id, date, env);
          const recorded = await markBadgeRecorded(
            session.id,
            date,
            result.sheetRow,
            env
          );

          if (!recorded) {
            throw new Error("BADGE_CONFIRMATION_FAILED");
          }

          return jsonResponse({
            success: true,
            date,
            time: result.time || time,
            sheetRow: result.sheetRow
          }, 200, corsHeaders);

        } catch (error) {
          try {
            await markBadgeFailed(session.id, date, error, env);
          } catch (databaseError) {
            console.error("Impossible de mettre à jour le statut du badge :", databaseError);
          }

          throw error;
        }
      }

      return errorResponse("NOT_FOUND", 404, corsHeaders);

    } catch (error) {
      console.error("Worker error:", error);
      const status = getErrorStatus(error);
      const code = status === 500 ? "INTERNAL_SERVER_ERROR" : error.message;

      return errorResponse(
        code,
        status,
        corsHeaders,
        status === 500
          ? "Une erreur interne est survenue."
          : status === 503
            ? "La badgeuse est momentanément occupée. Réessaie dans quelques secondes."
            : code
      );
    }
  }
};
