
/* ========================================
   BADGEUSE DU LABO
   Application frontend
======================================== */

"use strict";

/* ----------------------------------------
   CONFIGURATION
---------------------------------------- */

const CONFIG = {
    // À remplacer par l'URL du Cloudflare Worker
    API_URL: "https://badgeuse-twitch.docarenou.workers.dev",

    TIMEZONE: "Europe/Paris",
    SESSION_KEY: "badgeuse_session"
};


/* ----------------------------------------
   ELEMENTS HTML
---------------------------------------- */

const elements = {
    currentDate: document.getElementById("current-date"),
    currentTime: document.getElementById("current-time"),

    authSection: document.getElementById("auth-section"),
    userSection: document.getElementById("user-section"),

    loginButton: document.getElementById("login-button"),
    logoutButton: document.getElementById("logout-button"),
    badgeButton: document.getElementById("badge-button"),

    userName: document.getElementById("user-name"),
    userAvatar: document.getElementById("user-avatar"),

    badgeStatus: document.getElementById("badge-status"),
    statusText: document.getElementById("status-text"),

    feedbackMessage: document.getElementById("feedback-message")
};


/* ----------------------------------------
   ETAT DE L'APPLICATION
---------------------------------------- */

const state = {
    user: null,
    alreadyBadged: false,
    pending: false,
    plannedToday: true,
    isLoading: false,
    isBadging: false
};


/* ----------------------------------------
   OUTILS
---------------------------------------- */

function formatDate() {
    return new Intl.DateTimeFormat("fr-FR", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: CONFIG.TIMEZONE
    }).format(new Date());
}


function formatTime() {
    return new Intl.DateTimeFormat("fr-FR", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        timeZone: CONFIG.TIMEZONE
    }).format(new Date());
}


function updateClock() {
    elements.currentDate.textContent = formatDate();
    elements.currentTime.textContent = formatTime();
}


function showFeedback(message, type = "success") {
    elements.feedbackMessage.textContent = message;
    elements.feedbackMessage.className = `feedback-message ${type}`;
    elements.feedbackMessage.hidden = false;
}


function hideFeedback() {
    elements.feedbackMessage.hidden = true;
    elements.feedbackMessage.textContent = "";
}


function setBadgeStatus(message, type = "") {
    elements.badgeStatus.className = "badge-status";

    if (type) {
        elements.badgeStatus.classList.add(type);
    }

    elements.statusText.textContent = message;
}


/* ----------------------------------------
   APPELS API
---------------------------------------- */

function getSessionToken() {
    return sessionStorage.getItem(CONFIG.SESSION_KEY);
}


async function apiRequest(endpoint, options = {}) {
    const headers = {
        "Content-Type": "application/json",
        ...options.headers
    };

    const token = getSessionToken();

    if (token && endpoint !== "/auth/exchange") {
        headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(
        `${CONFIG.API_URL}${endpoint}`,
        {
            ...options,
            credentials: "omit",
            headers
        }
    );

    let data;

    try {
        data = await response.json();
    } catch {
        throw new Error("Réponse invalide du serveur.");
    }

    if (!response.ok) {
        const error = new Error(
            data.message || data.code || "Une erreur est survenue."
        );

        error.status = response.status;
        error.code = data.code || data.error;

        throw error;
    }

    return data;
}


/* ----------------------------------------
   AFFICHAGE UTILISATEUR
---------------------------------------- */

function displayUser(user) {
    state.user = user;

    elements.authSection.hidden = true;
    elements.userSection.hidden = false;

    const displayName = user.displayName || user.login || "Twitch";
    elements.userName.textContent = displayName;

    elements.userAvatar.textContent =
        displayName.charAt(0).toUpperCase();

    elements.badgeButton.disabled = true;

    setBadgeStatus("Vérification du pointage...");
}


function displayLoggedOut() {
    state.user = null;
    state.alreadyBadged = false;

    elements.authSection.hidden = false;
    elements.userSection.hidden = true;

    elements.badgeButton.disabled = true;

    hideFeedback();
}


/* ----------------------------------------
   AUTHENTIFICATION
---------------------------------------- */

function loginWithTwitch() {
    hideFeedback();

    if (!CONFIG.API_URL.startsWith("https://")) {
        showFeedback(
            "L'adresse du serveur n'est pas encore configurée.",
            "error"
        );
        return;
    }

    window.location.href =
        `${CONFIG.API_URL}/auth/start`;
}


async function logout() {
    hideFeedback();

    try {
        await apiRequest("/auth/logout", {
            method: "POST"
        });
    } catch (error) {
        console.error("Erreur de déconnexion :", error);
    } finally {
        sessionStorage.removeItem(CONFIG.SESSION_KEY);
        displayLoggedOut();
    }
}


async function completeTwitchLogin() {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const loginCode = params.get("auth_code");

    if (!loginCode) {
        return null;
    }

    // Retire immédiatement le code temporaire de l'URL.
    window.history.replaceState(
        null,
        document.title,
        window.location.pathname + window.location.search
    );

    try {
        const result = await apiRequest("/auth/exchange", {
            method: "POST",
            body: JSON.stringify({ code: loginCode })
        });

        if (!result.token || !result.user) {
            throw new Error("Réponse de connexion incomplète.");
        }

        sessionStorage.setItem(CONFIG.SESSION_KEY, result.token);
        showFeedback("Connexion Twitch réussie.", "success");
        return true;

    } catch (error) {
        console.error("Échec de l'échange OAuth :", error);
        sessionStorage.removeItem(CONFIG.SESSION_KEY);
        showFeedback(
            error.message || "La connexion Twitch a échoué. Réessaie.",
            "error"
        );
        return false;
    }
}


/* ----------------------------------------
   RECUPERATION DE LA SESSION
---------------------------------------- */

async function checkSession() {
    if (state.isLoading) return;

    if (!getSessionToken()) {
        displayLoggedOut();
        return;
    }

    state.isLoading = true;

    try {
        const data = await apiRequest("/api/me");

        if (!data.user) {
            displayLoggedOut();
            return;
        }

        displayUser(data.user);

        state.alreadyBadged = Boolean(data.alreadyBadged);
        state.pending = Boolean(data.pending);
        state.plannedToday = Boolean(data.plannedToday);

        if (state.alreadyBadged) {
            setBadgeStatus(
                "Tu as déjà badgé aujourd'hui. À demain !",
                "success"
            );

            elements.badgeButton.disabled = true;
            elements.badgeButton.textContent = "Déjà badgé ✓";
        } else if (state.pending) {
            setBadgeStatus(
                "Ton badgeage est en cours de synchronisation.",
                "pending"
            );

            elements.badgeButton.disabled = true;
            elements.badgeButton.textContent = "Enregistrement...";
        } else if (!state.plannedToday) {
            setBadgeStatus(
                "Aucun badgeage n'est prévu aujourd'hui."
            );

            elements.badgeButton.disabled = true;
            elements.badgeButton.textContent = "Journée fermée";
        } else {
            setBadgeStatus(
                "Tu n'as pas encore badgé aujourd'hui."
            );

            elements.badgeButton.disabled = false;
            elements.badgeButton.textContent =
                "Je badge maintenant";
        }

    } catch (error) {
        if (error.status === 401) {
            sessionStorage.removeItem(CONFIG.SESSION_KEY);
            displayLoggedOut();
        } else {
            console.error(
                "Impossible de vérifier la session :",
                error
            );

            displayLoggedOut();

            showFeedback(
                "Impossible de contacter le serveur. Réessaie dans quelques instants.",
                "error"
            );
        }
    } finally {
        state.isLoading = false;
    }
}


/* ----------------------------------------
   ENREGISTREMENT DU BADGE
---------------------------------------- */

async function submitBadge() {
    if (
        !state.user ||
        state.alreadyBadged ||
        state.isBadging
    ) {
        return;
    }

    state.isBadging = true;
    elements.badgeButton.disabled = true;
    elements.badgeButton.textContent = "Enregistrement...";

    hideFeedback();

    try {
        const result = await apiRequest("/api/badge", {
            method: "POST"
        });

        state.alreadyBadged = true;

        setBadgeStatus(
            `Badge enregistré à ${result.time || "l'instant"} !`,
            "success"
        );

        elements.badgeButton.textContent = "Déjà badgé ✓";

        showFeedback(
            "Présence enregistrée avec succès. Bonne matinale !",
            "success"
        );

    } catch (error) {
        console.error("Erreur de pointage :", error);

        if (error.code === "ALREADY_BADGED") {
            state.alreadyBadged = true;

            setBadgeStatus(
                "Tu as déjà badgé aujourd'hui.",
                "success"
            );

            elements.badgeButton.textContent = "Déjà badgé ✓";

            showFeedback(
                "Un pointage existe déjà pour aujourd'hui.",
                "success"
            );

        } else if (error.code === "BADGE_PENDING") {
            state.pending = true;

            setBadgeStatus(
                "Ton badgeage est en cours de synchronisation.",
                "pending"
            );

            elements.badgeButton.disabled = true;
            elements.badgeButton.textContent = "Enregistrement...";

            showFeedback(
                "Ton pointage est en cours de traitement. Actualise la page dans quelques instants.",
                "info"
            );

        } else if (error.code === "BADGE_DAY_NOT_AVAILABLE") {
            state.plannedToday = false;

            setBadgeStatus("Aucun badgeage n'est prévu aujourd'hui.");
            elements.badgeButton.disabled = true;
            elements.badgeButton.textContent = "Journée fermée";

            showFeedback("Le badgeage n'est pas ouvert aujourd'hui.", "info");

        } else {
            elements.badgeButton.disabled = false;
            elements.badgeButton.textContent =
                "Je badge maintenant";

            showFeedback(
                error.message || "Impossible d'enregistrer le badge.",
                "error"
            );
        }

    } finally {
        state.isBadging = false;
    }
}


/* ----------------------------------------
   INITIALISATION
---------------------------------------- */

async function initializeApp() {

    // Horloge
    updateClock();
    setInterval(updateClock, 1000);

    // Evénements
    elements.loginButton.addEventListener(
        "click",
        loginWithTwitch
    );

    elements.logoutButton.addEventListener(
        "click",
        logout
    );

    elements.badgeButton.addEventListener(
        "click",
        submitBadge
    );

    // Échange du code OAuth reçu dans le fragment URL.
    const params = new URLSearchParams(window.location.search);
    const authError = params.get("auth");

    if (authError && authError !== "success") {
        showFeedback(
            authError === "cancelled"
                ? "Connexion Twitch annulée."
                : "La connexion Twitch a échoué. Réessaie.",
            "error"
        );
        return;
    }

    const loginResult = await completeTwitchLogin();

    // Vérification de la session, sauf si l'échange OAuth a échoué.
    if (loginResult !== false) {
        checkSession();
    }
}


// Démarrage
initializeApp();
