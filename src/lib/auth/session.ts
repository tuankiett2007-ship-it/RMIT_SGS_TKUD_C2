"use client";

import type { MedPoolAccount, MedPoolRole } from "@/lib/medpool/types";

export const ACTIVE_ACCOUNT_STORAGE_KEY = "medpool.activeAccountId";
export const SESSION_EXPIRED_STORAGE_KEY = "medpool.sessionExpired";
export const PENDING_SIGNUP_STORAGE_KEY = "medpool.pendingSignup";

export function getStoredAccountId(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(ACTIVE_ACCOUNT_STORAGE_KEY);
}

export function setStoredAccountId(accountId: string | null): void {
  if (typeof window === "undefined") return;
  if (accountId) {
    window.localStorage.setItem(ACTIVE_ACCOUNT_STORAGE_KEY, accountId);
    window.localStorage.removeItem(SESSION_EXPIRED_STORAGE_KEY);
  } else {
    window.localStorage.removeItem(ACTIVE_ACCOUNT_STORAGE_KEY);
  }
}

export function isSessionMarkedExpired(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(SESSION_EXPIRED_STORAGE_KEY) === "1";
}

export function setSessionExpiredFlag(expired: boolean): void {
  if (typeof window === "undefined") return;
  if (expired) {
    window.localStorage.setItem(SESSION_EXPIRED_STORAGE_KEY, "1");
  } else {
    window.localStorage.removeItem(SESSION_EXPIRED_STORAGE_KEY);
  }
}

export function getDefaultTabForRole(
  role: MedPoolRole
): "search" | "board" | "sandbox" | "rogue" | "audit" {
  switch (role) {
    case "patient":
      return "board";
    case "ethics-board":
      return "board";
    case "researcher":
      return "search";
    case "doctor":
      return "search";
    case "sysadmin":
      return "rogue";
    case "pending":
      return "board";
    default:
      return "search";
  }
}

export function getRoleDisplayLabel(role: MedPoolRole): string {
  switch (role) {
    case "patient":
      return "Patient (Self-Sovereign Consent)";
    case "doctor":
      return "Attending Clinician (Metadata Only)";
    case "researcher":
      return "Principal Investigator (Researcher)";
    case "ethics-board":
      return "Ethics Board Member (IGA Approver)";
    case "sysadmin":
      return "Root DB / Infra Admin (No Master Key)";
    case "pending":
      return "Minimal Access (Elevated Role Pending Quorum)";
  }
}

export function canRoleAccessTab(
  role: MedPoolRole,
  tab: "search" | "board" | "sandbox" | "rogue" | "audit"
): { allowed: boolean; reason?: string } {
  if (tab === "search" || tab === "audit" || tab === "board") {
    return { allowed: true };
  }
  if (tab === "sandbox") {
    if (role === "researcher" || role === "ethics-board") {
      return { allowed: true };
    }
    if (role === "pending") {
      return {
        allowed: false,
        reason:
          "Your elevated Researcher role request is currently PENDING 2-of-3 Ethics Board quorum approval. New accounts start with minimal, non-sensitive permissions only.",
      };
    }
    return {
      allowed: false,
      reason: `Active role '${getRoleDisplayLabel(
        role
      )}' does not have Clinical Decryption Sandbox privileges. Only approved Researchers with a DPoP-bound '/studies/study-42' token can unlock records in browser memory.`,
    };
  }
  if (tab === "rogue") {
    if (
      role === "sysadmin" ||
      role === "ethics-board" ||
      role === "researcher"
    ) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `Active role '${getRoleDisplayLabel(
        role
      )}' cannot access the Infrastructure & Root Database Console.`,
    };
  }
  return { allowed: true };
}

export function resolveActiveAccount(
  accounts: MedPoolAccount[],
  storedAccountId: string | null,
  liveVuid?: string
): MedPoolAccount | null {
  if (liveVuid) {
    const byVuid = accounts.find((a) => a.vuid === liveVuid);
    if (byVuid) return byVuid;
  }
  if (storedAccountId) {
    const byId = accounts.find((a) => a.id === storedAccountId);
    if (byId) return byId;
  }
  return null;
}

