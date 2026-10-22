"use client";

import React from "react";
import type { MedPoolAccount } from "@/lib/medpool/types";
import { REVOCATION_HONESTY_NOTE } from "@/lib/medpool/types";
import {
  IconShield,
  IconCheck,
  IconClock,
  IconLock,
  IconBan,
  StatusBadge,
} from "@/components/ui/DesignSystem";

interface GuidedDemoPanelProps {
  open: boolean;
  onToggle: () => void;
  accounts: MedPoolAccount[];
  currentAccount: MedPoolAccount | null;
  onSwitchAccount: (acct: MedPoolAccount) => void;
  onResetDemo: () => void;
  busy: boolean;
  gpHasReferralGrant: boolean;
  physioHasCarePlanGrant: boolean;
  clinicianTestedBoth: boolean;
  rogueBlockedCount: number;
  physioRevoked: boolean;
  onJumpToSection?: (sectionId: string) => void;
}

export function GuidedDemoPanel({
  open,
  onToggle,
  accounts,
  currentAccount,
  onSwitchAccount,
  onResetDemo,
  busy,
  gpHasReferralGrant,
  physioHasCarePlanGrant,
  clinicianTestedBoth,
  rogueBlockedCount,
  physioRevoked,
  onJumpToSection,
}: GuidedDemoPanelProps) {
  const step1Done = true; // 3 encrypted records pre-seeded by metadata only
  const step2Done = gpHasReferralGrant && (physioHasCarePlanGrant || physioRevoked);
  const step3Done = clinicianTestedBoth;
  const step4Done = rogueBlockedCount > 0;
  const step5Done = physioRevoked;
  const step6Done = physioRevoked && rogueBlockedCount > 0;

  const activeStep = !step2Done
    ? 2
    : !step3Done
    ? 3
    : !step4Done
    ? 4
    : !step5Done
    ? 5
    : 6;

  // Primary 4 Care Passport demo roles: Patient, GP, Physiotherapist, Rogue Operator/Admin
  const carePassportAccounts = accounts.filter((a) =>
    ["acct-patient-1", "acct-gp-1", "acct-physio-1", "acct-rogue-1"].includes(
      a.id
    )
  );

  const steps = [
    {
      num: 1,
      title: "1. 3 Encrypted Records (Metadata Only)",
      desc: "Elena Rostova has 3 records encrypted in TideMemory v1 envelopes with unique per-record assignmentIds (Referral, Care Plan, Genomic Vault). Default shared with: Nobody.",
      done: step1Done,
      targetSection: "section-care-passport",
    },
    {
      num: 2,
      title: "2. Share Referral → GP & Care Plan → Physio",
      desc: "As Patient (Elena), sign an Ed25519 owner-mode 'shared-with' attestation + RelationshipAttestation:1 User policy for GP (CP-REC-001) and Physio (CP-REC-002).",
      done: step2Done,
      targetSection: "section-care-passport",
    },
    {
      num: 3,
      title: "3. Two Clinicians, Two Different Records",
      desc: "Switch to GP (Dr. Thorne) and Physio (Dr. Lin). GP decrypts ONLY the Referral (refused Care Plan); Physio decrypts ONLY the Care Plan (refused Referral).",
      done: step3Done,
      targetSection: "section-clinician-viewer",
    },
    {
      num: 4,
      title: "4. Rogue Operator Tries to Break It",
      desc: "Switch to Rogue Operator (Marcus Vance) and try to read a record, self-grant access, or share on the patient's behalf — all 3 are Blocked (HTTP 403).",
      done: step4Done,
      targetSection: "section-rogue-admin",
    },
    {
      num: 5,
      title: "5. Revoke Physio + 'Refresh Access'",
      desc: "Withdraw the Physio's access to CP-REC-002 and click 'Refresh Access'. Physio's next decryption is Refused (403), while GP still opens CP-REC-001.",
      done: step5Done,
      targetSection: "section-care-passport",
    },
    {
      num: 6,
      title: "6. Honesty Note & Patient Audit Trail",
      desc: "Verify the visible Revocation Honesty Note and filter the Patient-Facing Audit Trail by clinician (GP, Physio, Operator) and event type.",
      done: step6Done,
      targetSection: "section-audit-trail",
    },
  ];

  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        style={{
          position: "fixed",
          right: open ? "368px" : "16px",
          bottom: "20px",
          zIndex: 60,
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "10px 16px",
          borderRadius: "9999px",
          backgroundColor: "var(--mp-primary)",
          color: "#ffffff",
          border: "none",
          fontWeight: 700,
          fontSize: "13px",
          cursor: "pointer",
          boxShadow: "0 8px 24px rgba(15, 118, 110, 0.35)",
          transition: "right 0.22s ease",
        }}
      >
        <IconShield size={16} />
        <span>{open ? "Close Guided Demo" : "Guided Demo (Step " + activeStep + "/6)"}</span>
      </button>

      {open && (
        <aside
          aria-label="Guided 6-Step Care Passport Demo Panel"
          style={{
            position: "fixed",
            top: 0,
            right: 0,
            bottom: 0,
            width: "356px",
            maxWidth: "92vw",
            zIndex: 59,
            backgroundColor: "var(--mp-surface)",
            borderLeft: "1px solid var(--mp-border-strong)",
            boxShadow: "-8px 0 30px rgba(15, 23, 42, 0.14)",
            display: "flex",
            flexDirection: "column",
            overflowY: "auto",
          }}
        >
          <div
            style={{
              padding: "16px",
              borderBottom: "1px solid var(--mp-border)",
              backgroundColor: "var(--mp-bg-subtle)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "8px",
            }}
          >
            <div>
              <div
                style={{
                  fontSize: "11px",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  color: "var(--mp-primary)",
                }}
              >
                Care Passport · Guided Demo
              </div>
              <div style={{ fontWeight: 700, fontSize: "15px" }}>
                6-Step Per-Record Sharing Flow
              </div>
            </div>
            <div style={{ display: "flex", gap: "6px" }}>
              <button
                type="button"
                onClick={onResetDemo}
                disabled={busy}
                className="mp-btn mp-btn-danger mp-btn-sm"
                title="Reset all shares to Nobody and clear decrypted browser RAM"
              >
                Reset
              </button>
              <button
                type="button"
                onClick={onToggle}
                className="mp-btn mp-btn-secondary mp-btn-sm"
              >
                ✕
              </button>
            </div>
          </div>

          {/* 1-Click Role Switcher (Patient, GP, Physiotherapist, Rogue Operator) */}
          <div
            style={{
              padding: "12px 16px",
              borderBottom: "1px solid var(--mp-border)",
            }}
          >
            <div
              style={{
                fontSize: "11px",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                color: "var(--mp-text-muted)",
                marginBottom: "6px",
              }}
            >
              1-Click Role Switcher (Patient · GP · Physio · Admin)
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "6px",
              }}
            >
              {carePassportAccounts.map((acct) => {
                const isSelected = currentAccount?.id === acct.id;
                const shortLabel =
                  acct.id === "acct-patient-1"
                    ? "Patient (Elena)"
                    : acct.id === "acct-gp-1"
                    ? "GP (Dr. Thorne)"
                    : acct.id === "acct-physio-1"
                    ? "Physio (Dr. Lin)"
                    : "Rogue Admin";
                return (
                  <button
                    key={acct.id}
                    type="button"
                    disabled={busy}
                    onClick={() => onSwitchAccount(acct)}
                    style={{
                      textAlign: "left",
                      padding: "6px 8px",
                      borderRadius: "var(--mp-radius-sm)",
                      border: isSelected
                        ? "1.5px solid var(--mp-primary)"
                        : "1px solid var(--mp-border)",
                      backgroundColor: isSelected
                        ? "var(--mp-primary-soft)"
                        : "var(--mp-bg-subtle)",
                      cursor: "pointer",
                      fontSize: "11px",
                    }}
                  >
                    <div
                      style={{
                        fontWeight: 700,
                        color: isSelected
                          ? "var(--mp-primary-text)"
                          : "var(--mp-text)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {isSelected ? "● " : ""}
                      {shortLabel}
                    </div>
                    <div
                      className="mp-mono"
                      style={{
                        fontSize: "10px",
                        color: "var(--mp-text-muted)",
                      }}
                    >
                      {acct.clinicianSpecialty || acct.activeRole}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 6 Guided Steps */}
          <div
            style={{
              padding: "14px 16px",
              display: "flex",
              flexDirection: "column",
              gap: "10px",
              flex: 1,
            }}
          >
            {steps.map((s) => {
              const isCurrent = s.num === activeStep;
              return (
                <div
                  key={s.num}
                  onClick={() =>
                    onJumpToSection && onJumpToSection(s.targetSection)
                  }
                  style={{
                    padding: "11px 12px",
                    borderRadius: "var(--mp-radius-md)",
                    border: isCurrent
                      ? "2px solid var(--mp-primary)"
                      : s.done
                      ? "1px solid var(--mp-success-border)"
                      : "1px solid var(--mp-border)",
                    backgroundColor: isCurrent
                      ? "var(--mp-primary-soft)"
                      : s.done
                      ? "var(--mp-success-bg)"
                      : "var(--mp-bg-subtle)",
                    cursor: onJumpToSection ? "pointer" : "default",
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
                        fontWeight: 700,
                        fontSize: "12.5px",
                        color: isCurrent
                          ? "var(--mp-primary-text)"
                          : "var(--mp-text)",
                      }}
                    >
                      {s.title}
                    </span>
                    {s.done ? (
                      <StatusBadge tone="success" icon="check" label="Done" />
                    ) : isCurrent ? (
                      <StatusBadge
                        tone="primary"
                        icon="clock"
                        label="Current"
                      />
                    ) : (
                      <StatusBadge tone="neutral" icon="lock" label="Next" />
                    )}
                  </div>
                  <p
                    style={{
                      margin: 0,
                      fontSize: "11.5px",
                      color: "var(--mp-text-secondary)",
                      lineHeight: 1.45,
                    }}
                  >
                    {s.desc}
                  </p>
                </div>
              );
            })}

            <div
              style={{
                padding: "10px 12px",
                borderRadius: "var(--mp-radius-sm)",
                backgroundColor: "var(--mp-bg-subtle)",
                border: "1px solid var(--mp-border)",
                fontSize: "11px",
                color: "var(--mp-text-secondary)",
                lineHeight: 1.45,
              }}
            >
              <strong>Honesty Note:</strong> {REVOCATION_HONESTY_NOTE}
            </div>
          </div>
        </aside>
      )}
    </>
  );
}
