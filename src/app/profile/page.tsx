"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTideCloak } from "@tidecloak/nextjs";
import type {
  AuditLogEntry,
  MedPoolAccount,
  RoleApprovalRequest,
} from "@/lib/medpool/types";
import {
  getStoredAccountId,
  setStoredAccountId,
  setSessionExpiredFlag,
  resolveActiveAccount,
  getRoleDisplayLabel,
} from "@/lib/auth/session";
import { appFetch, refreshTideSessionToken } from "@/lib/auth/appFetch";
import {
  IconShield,
  IconLock,
  IconCheck,
  IconClock,
  IconBan,
  StatusBadge,
} from "@/components/ui/DesignSystem";

export default function ProfilePage() {
  const router = useRouter();
  const {
    authenticated,
    logout: tideLogout,
    getValueFromToken,
  } = useTideCloak();

  const [accounts, setAccounts] = useState<MedPoolAccount[]>([]);
  const [roleRequests, setRoleRequests] = useState<RoleApprovalRequest[]>([]);
  const [auditLog, setAuditLog] = useState<AuditLogEntry[]>([]);
  const [storedId, setStoredId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Gotcha #9: Inline profile completion for new Tide accounts with no name/email
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");

  const loadData = useCallback(async () => {
    try {
      const r = await appFetch("/api/medpool/state");
      const d = await r.json();
      setAccounts(d.accounts || []);
      setRoleRequests(d.roleRequests || []);
      setAuditLog(d.auditLog || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setStoredId(getStoredAccountId());
    loadData();
  }, [loadData]);

  const liveVuid = authenticated
    ? (getValueFromToken("vuid") as string) || undefined
    : undefined;
  const currentAccount = resolveActiveAccount(accounts, storedId, liveVuid);

  const userRoleRequests = currentAccount
    ? roleRequests.filter((rr) => rr.accountId === currentAccount.id)
    : [];
  const latestRoleRequest = userRoleRequests[0] || null;

  const userAuditEntries = currentAccount
    ? auditLog.filter(
        (e) =>
          e.actorAccountId === currentAccount.id ||
          (currentAccount.name &&
            e.actor.toLowerCase().includes(currentAccount.name.toLowerCase())) ||
          (currentAccount.email &&
            e.actor.toLowerCase().includes(currentAccount.email.toLowerCase()))
      )
    : [];

  function copyText(key: string, text: string) {
    navigator.clipboard?.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  }

  async function handleRefreshAccessNow() {
    setBusy(true);
    try {
      const refreshed = await refreshTideSessionToken();
      await loadData();
      setMessage(
        refreshed.refreshedLiveToken
          ? "Session refreshed via IAMService.updateIamToken() — latest role and revocation state applied."
          : "Session state refreshed from server — latest role and revocation state applied."
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveMissingProfile(e: React.FormEvent) {
    e.preventDefault();
    if (!currentAccount) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await appFetch("/api/medpool/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "UPDATE_PROFILE_DETAILS",
          accountId: currentAccount.id,
          vuid: currentAccount.vuid,
          name: editName.trim(),
          email: editEmail.trim(),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setMessage(json.error || "Could not update profile details.");
      } else {
        setMessage("Profile name and email saved to your Tide identity.");
      }
      await loadData();
    } finally {
      setBusy(false);
    }
  }

  async function handleRequestElevation(
    requestedRole: "researcher" | "ethics-board"
  ) {
    if (!currentAccount) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await appFetch("/api/medpool/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "REQUEST_ROLE_UPGRADE",
          accountId: currentAccount.id,
          requestedRole,
        }),
      });
      const json = await res.json();
      if (!res.ok && res.status !== 202) {
        setMessage(json.error || "Could not submit role request.");
      } else {
        setMessage(
          `HTTP 202 Accepted: Role request for '${requestedRole}' queued (${json.roleRequest?.id}). Requires 2-of-3 Ethics Board quorum approval.`
        );
      }
      await loadData();
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    if (currentAccount) {
      await appFetch("/api/medpool/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "LOGOUT_ACCOUNT",
          accountId: currentAccount.id,
        }),
      }).catch(() => {});
    }
    setStoredAccountId(null);
    if (authenticated) {
      tideLogout();
      return;
    }
    router.push("/login");
  }

  function handleSimulateSessionExpired() {
    setStoredAccountId(null);
    setSessionExpiredFlag(true);
    router.push("/login?expired=1");
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
                <span className="mp-brand__badge">Identity &amp; Role Profile</span>
              </div>
              <span className="mp-brand__subtitle">
                TideCloak VUID Profile · Role Approval Status · Personal Audit
                Trail
              </span>
            </div>
          </Link>
          <div className="mp-topbar__actions">
            <Link href="/" className="mp-btn">
              ← Back to Dashboard
            </Link>
            {currentAccount ? (
              <>
                <button
                  type="button"
                  className="mp-btn mp-btn--sm"
                  disabled={busy}
                  onClick={handleRefreshAccessNow}
                  title="Gotcha #10: Refresh session token so role or revocation changes appear immediately"
                >
                  Refresh Access
                </button>
                <button
                  type="button"
                  className="mp-btn mp-btn--sm"
                  onClick={handleSimulateSessionExpired}
                  title="Test expired token handling"
                >
                  Simulate Expired Session
                </button>
                <button
                  type="button"
                  className="mp-btn mp-btn--danger mp-btn--sm"
                  onClick={handleLogout}
                >
                  Sign Out
                </button>
              </>
            ) : (
              <Link href="/login" className="mp-btn mp-btn--primary">
                Sign In
              </Link>
            )}
          </div>
        </div>
      </header>

      <main className="mp-main" style={{ maxWidth: 1080 }}>
        {loading ? (
          <div className="mp-card">
            <div className="mp-card__body">Loading profile...</div>
          </div>
        ) : !currentAccount ? (
          /* Protected Route Guard: Unauthenticated users redirected/prompted to login */
          <section className="mp-card" aria-labelledby="unauth-profile-title">
            <div className="mp-card__header">
              <div>
                <h1
                  id="unauth-profile-title"
                  className="mp-card__title"
                  style={{ fontSize: "1.2rem" }}
                >
                  Authentication Required (Protected Route)
                </h1>
                <p className="mp-card__subtitle">
                  You must sign in via TideCloak to view your cryptographic
                  profile and role governance status.
                </p>
              </div>
              <StatusBadge
                variant="danger"
                icon={<IconLock width={12} height={12} />}
              >
                401 Unauthenticated
              </StatusBadge>
            </div>
            <div className="mp-card__body">
              <div
                className="mp-callout mp-callout--warning"
                style={{ marginBottom: "1rem" }}
              >
                <IconLock width={18} height={18} />
                <div>
                  <div className="mp-callout__title">No Active Session</div>
                  <div className="mp-callout__desc">
                    Please authenticate through TideCloak&apos;s Secure Web
                    Enclave or select one of the seeded presentation accounts on
                    the Sign In page.
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", gap: "0.75rem" }}>
                <Link href="/login" className="mp-btn mp-btn--primary">
                  Go to Sign In →
                </Link>
                <Link href="/signup" className="mp-btn">
                  Create New Account
                </Link>
              </div>
            </div>
          </section>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "1.25rem",
            }}
          >
            {message && (
              <div role="status" className="mp-callout mp-callout--teal">
                <IconCheck width={18} height={18} />
                <div>
                  <div className="mp-callout__title">
                    Role &amp; Session Governance Update
                  </div>
                  <div className="mp-callout__desc">{message}</div>
                </div>
              </div>
            )}

            {/* Gotcha #9: If a new Tide account has no name or email yet, show a short profile form */}
            {(!currentAccount.name || !currentAccount.email) && (
              <section
                className="mp-card"
                aria-labelledby="complete-profile-heading"
              >
                <div className="mp-card__header">
                  <div>
                    <h2
                      id="complete-profile-heading"
                      className="mp-card__title"
                      style={{ fontSize: "1.1rem" }}
                    >
                      Complete Your New Tide Profile (Name &amp; Email)
                    </h2>
                    <p className="mp-card__subtitle">
                      A new TideCloak account starts with only an anonymous{" "}
                      <code className="mp-code-inline">vuid</code> (no
                      placeholder name or email is generated). Enter your
                      details below.
                    </p>
                  </div>
                  <StatusBadge variant="warning">Profile Incomplete</StatusBadge>
                </div>
                <div className="mp-card__body">
                  <form
                    onSubmit={handleSaveMissingProfile}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr auto",
                      gap: "0.75rem",
                      alignItems: "end",
                    }}
                  >
                    <div className="mp-field">
                      <label className="mp-label" htmlFor="profile-edit-name">
                        Full Name
                      </label>
                      <input
                        id="profile-edit-name"
                        type="text"
                        className="mp-input"
                        placeholder="e.g. Dr. Elena Chen"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        required
                      />
                    </div>
                    <div className="mp-field">
                      <label className="mp-label" htmlFor="profile-edit-email">
                        Email Address
                      </label>
                      <input
                        id="profile-edit-email"
                        type="email"
                        className="mp-input"
                        placeholder="e.g. e.chen@medpool.org"
                        value={editEmail}
                        onChange={(e) => setEditEmail(e.target.value)}
                        required
                      />
                    </div>
                    <button
                      type="submit"
                      className="mp-btn mp-btn--primary"
                      disabled={busy}
                    >
                      Save Details
                    </button>
                  </form>
                </div>
              </section>
            )}

            <div className="mp-grid-2" style={{ alignItems: "start" }}>
              {/* Card 1: Current User & Cryptographic Claims */}
              <section
                className="mp-card"
                aria-labelledby="profile-user-heading"
              >
                <div className="mp-card__header">
                  <div>
                    <h1
                      id="profile-user-heading"
                      className="mp-card__title"
                      style={{ fontSize: "1.15rem" }}
                    >
                      {currentAccount.name ||
                        `Tide Identity (${currentAccount.vuid.slice(0, 12)}…)`}
                    </h1>
                    <p className="mp-card__subtitle">
                      {currentAccount.email || "No email attached yet"} ·{" "}
                      {currentAccount.hospital}
                    </p>
                  </div>
                  <StatusBadge
                    variant={
                      currentAccount.activeRole === "pending"
                        ? "warning"
                        : currentAccount.activeRole === "sysadmin"
                        ? "danger"
                        : "success"
                    }
                    icon={<IconShield width={12} height={12} />}
                  >
                    ROLE: {currentAccount.activeRole.toUpperCase()}
                  </StatusBadge>
                </div>

                <div className="mp-card__body">
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.75rem",
                    }}
                  >
                    <div>
                      <div
                        style={{
                          fontSize: "0.74rem",
                          fontWeight: 700,
                          textTransform: "uppercase",
                          color: "var(--mp-text-muted)",
                        }}
                      >
                        Role Scope Description
                      </div>
                      <div style={{ fontSize: "0.86rem", fontWeight: 600 }}>
                        {getRoleDisplayLabel(currentAccount.activeRole)}
                      </div>
                    </div>

                    <div>
                      <div
                        style={{
                          fontSize: "0.74rem",
                          fontWeight: 700,
                          textTransform: "uppercase",
                          color: "var(--mp-text-muted)",
                          marginBottom: "0.25rem",
                        }}
                      >
                        TideCloak Anonymous VUID
                      </div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "0.5rem",
                        }}
                      >
                        <code
                          className="mp-code-inline"
                          style={{
                            flex: 1,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {currentAccount.vuid}
                        </code>
                        <button
                          type="button"
                          className="mp-copy-btn"
                          onClick={() => copyText("vuid", currentAccount.vuid)}
                        >
                          {copiedKey === "vuid" ? "Copied" : "Copy"}
                        </button>
                      </div>
                    </div>

                    <div>
                      <div
                        style={{
                          fontSize: "0.74rem",
                          fontWeight: 700,
                          textTransform: "uppercase",
                          color: "var(--mp-text-muted)",
                          marginBottom: "0.25rem",
                        }}
                      >
                        DPoP Sender-Constrained Key Thumbprint (cnf.jkt)
                      </div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "0.5rem",
                        }}
                      >
                        <code className="mp-code-inline" style={{ flex: 1 }}>
                          {currentAccount.dpopThumbprint}
                        </code>
                        <button
                          type="button"
                          className="mp-copy-btn"
                          onClick={() =>
                            copyText("jkt", currentAccount.dpopThumbprint)
                          }
                        >
                          {copiedKey === "jkt" ? "Copied" : "Copy"}
                        </button>
                      </div>
                    </div>

                    <div>
                      <div
                        style={{
                          fontSize: "0.74rem",
                          fontWeight: 700,
                          textTransform: "uppercase",
                          color: "var(--mp-text-muted)",
                          marginBottom: "0.3rem",
                        }}
                      >
                        Active Realm Roles in Token
                      </div>
                      <div
                        style={{
                          display: "flex",
                          gap: "0.4rem",
                          flexWrap: "wrap",
                        }}
                      >
                        {currentAccount.realmRoles.map((r) => (
                          <code key={r} className="mp-code-inline">
                            {r}
                          </code>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </section>

              {/* Card 2: Role Request & Quorum Governance Status */}
              <section
                className="mp-card"
                aria-labelledby="profile-role-req-heading"
              >
                <div className="mp-card__header">
                  <div>
                    <h2
                      id="profile-role-req-heading"
                      className="mp-card__title"
                      style={{ fontSize: "1.1rem" }}
                    >
                      Elevated Role Request &amp; Quorum Status
                    </h2>
                    <p className="mp-card__subtitle">
                      Sensitive roles (Researcher, Ethics Board) require 2-of-3
                      Ethics Board quorum approval.
                    </p>
                  </div>
                  <StatusBadge
                    variant={
                      currentAccount.roleRequestStatus === "APPROVED"
                        ? "success"
                        : currentAccount.roleRequestStatus === "PENDING"
                        ? "warning"
                        : currentAccount.roleRequestStatus === "REJECTED"
                        ? "danger"
                        : "neutral"
                    }
                    icon={
                      currentAccount.roleRequestStatus === "APPROVED" ? (
                        <IconCheck width={12} height={12} />
                      ) : currentAccount.roleRequestStatus === "PENDING" ? (
                        <IconClock width={12} height={12} />
                      ) : currentAccount.roleRequestStatus === "REJECTED" ? (
                        <IconBan width={12} height={12} />
                      ) : undefined
                    }
                  >
                    {currentAccount.roleRequestStatus}
                  </StatusBadge>
                </div>

                <div className="mp-card__body">
                  {latestRoleRequest ? (
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "0.75rem",
                      }}
                    >
                      <div
                        style={{
                          padding: "0.85rem",
                          borderRadius: "var(--mp-radius-md)",
                          border: "1px solid var(--mp-border)",
                          background: "var(--mp-bg-subtle)",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            marginBottom: "0.4rem",
                          }}
                        >
                          <strong style={{ fontSize: "0.88rem" }}>
                            Requested Role:{" "}
                            {latestRoleRequest.requestedRole.toUpperCase()}
                          </strong>
                          <code className="mp-code-inline">
                            {latestRoleRequest.id}
                          </code>
                        </div>

                        <div
                          style={{
                            fontSize: "0.78rem",
                            color: "var(--mp-text-secondary)",
                            marginBottom: "0.5rem",
                          }}
                        >
                          Ethics Board Quorum Progress:{" "}
                          <strong>
                            {latestRoleRequest.approvals.length} /{" "}
                            {latestRoleRequest.threshold}
                          </strong>{" "}
                          required approvals (of {latestRoleRequest.totalAdmins}{" "}
                          board members)
                        </div>

                        <div
                          className="mp-progress-track"
                          style={{ marginBottom: "0.6rem" }}
                        >
                          <div
                            className={`mp-progress-fill ${
                              latestRoleRequest.approvals.length >=
                              latestRoleRequest.threshold
                                ? "mp-progress-fill--complete"
                                : ""
                            }`}
                            style={{
                              width: `${Math.min(
                                100,
                                (latestRoleRequest.approvals.length /
                                  latestRoleRequest.threshold) *
                                  100
                              )}%`,
                            }}
                          />
                        </div>

                        {latestRoleRequest.approvals.length > 0 && (
                          <div
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.3rem",
                            }}
                          >
                            {latestRoleRequest.approvals.map((a) => (
                              <div
                                key={a.adminId}
                                style={{
                                  fontSize: "0.75rem",
                                  color: "var(--mp-success)",
                                  fontWeight: 600,
                                }}
                              >
                                ✓ Signed by {a.adminName} ({a.hospital}) —{" "}
                                <code className="mp-code-inline">
                                  {a.enclaveSigPreview}
                                </code>
                              </div>
                            ))}
                          </div>
                        )}

                        {latestRoleRequest.status === "REJECTED" &&
                          latestRoleRequest.rejectedBy && (
                            <div
                              className="mp-callout mp-callout--danger"
                              style={{ marginTop: "0.5rem" }}
                            >
                              <div>
                                <div className="mp-callout__title">
                                  Rejected by{" "}
                                  {latestRoleRequest.rejectedBy.adminName}
                                </div>
                                <div className="mp-callout__desc">
                                  {latestRoleRequest.rejectedBy.reason}
                                </div>
                              </div>
                            </div>
                          )}
                      </div>

                      {latestRoleRequest.status === "PENDING" && (
                        <div className="mp-callout mp-callout--warning">
                          <IconClock width={16} height={16} />
                          <div>
                            <div className="mp-callout__title">
                              Awaiting Ethics Board Quorum
                            </div>
                            <div className="mp-callout__desc">
                              Switch to an Ethics Board account or open the{" "}
                              <Link
                                href="/?tab=board"
                                style={{
                                  color: "inherit",
                                  fontWeight: 700,
                                  textDecoration: "underline",
                                }}
                              >
                                Access &amp; Approval Board
                              </Link>{" "}
                              to sign the 2-of-3 quorum approvals.
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div
                      style={{
                        fontSize: "0.84rem",
                        color: "var(--mp-text-secondary)",
                        marginBottom: "0.85rem",
                      }}
                    >
                      Current role{" "}
                      <strong>{currentAccount.activeRole.toUpperCase()}</strong>{" "}
                      is{" "}
                      {currentAccount.roleRequestStatus === "APPROVED"
                        ? "active and verified."
                        : "operating with baseline permissions."}
                    </div>
                  )}

                  {(currentAccount.activeRole === "patient" ||
                    currentAccount.activeRole === "doctor" ||
                    currentAccount.roleRequestStatus === "REJECTED") && (
                    <div
                      style={{
                        marginTop: "0.85rem",
                        paddingTop: "0.85rem",
                        borderTop: "1px solid var(--mp-border)",
                      }}
                    >
                      <div
                        style={{
                          fontSize: "0.78rem",
                          fontWeight: 700,
                          marginBottom: "0.5rem",
                        }}
                      >
                        Request Elevated Role (Requires 2/3 Ethics Quorum):
                      </div>
                      <div
                        style={{
                          display: "flex",
                          gap: "0.5rem",
                          flexWrap: "wrap",
                        }}
                      >
                        <button
                          type="button"
                          className="mp-btn mp-btn--primary mp-btn--sm"
                          disabled={busy}
                          onClick={() => handleRequestElevation("researcher")}
                        >
                          Request Researcher Role
                        </button>
                        <button
                          type="button"
                          className="mp-btn mp-btn--navy mp-btn--sm"
                          disabled={busy}
                          onClick={() => handleRequestElevation("ethics-board")}
                        >
                          Request Ethics Board Role
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </section>
            </div>

            {/* Card 3: User's Personal Audit Trail Activity */}
            <section
              className="mp-card"
              aria-labelledby="profile-audit-heading"
            >
              <div className="mp-card__header">
                <div>
                  <h2
                    id="profile-audit-heading"
                    className="mp-card__title"
                    style={{ fontSize: "1.1rem" }}
                  >
                    Recent Activity in Cryptographic Audit Trail
                  </h2>
                  <p className="mp-card__subtitle">
                    Events associated with{" "}
                    {currentAccount.name || currentAccount.vuid.slice(0, 12)}{" "}
                    (sign-ups, logins, role requests, consent, and study
                    actions).
                  </p>
                </div>
                <StatusBadge variant="neutral">
                  {userAuditEntries.length} Event(s)
                </StatusBadge>
              </div>
              <div className="mp-card__body">
                {userAuditEntries.length === 0 ? (
                  <p
                    style={{
                      fontSize: "0.84rem",
                      color: "var(--mp-text-muted)",
                    }}
                  >
                    No activity recorded yet for this account.
                  </p>
                ) : (
                  <div className="mp-timeline">
                    {userAuditEntries.slice(0, 12).map((entry) => (
                      <div key={entry.id} className="mp-timeline-item">
                        <div className="mp-timeline-dot" aria-hidden="true">
                          <IconShield width={14} height={14} />
                        </div>
                        <div className="mp-timeline-content">
                          <div className="mp-timeline-header">
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "0.5rem",
                                flexWrap: "wrap",
                              }}
                            >
                              <StatusBadge
                                variant={
                                  entry.outcome === "ALLOWED"
                                    ? "success"
                                    : entry.outcome === "PENDING_QUORUM_202"
                                    ? "warning"
                                    : "danger"
                                }
                              >
                                HTTP {entry.httpStatus} · {entry.outcome}
                              </StatusBadge>
                              <strong style={{ fontSize: "0.84rem" }}>
                                {entry.action}
                              </strong>
                            </div>
                            <span className="mp-timeline-time">
                              {new Date(entry.timestamp).toLocaleTimeString()}
                            </span>
                          </div>
                          <div
                            style={{
                              fontSize: "0.79rem",
                              color: "var(--mp-text-secondary)",
                              marginTop: "0.25rem",
                            }}
                          >
                            {entry.detail}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
