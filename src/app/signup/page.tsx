"use client";

import React, { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTideCloak } from "@tidecloak/nextjs";
import type {
  MedPoolAccount,
  RequestedRoleType,
  RoleApprovalRequest,
} from "@/lib/medpool/types";
import {
  setStoredAccountId,
  getDefaultTabForRole,
} from "@/lib/auth/session";
import { appFetch, runWithPopupDetection } from "@/lib/auth/appFetch";
import {
  IconShield,
  IconLock,
  IconCheck,
  IconClock,
  StatusBadge,
} from "@/components/ui/DesignSystem";

const ROLE_OPTIONS: {
  value: RequestedRoleType;
  title: string;
  badge: string;
  badgeVariant: "success" | "warning";
  description: string;
}[] = [
  {
    value: "patient",
    title: "Patient (Cohort Participant)",
    badge: "Minimal Permissions · Active Immediately",
    badgeVariant: "success",
    description:
      "Inspect your own clinical record status and sign or revoke self-sovereign consent attestations. Cannot decrypt other patients' clinical records.",
  },
  {
    value: "doctor",
    title: "Attending Doctor / Clinician",
    badge: "Metadata-Only · Active Immediately",
    badgeVariant: "success",
    description:
      "Search non-sensitive cohort metadata across participating hospitals. Cannot unlock or decrypt raw clinical study payloads.",
  },
  {
    value: "researcher",
    title: "Principal Investigator / Researcher",
    badge: "Elevated Role · Requires 2/3 Ethics Quorum",
    badgeVariant: "warning",
    description:
      "Starts with minimal read-only permissions. Unlocking the In-Browser Decryption & AI Sandbox requires 2-of-3 Ethics Board quorum approval.",
  },
  {
    value: "ethics-board",
    title: "Ethics Board Member (IRB Approver)",
    badge: "Governance Role · Requires 2/3 Ethics Quorum",
    badgeVariant: "warning",
    description:
      "Starts with minimal permissions. Joining the Ethics Board quorum requires 2-of-3 existing Ethics Board enclave signatures.",
  },
];

export default function SignupPage() {
  const router = useRouter();
  const { login: tideLogin, isInitializing } = useTideCloak();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [hospital, setHospital] = useState("Royal Melbourne Clinical (AU)");
  const [requestedRole, setRequestedRole] =
    useState<RequestedRoleType>("researcher");

  const [fieldErrors, setFieldErrors] = useState<{
    name?: string;
    email?: string;
  }>({});
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [popupBlockedError, setPopupBlockedError] = useState<string | null>(
    null
  );

  const [createdResult, setCreatedResult] = useState<{
    account: MedPoolAccount;
    roleRequest: RoleApprovalRequest | null;
  } | null>(null);

  function handleLaunchTideEnclaveSignup() {
    if (isInitializing) return;
    setPopupBlockedError(null);
    runWithPopupDetection(
      () => tideLogin(),
      (blockedMsg) => setPopupBlockedError(blockedMsg)
    );
  }

  function validate(): boolean {
    const errs: { name?: string; email?: string } = {};
    if (!name.trim() || name.trim().length < 2) {
      errs.name = "Please enter your full name (at least 2 characters).";
    }
    if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      errs.email =
        "Please enter a valid institutional or personal email address.";
    }
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);
    if (!validate()) return;

    setSubmitting(true);
    try {
      const res = await appFetch("/api/medpool/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "SIGNUP_ACCOUNT",
          name: name.trim(),
          email: email.trim(),
          hospital: hospital.trim(),
          requestedRole,
          authMethod: "TIDECLOAK_SWE",
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setServerError(json.error || "Registration failed.");
        return;
      }
      setStoredAccountId(json.account.id);
      setCreatedResult({
        account: json.account,
        roleRequest: json.roleRequest || null,
      });
    } catch (err) {
      setServerError(
        err instanceof Error ? err.message : "Network error during sign-up."
      );
    } finally {
      setSubmitting(false);
    }
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
                <span className="mp-brand__badge">
                  Zero-Knowledge Registration
                </span>
              </div>
              <span className="mp-brand__subtitle">
                TideCloak Identity Provisioning · Quorum-Governed Role Assignment
              </span>
            </div>
          </Link>
          <div className="mp-topbar__actions">
            <Link href="/login" className="mp-btn">
              Sign In
            </Link>
            <Link href="/" className="mp-btn">
              Back to Overview
            </Link>
          </div>
        </div>
      </header>

      <main className="mp-main" style={{ maxWidth: 880 }}>
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
              onClick={handleLaunchTideEnclaveSignup}
            >
              Try Again
            </button>
          </div>
        )}

        {!createdResult ? (
          <section className="mp-card" aria-labelledby="signup-heading">
            <div className="mp-card__header">
              <div>
                <h1
                  id="signup-heading"
                  className="mp-card__title"
                  style={{ fontSize: "1.25rem" }}
                >
                  Create Your MedPool Account
                </h1>
                <p className="mp-card__subtitle">
                  Register with TideCloak and request your clinical or research
                  role. New accounts always start with minimal, non-sensitive
                  permissions.
                </p>
              </div>
              <StatusBadge
                variant="info"
                icon={<IconLock width={12} height={12} />}
              >
                No Passwords Stored
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
                    Notice there is no password field on this form. MedPool
                    never collects, hashes, or stores passwords or private keys.
                    TideCloak handles credential creation inside the
                    zero-knowledge Secure Web Enclave, and elevated roles (
                    <code className="mp-code-inline">researcher</code>,{" "}
                    <code className="mp-code-inline">ethics-board</code>)
                    require <strong>2-of-3 Ethics Board quorum approval</strong>{" "}
                    before activation.
                  </div>
                </div>
              </div>

              {/* Gotchas #3, #4, #9: Pop-up & Browser-Only & Profile Onboarding Notice */}
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
                    Allow Pop-Ups · Browser-Only Sign-Up · Profile Collection
                  </div>
                  <div className="mp-callout__desc">
                    <strong>Allow pop-ups:</strong> Creating a Tide identity
                    opens a small Secure Web Enclave window in your browser.{" "}
                    <strong>Browser only:</strong> Sign-up works only in a
                    browser (no headless/CLI sign-in).{" "}
                    <strong>New Tide accounts:</strong> A brand-new Tide enclave
                    account has only an anonymous{" "}
                    <code className="mp-code-inline">vuid</code> (no name or
                    email) until you complete the short profile onboarding form.
                  </div>
                </div>
              </div>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "12px",
                  flexWrap: "wrap",
                  padding: "12px 14px",
                  borderRadius: "var(--mp-radius-md)",
                  border: "1px solid var(--mp-border-strong)",
                  backgroundColor: "var(--mp-bg-subtle)",
                  marginBottom: "1.25rem",
                }}
              >
                <div>
                  <div style={{ fontWeight: 700, fontSize: "0.88rem" }}>
                    Option 1 · Native TideCloak Enclave Sign-Up (
                    <code className="mp-code-inline">useTideCloak().login()</code>
                    )
                  </div>
                  <div
                    style={{
                      fontSize: "0.78rem",
                      color: "var(--mp-text-secondary)",
                    }}
                  >
                    Launches the TideCloak Secure Web Enclave (
                    <code className="mp-code-inline">
                      registrationAllowed: true
                    </code>
                    ) to mint a hardware-bound{" "}
                    <code className="mp-code-inline">vuid</code> with minimal{" "}
                    <code className="mp-code-inline">default-roles-medpool</code>{" "}
                    permissions, followed by the Profile Onboarding prompt.
                  </div>
                </div>
                <button
                  type="button"
                  className="mp-btn mp-btn--primary"
                  disabled={isInitializing}
                  onClick={handleLaunchTideEnclaveSignup}
                >
                  <IconShield width={16} height={16} />
                  {isInitializing
                    ? "Initializing SDK…"
                    : "Create Account in Tide Enclave"}
                </button>
              </div>

              <form onSubmit={handleSubmit} noValidate>
                <div className="mp-grid-2" style={{ marginBottom: "1rem" }}>
                  <div className="mp-field">
                    <label className="mp-label" htmlFor="signup-name">
                      Full Name <span aria-hidden="true">*</span>
                    </label>
                    <input
                      id="signup-name"
                      type="text"
                      className="mp-input"
                      placeholder="e.g. Dr. Maya Patel"
                      value={name}
                      onChange={(e) => {
                        setName(e.target.value);
                        if (fieldErrors.name)
                          setFieldErrors({ ...fieldErrors, name: undefined });
                      }}
                      aria-invalid={Boolean(fieldErrors.name)}
                      aria-describedby={
                        fieldErrors.name ? "signup-name-err" : undefined
                      }
                    />
                    {fieldErrors.name && (
                      <span
                        id="signup-name-err"
                        role="alert"
                        style={{
                          color: "var(--mp-danger)",
                          fontSize: "0.75rem",
                          fontWeight: 600,
                        }}
                      >
                        {fieldErrors.name}
                      </span>
                    )}
                  </div>

                  <div className="mp-field">
                    <label className="mp-label" htmlFor="signup-email">
                      Email Address <span aria-hidden="true">*</span>
                    </label>
                    <input
                      id="signup-email"
                      type="email"
                      className="mp-input"
                      placeholder="e.g. m.patel@oxford-oncology.uk"
                      value={email}
                      onChange={(e) => {
                        setEmail(e.target.value);
                        if (fieldErrors.email)
                          setFieldErrors({ ...fieldErrors, email: undefined });
                      }}
                      aria-invalid={Boolean(fieldErrors.email)}
                      aria-describedby={
                        fieldErrors.email ? "signup-email-err" : undefined
                      }
                    />
                    {fieldErrors.email && (
                      <span
                        id="signup-email-err"
                        role="alert"
                        style={{
                          color: "var(--mp-danger)",
                          fontSize: "0.75rem",
                          fontWeight: 600,
                        }}
                      >
                        {fieldErrors.email}
                      </span>
                    )}
                  </div>
                </div>

                <div className="mp-field" style={{ marginBottom: "1.15rem" }}>
                  <label className="mp-label" htmlFor="signup-hospital">
                    Hospital / Research Institution
                  </label>
                  <input
                    id="signup-hospital"
                    type="text"
                    className="mp-input"
                    value={hospital}
                    onChange={(e) => setHospital(e.target.value)}
                  />
                </div>

                <fieldset
                  style={{
                    border: "none",
                    padding: 0,
                    margin: "0 0 1.25rem 0",
                  }}
                >
                  <legend
                    className="mp-label"
                    style={{ marginBottom: "0.55rem", fontSize: "0.82rem" }}
                  >
                    Select Requested Role <span aria-hidden="true">*</span>
                  </legend>
                  <div className="mp-grid-2">
                    {ROLE_OPTIONS.map((opt) => {
                      const selected = requestedRole === opt.value;
                      return (
                        <label
                          key={opt.value}
                          htmlFor={`role-opt-${opt.value}`}
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: "0.35rem",
                            padding: "0.85rem",
                            borderRadius: "var(--mp-radius-md)",
                            border: selected
                              ? "2px solid var(--mp-primary)"
                              : "1px solid var(--mp-border)",
                            background: selected
                              ? "var(--mp-primary-soft)"
                              : "var(--mp-bg-subtle)",
                            cursor: "pointer",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              gap: "0.5rem",
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "0.45rem",
                              }}
                            >
                              <input
                                id={`role-opt-${opt.value}`}
                                type="radio"
                                name="requestedRole"
                                value={opt.value}
                                checked={selected}
                                onChange={() => setRequestedRole(opt.value)}
                              />
                              <strong style={{ fontSize: "0.86rem" }}>
                                {opt.title}
                              </strong>
                            </div>
                          </div>
                          <div>
                            <StatusBadge variant={opt.badgeVariant}>
                              {opt.badge}
                            </StatusBadge>
                          </div>
                          <span
                            style={{
                              fontSize: "0.76rem",
                              color: "var(--mp-text-secondary)",
                              lineHeight: 1.4,
                            }}
                          >
                            {opt.description}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>

                {serverError && (
                  <div
                    role="alert"
                    className="mp-callout mp-callout--danger"
                    style={{ marginBottom: "1rem" }}
                  >
                    <div>
                      <div className="mp-callout__title">Registration Error</div>
                      <div className="mp-callout__desc">{serverError}</div>
                    </div>
                  </div>
                )}

                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "0.75rem",
                    flexWrap: "wrap",
                  }}
                >
                  <Link
                    href="/login"
                    style={{
                      fontSize: "0.83rem",
                      color: "var(--mp-text-secondary)",
                      textDecoration: "none",
                    }}
                  >
                    Already have an account? Sign in →
                  </Link>

                  <button
                    type="submit"
                    className="mp-btn mp-btn--primary"
                    disabled={submitting}
                    style={{ padding: "0.65rem 1.25rem", fontSize: "0.9rem" }}
                  >
                    <IconShield width={16} height={16} />
                    {submitting
                      ? "Creating TideCloak Account..."
                      : "Create Account & Submit Role Request"}
                  </button>
                </div>
              </form>
            </div>
          </section>
        ) : (
          /* Confirmation Screen Explaining What Happens Next */
          <section
            className="mp-card"
            aria-labelledby="signup-confirm-heading"
          >
            <div className="mp-card__header">
              <div>
                <h1
                  id="signup-confirm-heading"
                  className="mp-card__title"
                  style={{ fontSize: "1.25rem" }}
                >
                  Account Created — Zero-Knowledge Identity Provisioned
                </h1>
                <p className="mp-card__subtitle">
                  Your account has been initialized with minimal, non-sensitive
                  permissions.
                </p>
              </div>
              <StatusBadge
                variant="success"
                icon={<IconCheck width={12} height={12} />}
              >
                Account Created
              </StatusBadge>
            </div>

            <div className="mp-card__body">
              <div
                className="mp-grid-2"
                style={{ marginBottom: "1.25rem" }}
              >
                <div
                  style={{
                    padding: "0.9rem",
                    borderRadius: "var(--mp-radius-md)",
                    border: "1px solid var(--mp-border)",
                    background: "var(--mp-bg-subtle)",
                  }}
                >
                  <div
                    style={{
                      fontSize: "0.74rem",
                      fontWeight: 700,
                      textTransform: "uppercase",
                      color: "var(--mp-text-muted)",
                      marginBottom: "0.35rem",
                    }}
                  >
                    Provisioned Identity
                  </div>
                  <div style={{ fontWeight: 700, fontSize: "0.95rem" }}>
                    {createdResult.account.name}
                  </div>
                  <div
                    style={{
                      fontSize: "0.8rem",
                      color: "var(--mp-text-secondary)",
                    }}
                  >
                    {createdResult.account.email} ·{" "}
                    {createdResult.account.hospital}
                  </div>
                  <div
                    className="mp-mono"
                    style={{
                      fontSize: "0.73rem",
                      color: "var(--mp-text-muted)",
                      marginTop: "0.35rem",
                    }}
                  >
                    vuid: {createdResult.account.vuid.slice(0, 28)}...
                  </div>
                </div>

                <div
                  style={{
                    padding: "0.9rem",
                    borderRadius: "var(--mp-radius-md)",
                    border: "1px solid var(--mp-border)",
                    background: "var(--mp-bg-subtle)",
                  }}
                >
                  <div
                    style={{
                      fontSize: "0.74rem",
                      fontWeight: 700,
                      textTransform: "uppercase",
                      color: "var(--mp-text-muted)",
                      marginBottom: "0.35rem",
                    }}
                  >
                    Initial Permissions &amp; Role Status
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.5rem",
                      flexWrap: "wrap",
                      marginBottom: "0.35rem",
                    }}
                  >
                    <span style={{ fontSize: "0.82rem", fontWeight: 600 }}>
                      Active Role:
                    </span>
                    <StatusBadge
                      variant={
                        createdResult.account.activeRole === "pending"
                          ? "warning"
                          : "success"
                      }
                    >
                      {createdResult.account.activeRole.toUpperCase()}
                    </StatusBadge>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.5rem",
                      flexWrap: "wrap",
                    }}
                  >
                    <span style={{ fontSize: "0.82rem", fontWeight: 600 }}>
                      Requested Role ({createdResult.account.requestedRole}):
                    </span>
                    <StatusBadge
                      variant={
                        createdResult.account.roleRequestStatus === "PENDING"
                          ? "warning"
                          : "success"
                      }
                      icon={
                        createdResult.account.roleRequestStatus ===
                        "PENDING" ? (
                          <IconClock width={11} height={11} />
                        ) : (
                          <IconCheck width={11} height={11} />
                        )
                      }
                    >
                      {createdResult.account.roleRequestStatus}
                    </StatusBadge>
                  </div>
                </div>
              </div>

              {/* What Happens Next Explainer */}
              {createdResult.roleRequest ? (
                <div
                  className="mp-callout mp-callout--warning"
                  style={{ marginBottom: "1.25rem" }}
                >
                  <IconClock
                    width={20}
                    height={20}
                    style={{ flexShrink: 0, marginTop: 2 }}
                  />
                  <div>
                    <div className="mp-callout__title">
                      What Happens Next: 2-of-3 Ethics Board Quorum Required (
                      {createdResult.roleRequest.id})
                    </div>
                    <div className="mp-callout__desc">
                      Because you requested the sensitive{" "}
                      <strong>{createdResult.account.requestedRole}</strong>{" "}
                      role, your account currently holds{" "}
                      <strong>minimal, non-sensitive permissions only</strong> (
                      <code className="mp-code-inline">_tide_enabled</code>). A
                      single administrator cannot grant elevated roles
                      unilaterally. At least{" "}
                      <strong>2 of the 3 Ethics Board members</strong> must
                      approve request{" "}
                      <code className="mp-code-inline">
                        {createdResult.roleRequest.id}
                      </code>{" "}
                      on the Access &amp; Approval Board before your elevated
                      privileges activate.
                    </div>
                  </div>
                </div>
              ) : (
                <div
                  className="mp-callout mp-callout--teal"
                  style={{ marginBottom: "1.25rem" }}
                >
                  <IconCheck
                    width={20}
                    height={20}
                    style={{ flexShrink: 0, marginTop: 2 }}
                  />
                  <div>
                    <div className="mp-callout__title">
                      What Happens Next: Baseline Non-Sensitive Role Active
                    </div>
                    <div className="mp-callout__desc">
                      Your <strong>{createdResult.account.activeRole}</strong>{" "}
                      account is active with non-sensitive permissions. You can
                      search de-identified metadata or manage your own consent
                      attestations, and you can request an elevated role at any
                      time from your Profile page.
                    </div>
                  </div>
                </div>
              )}

              <div
                style={{
                  display: "flex",
                  gap: "0.75rem",
                  flexWrap: "wrap",
                  justifyContent: "flex-end",
                }}
              >
                <button
                  type="button"
                  className="mp-btn"
                  onClick={handleLaunchTideEnclaveSignup}
                >
                  <IconShield width={15} height={15} />
                  Bind Live TideCloak Enclave Credential (Optional)
                </button>
                <Link href="/profile" className="mp-btn mp-btn--navy">
                  View My Profile &amp; Role Status
                </Link>
                <button
                  type="button"
                  className="mp-btn mp-btn--primary"
                  onClick={() => {
                    const tab = getDefaultTabForRole(
                      createdResult.account.activeRole
                    );
                    router.push(`/?tab=${tab}`);
                  }}
                >
                  Continue to MedPool Workspace →
                </button>
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
