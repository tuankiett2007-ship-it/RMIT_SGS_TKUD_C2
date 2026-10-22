"use client";

import React from "react";
import Link from "next/link";
import { useTideCloak } from "@tidecloak/nextjs";
import type { MedPoolRole } from "@/lib/medpool/types";
import { getRoleDisplayLabel } from "@/lib/auth/session";
import {
  IconShield,
  IconLock,
  IconBan,
  StatusBadge,
} from "@/components/ui/DesignSystem";

interface AuthGuardProps {
  children: React.ReactNode;
  allowedRoles?: MedPoolRole[];
  effectiveRole?: MedPoolRole | null;
  isAuthenticated?: boolean;
  resourceName?: string;
}

/**
 * Client-side route & role guard following Tide MCP `protect-routes-nextjs` and `add-rbac-nextjs`.
 * Always gates on `isInitializing` before invoking `login()` (AP-28).
 * Real authorization is enforced server-side via `verifyTideJWT` / `verifyTideCloakToken`.
 */
export function AuthGuard({
  children,
  allowedRoles,
  effectiveRole,
  isAuthenticated,
  resourceName = "Protected Clinical Workspace",
}: AuthGuardProps) {
  const { authenticated, isInitializing, login, hasRealmRole } = useTideCloak();

  if (isInitializing) {
    return (
      <div className="mp-card" style={{ textAlign: "center", padding: "28px" }}>
        <div style={{ marginBottom: "8px", color: "var(--mp-primary)" }}>
          <IconShield size={24} />
        </div>
        <div style={{ fontWeight: 700, fontSize: "15px" }}>
          Initializing TideCloak SDK…
        </div>
        <div style={{ fontSize: "12.5px", color: "var(--mp-text-muted)" }}>
          Verifying DPoP session state and embedded VVK JWK configuration.
        </div>
      </div>
    );
  }

  const authed = Boolean(authenticated || isAuthenticated);

  if (!authed) {
    return (
      <section className="mp-card" aria-labelledby="auth-guard-login-title">
        <div className="mp-card__header">
          <div>
            <h2 id="auth-guard-login-title" className="mp-card__title">
              Authentication Required — {resourceName}
            </h2>
            <p className="mp-card__subtitle">
              You must sign in with a TideCloak-issued token to access this page.
            </p>
          </div>
          <StatusBadge
            tone="danger"
            icon="lock"
            label="401 Unauthenticated"
          />
        </div>
        <div className="mp-card__body">
          <div
            className="mp-callout mp-callout--teal"
            style={{ marginBottom: "14px" }}
          >
            <IconShield size={18} />
            <div>
              <div className="mp-callout__title">
                Zero-Knowledge TideCloak Authentication
              </div>
              <div className="mp-callout__desc">
                Your password never reaches our servers. Authenticate via the Tide
                Secure Web Enclave or sign in from the MedPool Sign In page.
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
            <button
              type="button"
              className="mp-btn mp-btn-primary"
              onClick={() => {
                if (!isInitializing) login();
              }}
            >
              <IconShield size={15} />
              <span>Sign In with TideCloak</span>
            </button>
            <Link href="/login" className="mp-btn mp-btn-secondary">
              Open Sign In Page
            </Link>
            <Link href="/signup" className="mp-btn mp-btn-secondary">
              Create Account
            </Link>
          </div>
        </div>
      </section>
    );
  }

  // Determine user's effective role from Tide JWT claims (`hasRealmRole`) or active session role
  let resolvedRole: MedPoolRole = effectiveRole || "patient";
  if (authenticated && !effectiveRole) {
    if (hasRealmRole("ethics-board") || hasRealmRole("tide-realm-admin")) {
      resolvedRole = "ethics-board";
    } else if (hasRealmRole("researcher") || hasRealmRole("_tide_decryptor")) {
      resolvedRole = "researcher";
    } else if (hasRealmRole("doctor")) {
      resolvedRole = "doctor";
    } else if (hasRealmRole("admin") || hasRealmRole("sysadmin")) {
      resolvedRole = "sysadmin";
    } else if (hasRealmRole("patient")) {
      resolvedRole = "patient";
    } else {
      // Newly created Tide accounts hold only default-roles-medpool (`appUser`, `_tide_enabled`)
      resolvedRole = "pending";
    }
  }

  if (allowedRoles && allowedRoles.length > 0 && !allowedRoles.includes(resolvedRole)) {
    return (
      <section className="mp-card-danger" aria-labelledby="auth-guard-denied-title">
        <div className="mp-card__header">
          <div>
            <h2 id="auth-guard-denied-title" className="mp-card__title">
              No Access — Role Not Authorized for {resourceName}
            </h2>
            <p className="mp-card__subtitle">
              TideCloak RBAC check failed for your current role.
            </p>
          </div>
          <StatusBadge
            tone="danger"
            icon="ban"
            label="403 Forbidden (Wrong Role)"
          />
        </div>
        <div className="mp-card__body">
          <div
            className="mp-callout mp-callout--danger"
            style={{ marginBottom: "12px" }}
          >
            <IconBan size={18} />
            <div>
              <div className="mp-callout__title">
                Current Role: {resolvedRole.toUpperCase()} (
                {getRoleDisplayLabel(resolvedRole)})
              </div>
              <div className="mp-callout__desc">
                Accessing <strong>{resourceName}</strong> requires one of the
                following TideCloak realm roles:{" "}
                <code>{allowedRoles.join(", ")}</code>.{" "}
                {resolvedRole === "pending"
                  ? "New TideCloak accounts start with minimal, non-sensitive permissions (default-roles-medpool) until 2-of-3 Ethics Board members approve an elevated role."
                  : "Your current role does not hold decryption or governance authority for this route."}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <Link href="/profile" className="mp-btn mp-btn-primary mp-btn-sm">
              View My Role &amp; Profile
            </Link>
            <Link href="/login" className="mp-btn mp-btn-secondary mp-btn-sm">
              Switch Role / Account
            </Link>
          </div>
        </div>
      </section>
    );
  }

  return <>{children}</>;
}

