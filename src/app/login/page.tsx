"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTideCloak } from "@tidecloak/nextjs";
import type { MedPoolAccount } from "@/lib/medpool/types";
import {
  setStoredAccountId,
  isSessionMarkedExpired,
  setSessionExpiredFlag,
  getDefaultTabForRole,
  getRoleDisplayLabel,
} from "@/lib/auth/session";
import { appFetch, runWithPopupDetection } from "@/lib/auth/appFetch";
import {
  IconShield,
  IconLock,
  IconCheck,
  IconClock,
  StatusBadge,
} from "@/components/ui/DesignSystem";

export default function LoginPage() {
  const router = useRouter();
  const {
    authenticated,
    isInitializing,
    login: tideLogin,
    getValueFromToken,
    tokenExp,
  } = useTideCloak();
  const [accounts, setAccounts] = useState<MedPoolAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null);
  const [emailInput, setEmailInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [popupBlockedError, setPopupBlockedError] = useState<string | null>(
    null
  );
  const [sessionExpired, setSessionExpired] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tokenIsExpired = Boolean(tokenExp && tokenExp * 1000 < Date.now());
    if (
      params.get("expired") === "1" ||
      isSessionMarkedExpired() ||
      tokenIsExpired
    ) {
      setSessionExpired(true);
    }
    appFetch("/api/medpool/state")
      .then((r) => r.json())
      .then((d) => {
        setAccounts(d.accounts || []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [tokenExp]);

  // If returning from live TideCloak SWE callback, link session automatically
  useEffect(() => {
    if (!authenticated) return;
    const vuid = (getValueFromToken("vuid") as string) || "";
    const email = (getValueFromToken("email") as string) || "";
    const name =
      (getValueFromToken("given_name") as string) ||
      (getValueFromToken("name") as string) ||
      "";
    if (!vuid) return;

    appFetch("/api/medpool/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "LOGIN_ACCOUNT",
        vuid,
        email,
        name,
        authMethod: "TIDECLOAK_SWE",
      }),
    })
      .then((r) => r.json())
      .then((res) => {
        if (res.account) {
          setStoredAccountId(res.account.id);
          setSessionExpiredFlag(false);
          const tab = getDefaultTabForRole(res.account.activeRole);
          router.push(`/?tab=${tab}`);
        }
      })
      .catch(() => {});
  }, [authenticated, getValueFromToken, router]);

  function handleLaunchTideEnclave() {
    if (isInitializing) return;
    setPopupBlockedError(null);
    setError(null);
    runWithPopupDetection(
      () => tideLogin(),
      (blockedMsg) => setPopupBlockedError(blockedMsg)
    );
  }

  async function handleAccountLogin(account: MedPoolAccount) {
    setBusyAccountId(account.id);
    setError(null);
    try {
      const res = await appFetch("/api/medpool/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "LOGIN_ACCOUNT",
          accountId: account.id,
          authMethod: account.authMethod,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || "Login failed.");
        return;
      }
      setStoredAccountId(json.account.id);
      setSessionExpiredFlag(false);
      const tab = getDefaultTabForRole(json.account.activeRole);
      router.push(`/?tab=${tab}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error during login.");
    } finally {
      setBusyAccountId(null);
    }
  }

  async function handleEmailLookupLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmed = emailInput.trim().toLowerCase();
    if (!trimmed) {
      setError(
        "Please enter your registered email address or launch the TideCloak Enclave."
      );
      return;
    }
    const matched = accounts.find((a) => a.email.toLowerCase() === trimmed);
    if (!matched) {
      setError(
        `No MedPool account found for '${trimmed}'. Create an account on the Sign Up page first.`
      );
      return;
    }
    await handleAccountLogin(matched);
  }

  return (
    <div className="mp-shell">
      <header className="mp-topbar">
        <div className="mp-topbar__inner">
          <Link
            href="/"
            className="mp-brand"
            style={{ textDecoration: "none", color: "inherit" }}
          >
            <div className="mp-brand__mark" aria-hidden="true">
              <IconShield width={20} height={20} />
            </div>
            <div>
              <div className="mp-brand__title">
                MedPool
                <span className="mp-brand__badge">TideCloak Native Auth</span>
              </div>
              <span className="mp-brand__subtitle">
                Zero-Knowledge OPAQUE Authentication · DPoP Sender-Constrained
                Sessions
              </span>
            </div>
          </Link>
          <div className="mp-topbar__actions">
            <Link href="/signup" className="mp-btn mp-btn--primary">
              Create Account
            </Link>
            <Link href="/" className="mp-btn">
              Back to Overview
            </Link>
          </div>
        </div>
      </header>

      <main className="mp-main" style={{ maxWidth: 1080 }}>
        {sessionExpired && (
          <div
            role="alert"
            className="mp-callout mp-callout--warning"
            style={{ marginBottom: "1.25rem" }}
          >
            <IconClock
              width={20}
              height={20}
              style={{ flexShrink: 0, marginTop: 2 }}
            />
            <div style={{ flex: 1 }}>
              <div className="mp-callout__title">
                Your DPoP-Bound Session Has Expired
              </div>
              <div className="mp-callout__desc">
                For clinical security, decrypted sandbox memory has been wiped
                and your access token has expired. Please sign in again via
                TideCloak to mint a fresh sender-constrained token.
              </div>
            </div>
            <button
              type="button"
              className="mp-btn mp-btn--sm"
              onClick={() => {
                setSessionExpired(false);
                setSessionExpiredFlag(false);
              }}
            >
              Dismiss
            </button>
          </div>
        )}

        {popupBlockedError && (
          <div
            role="alert"
            className="mp-callout mp-callout--danger"
            style={{ marginBottom: "1.25rem" }}
          >
            <IconLock
              width={20}
              height={20}
              style={{ flexShrink: 0, marginTop: 2 }}
            />
            <div style={{ flex: 1 }}>
              <div className="mp-callout__title">
                Browser Pop-Up Blocked (Tide Secure Web Enclave)
              </div>
              <div className="mp-callout__desc">{popupBlockedError}</div>
            </div>
            <button
              type="button"
              className="mp-btn mp-btn--primary mp-btn--sm"
              onClick={handleLaunchTideEnclave}
            >
              Try Again
            </button>
          </div>
        )}

        <div className="mp-grid-2" style={{ alignItems: "start" }}>
          {/* Left Column: Primary TideCloak Enclave Login */}
          <section className="mp-card" aria-labelledby="login-heading">
            <div className="mp-card__header">
              <div>
                <h1
                  id="login-heading"
                  className="mp-card__title"
                  style={{ fontSize: "1.25rem" }}
                >
                  Sign In to MedPool
                </h1>
                <p className="mp-card__subtitle">
                  Authenticate with TideCloak to access your role-scoped
                  clinical workspace.
                </p>
              </div>
              <StatusBadge
                variant="info"
                icon={<IconLock width={12} height={12} />}
              >
                Zero-Knowledge Auth
              </StatusBadge>
            </div>

            <div className="mp-card__body">
              <div
                className="mp-callout mp-callout--teal"
                style={{ marginBottom: "0.85rem" }}
              >
                <IconShield
                  width={18}
                  height={18}
                  style={{ flexShrink: 0, marginTop: 2 }}
                />
                <div>
                  <div className="mp-callout__title">
                    Your password never reaches our servers.
                  </div>
                  <div className="mp-callout__desc">
                    MedPool has no password column and never sees your
                    credentials or private keys. TideCloak authenticates you via
                    threshold OPAQUE in the Secure Web Enclave and binds your
                    token to an in-browser{" "}
                    <code className="mp-code-inline">ES256</code> DPoP keypair.
                  </div>
                </div>
              </div>

              {/* Gotchas #3 & #4: Explicit Pop-up & Browser-Only Requirements */}
              <div
                className="mp-callout mp-callout--warning"
                style={{ marginBottom: "1.1rem" }}
              >
                <IconLock
                  width={16}
                  height={16}
                  style={{ flexShrink: 0, marginTop: 2 }}
                />
                <div>
                  <div className="mp-callout__title">
                    Allow Pop-Ups · Browser-Only Authentication
                  </div>
                  <div className="mp-callout__desc">
                    <strong>Pop-ups required:</strong> Tide sign-in and quorum
                    approvals open a small Tide Secure Web Enclave window —
                    please allow pop-ups for this site.{" "}
                    <strong>Browser only:</strong> Sign-in works exclusively in a
                    web browser (via <code className="mp-code-inline">WebCrypto</code>{" "}
                    non-extractable keys), never via headless or CLI scripts.
                  </div>
                </div>
              </div>

              <button
                type="button"
                className="mp-btn mp-btn--primary"
                disabled={isInitializing}
                style={{
                  width: "100%",
                  justifyContent: "center",
                  padding: "0.75rem 1rem",
                  fontSize: "0.95rem",
                  marginBottom: "1.25rem",
                }}
                onClick={handleLaunchTideEnclave}
              >
                <IconShield width={18} height={18} />
                {isInitializing
                  ? "Initializing TideCloak SDK…"
                  : "Continue with TideCloak Secure Web Enclave"}
              </button>

              <div
                style={{
                  borderTop: "1px solid var(--mp-border)",
                  paddingTop: "1rem",
                  marginTop: "0.5rem",
                }}
              >
                <form onSubmit={handleEmailLookupLogin}>
                  <div className="mp-field" style={{ marginBottom: "0.75rem" }}>
                    <label className="mp-label" htmlFor="login-email-input">
                      Or Sign In by Registered MedPool Account Email
                    </label>
                    <div style={{ display: "flex", gap: "0.5rem" }}>
                      <input
                        id="login-email-input"
                        type="email"
                        className="mp-input"
                        placeholder="e.g. dr.chen@medpool.org or your newly signed-up email"
                        value={emailInput}
                        onChange={(e) => setEmailInput(e.target.value)}
                      />
                      <button type="submit" className="mp-btn mp-btn--navy">
                        Sign In
                      </button>
                    </div>
                    <span
                      style={{
                        fontSize: "0.73rem",
                        color: "var(--mp-text-muted)",
                        marginTop: "0.25rem",
                      }}
                    >
                      No password input — resumes the DPoP-bound browser session
                      for your registered TideCloak VUID.
                    </span>
                  </div>
                </form>
              </div>

              {error && (
                <div
                  role="alert"
                  className="mp-callout mp-callout--danger"
                  style={{ marginTop: "0.85rem" }}
                >
                  <div>
                    <div className="mp-callout__title">Sign-In Notice</div>
                    <div className="mp-callout__desc">{error}</div>
                  </div>
                </div>
              )}

              <div
                style={{
                  marginTop: "1.25rem",
                  paddingTop: "1rem",
                  borderTop: "1px solid var(--mp-border)",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  fontSize: "0.83rem",
                }}
              >
                <span style={{ color: "var(--mp-text-secondary)" }}>
                  New to the MedPool consortium?
                </span>
                <Link
                  href="/signup"
                  style={{
                    color: "var(--mp-primary)",
                    fontWeight: 700,
                    textDecoration: "none",
                  }}
                >
                  Create an account &amp; request a role →
                </Link>
              </div>
            </div>
          </section>

          {/* Right Column: Seeded Synthetic Demo Accounts for Presentation */}
          <section className="mp-card" aria-labelledby="demo-accounts-heading">
            <div className="mp-card__header">
              <div>
                <h2
                  id="demo-accounts-heading"
                  className="mp-card__title"
                  style={{ fontSize: "1.1rem" }}
                >
                  Seeded Demo Accounts (1-Click Presentation Switcher)
                </h2>
                <p className="mp-card__subtitle">
                  Pre-configured TideCloak VUID identities for all roles
                  (Patient, Doctor, Researcher, 3 Ethics Board Members, Rogue
                  Sysadmin) plus any accounts you create on Sign Up.
                </p>
              </div>
            </div>
            <div className="mp-card__body">
              {loading ? (
                <p style={{ fontSize: "0.85rem", color: "var(--mp-text-muted)" }}>
                  Loading accounts...
                </p>
              ) : (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.6rem",
                  }}
                >
                  {accounts.map((acct) => {
                    const isBusy = busyAccountId === acct.id;
                    const roleBadgeVariant =
                      acct.activeRole === "researcher" ||
                      acct.activeRole === "ethics-board" ||
                      acct.activeRole === "patient" ||
                      acct.activeRole === "doctor"
                        ? "success"
                        : acct.activeRole === "pending"
                        ? "warning"
                        : "danger";

                    return (
                      <div
                        key={acct.id}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: "0.75rem",
                          padding: "0.7rem 0.85rem",
                          borderRadius: "var(--mp-radius-md)",
                          border: "1px solid var(--mp-border)",
                          background: "var(--mp-bg-subtle)",
                        }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "0.5rem",
                              flexWrap: "wrap",
                            }}
                          >
                            <strong style={{ fontSize: "0.86rem" }}>
                              {acct.name || "(Profile Name Pending)"}
                            </strong>
                            <StatusBadge
                              variant={roleBadgeVariant}
                              icon={
                                acct.activeRole === "pending" ? (
                                  <IconClock width={11} height={11} />
                                ) : (
                                  <IconCheck width={11} height={11} />
                                )
                              }
                            >
                              {acct.activeRole.toUpperCase()}
                            </StatusBadge>
                            {acct.roleRequestStatus === "PENDING" && (
                              <StatusBadge variant="warning">
                                Requested: {acct.requestedRole} (Pending 2/3
                                Quorum)
                              </StatusBadge>
                            )}
                          </div>
                          <div
                            style={{
                              fontSize: "0.76rem",
                              color: "var(--mp-text-secondary)",
                              marginTop: "0.2rem",
                            }}
                          >
                            {acct.email || "(No email attached yet)"} ·{" "}
                            {acct.hospital || "Consortium Member"}
                          </div>
                          <div
                            className="mp-mono"
                            style={{
                              fontSize: "0.7rem",
                              color: "var(--mp-text-muted)",
                              marginTop: "0.15rem",
                            }}
                          >
                            vuid: {acct.vuid.slice(0, 22)}... ·{" "}
                            {getRoleDisplayLabel(acct.activeRole)}
                          </div>
                        </div>

                        <button
                          type="button"
                          className="mp-btn mp-btn--primary mp-btn--sm"
                          disabled={isBusy}
                          onClick={() => handleAccountLogin(acct)}
                          style={{ flexShrink: 0 }}
                        >
                          {isBusy ? "Signing in..." : "Sign In as Role →"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
