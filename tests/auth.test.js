import test from "node:test";
import assert from "node:assert/strict";
import { handleAuthStart, handleAuthCallback } from "../backend/src/auth.js";

test("OAuth start binds a random state to an HttpOnly browser cookie", async () => {
  let storedKey = null;
  const response = await handleAuthStart(new Request("https://worker.example/auth/start"), {
    OAUTH_KV: {
      async put(key, value, options) {
        storedKey = key;
        assert.equal(value, "valid");
        assert.equal(options.expirationTtl, 600);
      }
    },
    TWITCH_CLIENT_ID: "client-id",
    TWITCH_REDIRECT_URI: "https://worker.example/auth/callback"
  });

  assert.equal(response.status, 302);
  const destination = new URL(response.headers.get("Location"));
  const state = destination.searchParams.get("state");
  assert.ok(state);
  assert.equal(storedKey, `oauth:${state}`);

  const cookie = response.headers.get("Set-Cookie");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\/auth\/callback/);
  assert.match(cookie, new RegExp(`badgeuse_oauth_state=${state}`));
});

test("OAuth callback rejects a state not bound to the initiating browser", async () => {
  let kvRead = false;
  const response = await handleAuthCallback(
    new Request("https://worker.example/auth/callback?code=attacker-code&state=state-a", {
      headers: { Cookie: "badgeuse_oauth_state=state-b" }
    }),
    {
      FRONTEND_URL: "https://example.github.io/app",
      OAUTH_KV: {
        async get() {
          kvRead = true;
          return "valid";
        }
      }
    }
  );

  assert.equal(response.status, 302);
  assert.equal(new URL(response.headers.get("Location")).searchParams.get("auth"), "invalid_state");
  assert.equal(kvRead, false);
  assert.match(response.headers.get("Set-Cookie"), /Max-Age=0/);
});
