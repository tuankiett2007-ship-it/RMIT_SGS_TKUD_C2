"use client";

import React from "react";
import Link from "next/link";
import { REVOCATION_HONESTY_NOTE } from "@/lib/medpool/types";
import {
  IconShield,
  IconLock,
  IconUnlock,
  IconCheck,
  IconBan,
  StatusBadge,
} from "@/components/ui/DesignSystem";

export default function WhyThisWorksPage() {
  return (
    <div className="mp-shell">
      <header className="mp-header">
        <div className="mp-header-inner">
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <Link
              href="/"
              style={{
                width: "36px",
                height: "36px",
                borderRadius: "8px",
                backgroundColor: "var(--mp-primary)",
                color: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: 700,
                textDecoration: "none",
              }}
            >
              CP
            </Link>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ fontWeight: 700, fontSize: "16px" }}>
                  Care Passport · Why This Works
                </span>
                <StatusBadge
                  tone="primary"
                  icon="shield"
                  label="Zero Operator Override"
                />
              </div>
              <div style={{ fontSize: "12px", color: "var(--mp-text-secondary)" }}>
                Patient-Controlled Health Records · Per-Record, Per-Clinician Sharing
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <Link href="/" className="mp-btn mp-btn-primary mp-btn-sm">
              ← Back to Care Passport Console
            </Link>
            <Link href="/trust" className="mp-btn mp-btn-secondary mp-btn-sm">
              View Trust Map →
            </Link>
          </div>
        </div>
      </header>

      <main className="mp-main">
        {/* THE ONE POSSIBILITY HERO */}
        <section
          className="mp-card"
          style={{
            borderLeft: "4px solid var(--mp-primary)",
            background:
              "linear-gradient(135deg, var(--mp-primary-soft) 0%, var(--mp-surface) 68%)",
          }}
        >
          <div
            style={{
              fontSize: "11px",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "var(--mp-primary)",
              marginBottom: "6px",
            }}
          >
            The One Possibility (What Removing Unilateral Control Unlocks)
          </div>
          <h1
            style={{
              margin: "0 0 10px 0",
              fontSize: "22px",
              lineHeight: 1.3,
              fontWeight: 700,
            }}
          >
            &ldquo;A patient can share exactly one record with exactly one
            clinician, and no operator, admin or provider can read the rest or
            override that choice.&rdquo;
          </h1>
          <p
            style={{
              margin: 0,
              fontSize: "14px",
              color: "var(--mp-text-secondary)",
              maxWidth: "880px",
              lineHeight: 1.6,
            }}
          >
            When a patient visits both a General Practitioner (GP) and a
            Physiotherapist, the GP needs only the Specialist Referral while the
            Physiotherapist needs only the Rehabilitation Care Plan—and neither
            needs the patient&apos;s private Genomic Vault. In Care Passport,
            each record is encrypted in its own <code>TideMemory</code> v1
            envelope with a unique <code>assignmentId</code> and unlocked only
            when the patient signs an <code>owner</code>-mode{" "}
            <code>shared-with</code> attestation naming that exact clinician and
            record.
          </p>
        </section>

        {/* 3-PART EXPLANATION */}
        <div className="mp-grid-3">
          <section className="mp-card">
            <div style={{ marginBottom: "8px" }}>
              <StatusBadge
                tone="pending"
                icon="lock"
                label="1. The Care-Sharing Trade-Off"
              />
            </div>
            <h2 style={{ fontSize: "16px", margin: "0 0 8px 0" }}>
              Continuity of Care vs. Blanket Exposure
            </h2>
            <p
              style={{
                margin: 0,
                fontSize: "13px",
                color: "var(--mp-text-secondary)",
                lineHeight: 1.6,
              }}
            >
              Patients want their GP to read a cardiology referral and their
              physiotherapist to read a post-op rehab plan. Today, connecting to
              a shared health portal means uploading all records to a central
              provider where any clinician with chart access—or the platform
              operator—can read every file in the patient&apos;s history.
            </p>
          </section>

          <section className="mp-card">
            <div style={{ marginBottom: "8px" }}>
              <StatusBadge
                tone="danger"
                icon="ban"
                label="2. Why a Trusted Operator Is the Bottleneck"
              />
            </div>
            <h2 style={{ fontSize: "16px", margin: "0 0 8px 0" }}>
              The Operator Holds the Keys &amp; the ACL Table
            </h2>
            <p
              style={{
                margin: 0,
                fontSize: "13px",
                color: "var(--mp-text-secondary)",
                lineHeight: 1.6,
              }}
            >
              In conventional health apps, &ldquo;Patient shared Record A with
              Dr. Thorne&rdquo; is just an unsigned row in a database table, and
              encryption keys live in the operator&apos;s KMS. A rogue or
              compromised operator can read any record directly, insert a share
              row for themselves, or share a record on the patient&apos;s behalf
              without the patient&apos;s consent.
            </p>
          </section>

          <section className="mp-card">
            <div style={{ marginBottom: "8px" }}>
              <StatusBadge
                tone="success"
                icon="check"
                label="3. How Removing Unilateral Control Works"
              />
            </div>
            <h2 style={{ fontSize: "16px", margin: "0 0 8px 0" }}>
              Per-Record Envelopes + Owner-Signed Grants
            </h2>
            <p
              style={{
                margin: 0,
                fontSize: "13px",
                color: "var(--mp-text-secondary)",
                lineHeight: 1.6,
              }}
            >
              TideCloak removes the master key and splits authority across a
              decentralized ORK threshold network. Each record is tagged with
              its own <code>assignmentId</code> under{" "}
              <code>RelationshipAttestation:1</code>, and every share requires
              the patient&apos;s Ed25519 <code>owner</code>-mode{" "}
              <code>shared-with</code> signature naming the exact{" "}
              <code>(recordId, clinicianVuid)</code> pair—rebuilt from raw
              columns and verified on every request.
            </p>
          </section>
        </div>

        {/* SIDE-BY-SIDE VISUAL DIAGRAM: TRADITIONAL VS CARE PASSPORT */}
        <section className="mp-card">
          <div style={{ marginBottom: "14px" }}>
            <div
              style={{
                fontSize: "11px",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: "var(--mp-primary)",
              }}
            >
              Architectural Comparison Diagram
            </div>
            <h2 style={{ margin: "2px 0 0 0", fontSize: "18px" }}>
              Traditional Health Portal vs. Care Passport (TideCloak)
            </h2>
          </div>

          <div className="mp-grid-2">
            {/* LEFT: TRADITIONAL */}
            <div
              style={{
                padding: "16px",
                borderRadius: "var(--mp-radius-md)",
                backgroundColor: "var(--mp-danger-bg)",
                border: "1px solid var(--mp-danger-border)",
                display: "flex",
                flexDirection: "column",
                gap: "12px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <strong style={{ fontSize: "14px", color: "var(--mp-danger)" }}>
                  Traditional Health Portal (Trusted Operator Bottleneck)
                </strong>
                <StatusBadge
                  tone="danger"
                  icon="ban"
                  label="Operator Can Override"
                />
              </div>

              <div
                className="mp-mono"
                style={{
                  padding: "12px",
                  borderRadius: "var(--mp-radius-sm)",
                  backgroundColor: "var(--mp-surface)",
                  border: "1px solid var(--mp-danger-border)",
                  fontSize: "12px",
                  lineHeight: 1.75,
                }}
              >
                <div>[Patient&apos;s 3 Records: Referral, Care Plan, Genomic]</div>
                <div style={{ color: "var(--mp-danger)", fontWeight: 700 }}>
                  {"   │  (Plaintext / Server-Held KMS Master Key)"}
                </div>
                <div>{"   ▼"}</div>
                <div
                  style={{
                    padding: "6px 8px",
                    backgroundColor: "var(--mp-danger-bg)",
                    borderRadius: "4px",
                    fontWeight: 700,
                    color: "var(--mp-danger)",
                  }}
                >
                  {"[Platform Operator / Root Database Admin]"}
                </div>
                <div>{"   ├── ❌ Can read all 3 records using KMS master key"}</div>
                <div>{"   ├── ❌ Can insert a share row without patient signing"}</div>
                <div>{"   └── ❌ Blanket chart access exposes Care Plan to GP"}</div>
              </div>
            </div>

            {/* RIGHT: CARE PASSPORT */}
            <div
              style={{
                padding: "16px",
                borderRadius: "var(--mp-radius-md)",
                backgroundColor: "var(--mp-success-bg)",
                border: "1px solid var(--mp-success-border)",
                display: "flex",
                flexDirection: "column",
                gap: "12px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <strong style={{ fontSize: "14px", color: "var(--mp-success)" }}>
                  Care Passport with TideCloak (Per-Record, Per-Clinician)
                </strong>
                <StatusBadge
                  tone="success"
                  icon="shield"
                  label="Zero Operator Override"
                />
              </div>

              <div
                className="mp-mono"
                style={{
                  padding: "12px",
                  borderRadius: "var(--mp-radius-sm)",
                  backgroundColor: "var(--mp-surface)",
                  border: "1px solid var(--mp-success-border)",
                  fontSize: "12px",
                  lineHeight: 1.75,
                }}
              >
                <div>[3 Records Tagged Individually: CP-REC-001, 002, 003]</div>
                <div>{"   │"}</div>
                <div>
                  {"   ├─► "}
                  <strong style={{ color: "var(--mp-success)" }}>
                    [Share 1: Patient Owner Attests CP-REC-001 → GP]
                  </strong>
                </div>
                <div>{"   │     └─► GP opens ONLY Referral (Refused 002 & 003)"}</div>
                <div>
                  {"   ├─► "}
                  <strong style={{ color: "var(--mp-success)" }}>
                    [Share 2: Patient Owner Attests CP-REC-002 → Physio]
                  </strong>
                </div>
                <div>{"   │     └─► Physio opens ONLY Care Plan (Refused 001 & 003)"}</div>
                <div>
                  {"   └─► "}
                  <strong style={{ color: "var(--mp-danger)" }}>
                    [Rogue Operator: No Key + Issuer != Owner → BLOCKED 403]
                  </strong>
                </div>
              </div>
            </div>
          </div>

          <div
            style={{
              marginTop: "14px",
              padding: "10px 14px",
              borderRadius: "var(--mp-radius-sm)",
              backgroundColor: "var(--mp-bg-subtle)",
              border: "1px solid var(--mp-border)",
              fontSize: "12.5px",
              color: "var(--mp-text-secondary)",
            }}
          >
            <strong>Revocation Honesty Note:</strong> {REVOCATION_HONESTY_NOTE}
          </div>
        </section>
      </main>
    </div>
  );
}
