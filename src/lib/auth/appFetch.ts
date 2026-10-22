"use client";

import { IAMService } from "@tidecloak/js";
import { getStoredAccountId } from "./session";

export const POPUP_BLOCKED_MESSAGE =
  "Your browser blocked the Tide window. Allow pop-ups for this site, then try again.";

/**
 * Gotcha #5 — Secure Fetch (`IAMService.secureFetch`):
 * Every call from the frontend to protected server endpoints uses Tide's SDK `IAMService.secureFetch`
 * when a live TideCloak DPoP session is active.
 *
 * Per Tide MCP `canon/invariants.md` (I-12):
 * 1. `IAMService.secureFetch` requires an ABSOLUTE URL (`new URL(path, window.location.origin).toString()`).
 * 2. Caller must include `Authorization: Bearer ${await IAMService.getToken()}`; `secureFetch` then mints
 *    and attaches the per-request RFC 9449 `DPoP` proof header (`htm`, `htu`, `ath`, `iat`, `jti`).
 */
export async function appFetch(
  input: string | URL,
  init: RequestInit = {}
): Promise<Response> {
  const rawUrl = typeof input === "string" ? input : input.toString();
  const origin =
    typeof window !== "undefined"
      ? window.location.origin
      : "http://localhost:3000";
  const absoluteUrl = rawUrl.startsWith("http")
    ? rawUrl
    : new URL(rawUrl, origin).toString();

  const headers = new Headers(init.headers || {});
  if (typeof window !== "undefined") {
    const storedAccountId = getStoredAccountId();
    if (storedAccountId && !headers.has("x-medpool-account-id")) {
      headers.set("x-medpool-account-id", storedAccountId);
    }
  }

  // If authenticated with a live TideCloak SWE token, always use IAMService.secureFetch
  // so the SDK attaches the DPoP proof bound to the token's cnf.jkt thumbprint.
  if (typeof window !== "undefined") {
    try {
      const token = await IAMService.getToken();
      if (token) {
        if (!headers.has("Authorization")) {
          headers.set("Authorization", `Bearer ${token}`);
        }
        return await IAMService.secureFetch(absoluteUrl, {
          ...init,
          headers,
        });
      }
    } catch {
      // No live SWE token active; fall through to standard request with session account headers
    }
  }

  return fetch(absoluteUrl, {
    ...init,
    headers,
  });
}

/**
 * Gotcha #3 — Pop-up Blocker Detection (`AP-UX04` / `ux-states`):
 * Tide sign-in and enclave approvals open a small Tide Secure Web Enclave window.
 * Wraps any Tide enclave action (`login()`, `doEncrypt()`, `doDecrypt()`, enclave signing)
 * by instrumenting `window.open` to detect if the browser blocked the pop-up (`null` return)
 * instead of failing silently.
 */
export async function runWithPopupDetection<T>(
  action: () => Promise<T> | T,
  onBlocked: (message: string) => void
): Promise<T | null> {
  if (typeof window === "undefined") {
    return await action();
  }

  const originalOpen = window.open.bind(window);
  let blocked = false;

  window.open = function (...args: Parameters<typeof window.open>) {
    const win = originalOpen(...args);
    if (!win) {
      blocked = true;
      onBlocked(POPUP_BLOCKED_MESSAGE);
    }
    return win;
  };

  try {
    const result = await action();
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      blocked ||
      /popup|pop-up|blocked|window\.open|closed/i.test(msg)
    ) {
      onBlocked(POPUP_BLOCKED_MESSAGE);
      return null;
    }
    throw err;
  } finally {
    window.open = originalOpen;
  }
}

/**
 * Gotcha #10 — Revocation Timing & Immediate Session Refresh (`ux-states`):
 * Removing a user's role, group, or consent takes effect on their next token refresh.
 * This helper forces a Tide token refresh (`IAMService.updateIamToken`) if a live session is active.
 */
export async function refreshTideSessionToken(): Promise<{
  refreshedLiveToken: boolean;
  timestamp: string;
}> {
  const timestamp = new Date().toISOString();
  if (typeof window !== "undefined") {
    try {
      const anyIam = IAMService as unknown as {
        updateIamToken?: () => Promise<unknown>;
        getToken?: () => Promise<string | null>;
      };
      if (typeof anyIam.updateIamToken === "function") {
        await anyIam.updateIamToken();
        return { refreshedLiveToken: true, timestamp };
      }
    } catch {
      // Live SWE token not active; local session state will be refreshed via API
    }
  }
  return { refreshedLiveToken: false, timestamp };
}

