"use client";

import React from "react";

/* ============================================================================
   Accessible Inline SVG Icons (Always paired with visible text labels)
   ============================================================================ */

type IconProps = {
  size?: number;
  width?: number;
  height?: number;
  style?: React.CSSProperties;
};

export function IconLock({ size = 14, width, height, style }: IconProps) {
  return (
    <svg
      width={width ?? size}
      height={height ?? size}
      style={style}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

export function IconUnlock({ size = 14, width, height, style }: IconProps) {
  return (
    <svg
      width={width ?? size}
      height={height ?? size}
      style={style}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 9.9-1" />
    </svg>
  );
}

export function IconShield({ size = 15, width, height, style }: IconProps) {
  return (
    <svg
      width={width ?? size}
      height={height ?? size}
      style={style}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.1"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

export function IconCheck({ size = 14, width, height, style }: IconProps) {
  return (
    <svg
      width={width ?? size}
      height={height ?? size}
      style={style}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function IconClock({ size = 14, width, height, style }: IconProps) {
  return (
    <svg
      width={width ?? size}
      height={height ?? size}
      style={style}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

export function IconBan({ size = 14, width, height, style }: IconProps) {
  return (
    <svg
      width={width ?? size}
      height={height ?? size}
      style={style}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
    </svg>
  );
}

export function IconSearch({ size = 14, width, height, style }: IconProps) {
  return (
    <svg
      width={width ?? size}
      height={height ?? size}
      style={style}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

/* ============================================================================
   Semantic Status Badge (Icon + Text, Never Color Alone)
   ============================================================================ */

export type BadgeTone =
  | "success"
  | "pending"
  | "warning"
  | "danger"
  | "primary"
  | "info"
  | "neutral";

export function StatusBadge({
  tone,
  variant,
  icon,
  label,
  children,
  title,
}: {
  tone?: BadgeTone;
  variant?: BadgeTone;
  icon?:
    | "lock"
    | "unlock"
    | "check"
    | "clock"
    | "ban"
    | "shield"
    | React.ReactNode;
  label?: string;
  children?: React.ReactNode;
  title?: string;
}) {
  const effectiveTone = tone ?? variant ?? "neutral";
  const toneClass = {
    success: "mp-badge mp-badge-success",
    pending: "mp-badge mp-badge-pending",
    warning: "mp-badge mp-badge-pending",
    danger: "mp-badge mp-badge-danger",
    primary: "mp-badge mp-badge-primary",
    info: "mp-badge mp-badge-primary",
    neutral: "mp-badge mp-badge-neutral",
  }[effectiveTone];

  return (
    <span className={toneClass} title={title}>
      {icon === "lock" && <IconLock size={12} />}
      {icon === "unlock" && <IconUnlock size={12} />}
      {icon === "check" && <IconCheck size={12} />}
      {icon === "clock" && <IconClock size={12} />}
      {icon === "ban" && <IconBan size={12} />}
      {icon === "shield" && <IconShield size={12} />}
      {typeof icon !== "string" && icon}
      <span>{label ?? children}</span>
    </span>
  );
}

/* ============================================================================
   Global Status Strip / Stepper
   ============================================================================ */

export function GlobalFlowStepper({
  consentGranted,
  grantedCount,
  totalRecords,
  quorumCommitted,
  approvalsCount,
  threshold,
  tokenBound,
  sandboxUnlocked,
}: {
  consentGranted: boolean;
  grantedCount: number;
  totalRecords: number;
  quorumCommitted: boolean;
  approvalsCount: number;
  threshold: number;
  tokenBound: boolean;
  sandboxUnlocked: boolean;
}) {
  const steps = [
    {
      stepNumber: "1",
      title: "Metadata Search",
      subtitle: `${totalRecords} records indexed (payloads encrypted)`,
      status: "READY" as const,
      detail: "Searchable by condition, age, hospital & date",
    },
    {
      stepNumber: "2",
      title: "Patient Consent",
      subtitle: consentGranted
        ? `Granted (${grantedCount}/${totalRecords} records)`
        : "Awaiting patient signature",
      status: consentGranted ? ("DONE" as const) : ("PENDING" as const),
      detail: "Ed25519 self-attestation (record + study bound)",
    },
    {
      stepNumber: "3",
      title: "Ethics Quorum (2 of 3)",
      subtitle: quorumCommitted
        ? `Committed (${approvalsCount}/${threshold} approvals)`
        : `${approvalsCount}/${threshold} required approvals`,
      status: quorumCommitted ? ("DONE" as const) : ("PENDING" as const),
      detail: "TideCloak Cryptographic IGA (floor(3×0.7)=2)",
    },
    {
      stepNumber: "4",
      title: "Browser Sandbox Unlock",
      subtitle: sandboxUnlocked
        ? "Unlocked in browser memory"
        : tokenBound && consentGranted && quorumCommitted
        ? "Ready to decrypt in browser"
        : "Locked until steps 2 & 3 complete",
      status: sandboxUnlocked
        ? ("DONE" as const)
        : consentGranted && quorumCommitted
        ? ("READY" as const)
        : ("LOCKED" as const),
      detail: "RelationshipAttestation:1 + DPoP bound token",
    },
  ];

  return (
    <section
      aria-label="Study Access & Unlock Progress"
      className="mp-card"
      style={{ padding: "14px 18px" }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "8px",
          marginBottom: "12px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span
            style={{
              fontSize: "11.5px",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              color: "var(--mp-text-secondary)",
            }}
          >
            Emergent Authority Flow Status
          </span>
          <span
            style={{
              fontSize: "12px",
              color: "var(--mp-text-muted)",
            }}
          >
            — All three cryptographic locks must align before clinical payloads can be decrypted in the browser
          </span>
        </div>

        {consentGranted && quorumCommitted ? (
          <StatusBadge
            tone="success"
            icon="unlock"
            label={`All 3 Locks Aligned — ${grantedCount}/${totalRecords} Records Unlockable in Browser`}
          />
        ) : (
          <StatusBadge
            tone="pending"
            icon="lock"
            label="Payloads Locked — Complete Patient Consent & 2/3 Ethics Quorum to Unlock"
          />
        )}
      </div>

      <div className="mp-grid-4">
        {steps.map((s) => {
          const isDone = s.status === "DONE";
          const isReady = s.status === "READY";
          return (
            <div
              key={s.stepNumber}
              style={{
                padding: "11px 13px",
                borderRadius: "var(--mp-radius-md)",
                border: isDone
                  ? "1px solid var(--mp-success-border)"
                  : isReady
                  ? "1px solid var(--mp-primary-border)"
                  : "1px solid var(--mp-border)",
                backgroundColor: isDone
                  ? "var(--mp-success-bg)"
                  : isReady
                  ? "var(--mp-primary-soft)"
                  : "var(--mp-bg-subtle)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "6px",
                  marginBottom: "4px",
                }}
              >
                <span
                  style={{
                    fontSize: "12.5px",
                    fontWeight: 700,
                    color: "var(--mp-text)",
                  }}
                >
                  Step {s.stepNumber} · {s.title}
                </span>
                {isDone ? (
                  <IconCheck size={14} />
                ) : s.status === "LOCKED" ? (
                  <IconLock size={13} />
                ) : (
                  <IconClock size={13} />
                )}
              </div>
              <div
                style={{
                  fontSize: "12px",
                  fontWeight: 600,
                  color: isDone
                    ? "var(--mp-success)"
                    : isReady
                    ? "var(--mp-primary-text)"
                    : "var(--mp-text-secondary)",
                }}
              >
                {s.subtitle}
              </div>
              <div
                style={{
                  fontSize: "11px",
                  color: "var(--mp-text-muted)",
                  marginTop: "2px",
                }}
              >
                {s.detail}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ============================================================================
   Revocation Confirmation Modal (Screen 7)
   ============================================================================ */

export function ConfirmRevokeModal({
  open,
  targetType,
  onCancel,
  onConfirm,
  busy,
}: {
  open: boolean;
  targetType: "PATIENT_CONSENT" | "ETHICS_APPROVAL" | "ALL" | null;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  if (!open || !targetType) return null;

  const title =
    targetType === "PATIENT_CONSENT"
      ? "Revoke Patient Consent Attestation?"
      : targetType === "ETHICS_APPROVAL"
      ? "Withdraw Ethics Board Approval (Drop Quorum to 1/3)?"
      : "Revoke All Study Access & Consent?";

  const description =
    targetType === "PATIENT_CONSENT"
      ? "This marks the patient's self-attestation as REVOKED. Any decrypted data currently in the researcher's browser sandbox will be immediately purged from memory, and future unlock requests will be denied (HTTP 403)."
      : targetType === "ETHICS_APPROVAL"
      ? "Withdrawing one Ethics Board approval drops the active signature count from 2/3 down to 1/3 (below the required 2-of-3 quorum). The researcher is removed from '/studies/study-42' and browser sandbox access stops immediately."
      : "This revokes both patient consent and the 2-of-3 Ethics Board group membership, immediately terminating all access to '/studies/study-42' and recording the revocation in the Audit Trail.";

  return (
    <div
      className="mp-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="revoke-modal-title"
    >
      <div className="mp-modal">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            marginBottom: "10px",
          }}
        >
          <StatusBadge tone="danger" icon="ban" label="Immediate Revocation" />
          <h3
            id="revoke-modal-title"
            style={{ margin: 0, fontSize: "16px", fontWeight: 700 }}
          >
            {title}
          </h3>
        </div>

        <p
          style={{
            fontSize: "13.5px",
            color: "var(--mp-text-secondary)",
            lineHeight: 1.55,
            marginBottom: "18px",
          }}
        >
          {description}
        </p>

        <div
          style={{
            padding: "10px 12px",
            borderRadius: "var(--mp-radius-sm)",
            backgroundColor: "var(--mp-bg-subtle)",
            border: "1px solid var(--mp-border)",
            fontSize: "12px",
            color: "var(--mp-text-secondary)",
            marginBottom: "18px",
          }}
        >
          <strong>Audit Trail Guarantee:</strong> This revocation event will be
          permanently logged with timestamp and actor attribution visible to all
          parties.
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "10px",
          }}
        >
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="mp-btn mp-btn-secondary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="mp-btn mp-btn-danger"
          >
            {busy ? "Revoking Access..." : "Confirm & Terminate Access"}
          </button>
        </div>
      </div>
    </div>
  );
}

