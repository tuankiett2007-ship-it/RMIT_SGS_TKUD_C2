"use client";

import React from "react";
import Link from "next/link";
import { REVOCATION_HONESTY_NOTE } from "@/lib/medpool/types";
import {
  IconShield,
  IconCheck,
  IconClock,
  IconLock,
  StatusBadge,
} from "@/components/ui/DesignSystem";

export default function TrustMapPage() {
  const rows = [
    {
      domain: "1. Zero-Knowledge Identity & DPoP Binding",
      tidecloak:
        "PRISM passwordless registration/login in the Secure Web Enclave; EdDSA (Ed25519) JWTs bound to the browser's non-exportable ES256 DPoP key (IAMService.secureFetch + verifyDpop).",
      workflow:
        "ProfileOnboarding modal collects display name & email after initial Tide sign-in (since new Tide identities emit only a vuid) and links clinician accounts.",
      stillTrusted:
        "Browser WebCrypto environment where the active user session runs.",
    },
    {
      domain: "2. Per-Record Encrypted Envelopes (RelationshipAttestation:1)",
      tidecloak:
        "Built-in ORK contract RelationshipAttestation:1 enforces that each item carries a single tag equal to assignmentId (CP-REC-001, CP-REC-002, CP-REC-003), caller holds _tide_decryptor, and caller's tideuserkey matches subjectId.",
      workflow:
        "Metadata listing (GET /api/medpool/state) strips ciphertext and exposes only non-sensitive metadata (recordId, recordType, title, hospitalOrigin, admissionDate).",
      stillTrusted:
        "Initial record ingestion in the patient's browser before encryption into TideMemory v1 envelopes.",
    },
    {
      domain: "3. Patient-Controlled Per-Record, Per-Clinician Sharing",
      tidecloak:
        "Owner-mode attestation signing rule (--claims shared-with --mode owner) checks Issuer == Owner == signer.vuid, preventing any operator or admin from forging a patient's share signature.",
      workflow:
        "Server builds unsigned Policy.DataToVerify bytes (PREPARE_SHARE_GRANT) and on every read/decrypt (DECRYPT_SHARED_RECORD) rebuilds the bytes from raw columns (patientVuid, clinicianVuid, recordId, expiry) and runs verifyAttestation() (AP-AT01..AP-AT04).",
      stillTrusted:
        "In RelationshipAttestation:1, User policies are realm-admin signed in production ORK setups; per-request clinician ACL pairing is enforced by the server's verifyAttestation() check over the patient's Ed25519 signature.",
    },
    {
      domain: "4. Two Clinicians, Two Different Records (Isolation)",
      tidecloak:
        "Each User policy and owner attestation names one exact clinician (vuid / tideuserkey) and one exact recordId (assignmentId). A policy for CP-REC-001 refuses tags for CP-REC-002 or CP-REC-003.",
      workflow:
        "DECRYPT_SHARED_RECORD checks the caller's verified identity against the active grant for that exact recordId, refusing the GP on the Care Plan (403) and refusing the Physio on the Referral (403).",
      stillTrusted:
        "Clinician's local browser display once an authorized record is decrypted in RAM.",
    },
    {
      domain: "5. Per-Clinician Revocation & Session Refresh Timing",
      tidecloak:
        "IAMService.updateIamToken() refreshes the session token; short-lived policy/attestation expiry bounds the cryptographic validity window.",
      workflow:
        "REVOKE_RECORD_SHARE wipes the stored signature and User policy for the revoked clinician (e.g. Physio on CP-REC-002) while leaving the GP's grant on CP-REC-001 active, and offers an explicit 'Refresh Access' action.",
      stillTrusted:
        REVOCATION_HONESTY_NOTE +
        " Also, because the ORK network does not maintain a live CRL for unexpired signatures, immediate pre-expiry revocation relies on the server deleting the stored signature/policy.",
    },
    {
      domain: "6. Rogue Operator Resistance & Patient Audit Trail",
      tidecloak:
        "Operator holds no master decryption key, lacks _tide_decryptor, and cannot satisfy Owner == Issuer == patient.vuid or bypass Cryptographic IGA quorum (HTTP 202 / 412).",
      workflow:
        "Rogue Operator panel tests reading a record, self-granting access, and sharing on the patient's behalf—logging every blocked attempt and clinician event in the filterable Patient Audit Trail.",
      stillTrusted:
        "Append-only integrity of the local JSON audit store (production deployments should anchor audit digests to an immutable ledger).",
    },
  ];

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
                  Care Passport · Trust Map (Architectural Honesty)
                </span>
                <StatusBadge
                  tone="primary"
                  icon="shield"
                  label="Zero Fake Security"
                />
              </div>
              <div style={{ fontSize: "12px", color: "var(--mp-text-secondary)" }}>
                Exact Boundary Between TideCloak Cryptography, Server Workflow Logic &amp; Residual App Trust
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <Link href="/" className="mp-btn mp-btn-primary mp-btn-sm">
              ← Back to Care Passport Console
            </Link>
            <Link href="/why" className="mp-btn mp-btn-secondary mp-btn-sm">
              Why This Works →
            </Link>
          </div>
        </div>
      </header>

      <main className="mp-main">
        {/* Prominent Honesty Callout (Step 3.4) */}
        <section
          className="mp-card"
          style={{
            borderLeft: "4px solid var(--mp-warning)",
            backgroundColor: "var(--mp-warning-bg)",
          }}
        >
          <div
            style={{
              fontSize: "11px",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "var(--mp-warning)",
              marginBottom: "4px",
            }}
          >
            Cryptographic Honesty &amp; Revocation Boundary
          </div>
          <div style={{ fontWeight: 700, fontSize: "15px", marginBottom: "4px" }}>
            &ldquo;{REVOCATION_HONESTY_NOTE}&rdquo;
          </div>
          <p
            style={{
              margin: 0,
              fontSize: "13px",
              color: "var(--mp-text-secondary)",
              lineHeight: 1.55,
            }}
          >
            Every security guarantee in Care Passport is labeled honestly below:
            what is enforced mathematically by TideCloak&apos;s ORK threshold
            network, what is enforced on every request by our server workflow
            logic (<code>verifyAttestation</code> byte reconstruction +{" "}
            <code>RelationshipAttestation:1</code> checks), and what still
            requires trust in the client browser or server storage.
          </p>
        </section>

        <section className="mp-card">
          <div style={{ marginBottom: "16px" }}>
            <h1 style={{ margin: "0 0 6px 0", fontSize: "20px" }}>
              Trust Map: Provided by TideCloak vs. My Workflow Logic vs. Residual App Trust
            </h1>
          </div>

          <div className="mp-table-wrap">
            <table className="mp-table">
              <thead>
                <tr>
                  <th style={{ width: "18%" }}>Security Domain</th>
                  <th style={{ width: "28%" }}>
                    <StatusBadge
                      tone="success"
                      icon="check"
                      label="Provided by TideCloak"
                    />
                  </th>
                  <th style={{ width: "28%" }}>
                    <StatusBadge
                      tone="primary"
                      icon="shield"
                      label="My Workflow Logic (Server)"
                    />
                  </th>
                  <th style={{ width: "26%" }}>
                    <StatusBadge
                      tone="pending"
                      icon="clock"
                      label="Still Requires Trust in the App"
                    />
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.domain}>
                    <td style={{ fontWeight: 700, verticalAlign: "top" }}>
                      {r.domain}
                    </td>
                    <td
                      style={{
                        verticalAlign: "top",
                        color: "var(--mp-text-secondary)",
                        lineHeight: 1.55,
                      }}
                    >
                      {r.tidecloak}
                    </td>
                    <td
                      style={{
                        verticalAlign: "top",
                        color: "var(--mp-text-secondary)",
                        lineHeight: 1.55,
                      }}
                    >
                      {r.workflow}
                    </td>
                    <td
                      style={{
                        verticalAlign: "top",
                        color: "var(--mp-text-secondary)",
                        lineHeight: 1.55,
                      }}
                    >
                      {r.stillTrusted}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
