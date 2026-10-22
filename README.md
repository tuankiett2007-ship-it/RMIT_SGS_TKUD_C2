# 🛡️ Care Passport (MedPool) — Zero-Trust Patient-Controlled Health Records

> **Core Capability:**  
> *"A patient can share a specific medical record with a specific clinician, and no system operator, database administrator, or cloud provider can read the remaining records or unilaterally override that decision."*

Built with **TideCloak** (Zero-Knowledge Web Enclave, 14-of-20 ORK Threshold Encryption, RFC 9449 DPoP Token Binding) and **Next.js 16 (App Router)**.

---

## 🚀 Quick Start & Installation

### Prerequisites
- **Node.js**: v18.18+ or v20+
- **Browser**: Chrome, Edge, Brave, or Safari (requires WebCrypto API support and popup permissions for the Web Enclave)

### Running the Application

```bash
# 1. Install dependencies
npm install

# 2. Start the development server
npm run dev

# 3. Open the web application in your browser
# http://localhost:3000
```

> [!TIP]
> When authenticating with TideCloak or triggering the Web Enclave for the first time, please **Allow Popups** in your browser for `localhost:3000`.

To verify a production build:
```bash
npm run build
```

---

## 💻 How to Use the Web Application

### 1. Patient Dashboard (`Elena Rostova`)
- **View Encrypted Vault:** Inspect your 3 clinical records (`CP-REC-001`, `CP-REC-002`, `CP-REC-003`), each sealed inside an independent `TideMemory` v1 cryptographic envelope.
- **Grant Granular Access:** Click **Share with GP** or **Share with Physio** on any individual record. Your browser signs an Ed25519 `owner`-mode attestation via WebCrypto, generating a record-specific `RelationshipAttestation:1` policy without exposing your private key to the server.
- **Revoke Access:** Click **Revoke Access** on an active share grant and trigger **Refresh Access Session** to immediately invalidate future decryption attempts for that clinician.

### 2. Clinician Views (`Dr. Aris Thorne - GP` & `Dr. Maya Lin - Physio`)
- **Switch Active Role:** Use the role selector in the top navigation bar to switch between the General Practitioner (GP) and Physiotherapist views.
- **Decrypt in Browser RAM:** Click **Decrypt in Browser RAM** on a record shared with you. The ciphertext envelope is unsealed exclusively in client memory (`HTTP 200`).
- **Cryptographic Isolation:** Attempting to open any unshared record returns `HTTP 403 Forbidden` (`RECORD_NOT_SHARED_WITH_CLINICIAN`), proving that clinicians only have authority over explicitly granted records.

### 3. Rogue Operator Sandbox (`Marcus Vance`)
- Navigate to the **Rogue Operator Attack Sandbox** (`#section-rogue-admin`) or switch to the Operator role in the header.
- Test 4 simulated infrastructure-level attacks:
  1. **Read Record 001 Directly**: Blocked (`HTTP 403` — Operator holds no patient key and lacks `_tide_decryptor` authority).
  2. **Self-Grant Access**: Blocked (`HTTP 403` — Enforced four-eyes quorum prevents unilateral privilege escalation).
  3. **Forge Share on Patient's Behalf**: Blocked (`HTTP 403` — Only the patient's WebCrypto owner key can produce a valid `owner`-mode signature).
  4. **Lower Quorum Threshold (2 → 1)**: Blocked (`HTTP 403` — Governance rule mutations require multi-admin threshold approval).

### 4. Tamper-Evident Audit Trail & Additional Pages
- **Audit Log:** Scroll to the bottom of the main dashboard to monitor real-time cryptographic events (grants, RAM decryptions, revocations, and blocked operator attacks).
- **`/why`**: Explains why removing unilateral control unlocks cross-provider healthcare collaboration.
- **`/trust`**: Details the cryptographic trust boundaries and threat model.

---

## 🏛️ Security Architecture

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                             BROWSER BOUNDARY                                │
│                                                                             │
│  [ Elena Rostova (Patient) ]           [ Dr. Aris Thorne (GP) ]             │
│  - WebCrypto Ed25519 KeyPair           - DPoP Bound Key (RFC 9449)          │
│  - Signs 'owner'-mode Attestations     - TideMemory.doDecrypt() in RAM only │
│                                                                             │
│  [ Marcus Vance (Rogue Operator) ]     [ Dr. Maya Lin (Physio) ]            │
│  - No Patient Signing Key              - Separate DPoP Key                  │
│  - Lacks '_tide_decryptor' Authority   - Isolated RAM Workspace             │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ HTTPS (Strict Server Verification)
┌──────────────────────────────────────▼──────────────────────────────────────┐
│                           MEDPOOL NEXT.JS SERVER                            │
│                                                                             │
│  - Server-isolated database store (`import "server-only"`)                  │
│  - `verifyAttestation()` rebuilds statement bytes from raw DB columns       │
│  - Enforces subjectType="User", subjectId=doctorKey, assignmentId=recordId  │
│  - Zero plaintext stored: Only ciphertext envelopes exist on disk           │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Threshold Key Protocol
┌──────────────────────────────────────▼──────────────────────────────────────┐
│                    TIDECLOAK & ORK NETWORK (14-of-20)                       │
│                                                                             │
│  - Blinded Threshold Enclave Nodes (ork1..ork20.tideprotocol.com)           │
│  - No single master key exists anywhere in the system                       │
│  - Quorum-governed IGA (2-of-3 Ethics Board signatures required)            │
└─────────────────────────────────────────────────────────────────────────────┘
```

1. **`TideMemory` v1 Envelopes:**
   Each medical record is sealed with a distinct `assignmentId` (`CP-REC-001`, `CP-REC-002`, `CP-REC-003`). Decryption requires threshold collaboration across 14 of 20 decentralized ORK nodes.
2. **Ed25519 `owner`-Mode Attestations:**
   Only the patient can sign a sharing grant. The backend reconstructs the canonical `Policy.DataToVerify` byte payload from stored columns and runs `verifyAttestation` before serving any ciphertext envelope.
3. **RFC 9449 DPoP Token Binding:**
   Clinician access tokens are cryptographically bound to ephemeral WebCrypto key pairs inside the browser, preventing token theft or replay attacks.
4. **Revocation Boundary Note:**
   *Revoking access immediately blocks all future decryption requests once the active session refreshes or expires; cryptography cannot retroactively erase data that an authorized recipient has already viewed or copied while access was active.*

---

## 🔬 Automated Verification Suite

You can verify all security invariants and access matrix rules automatically via the included verification script while the development server is running on `http://localhost:3000`:

```bash
node scratch/verify_demo_flow.mjs
```

---

## 👥 Seeded Accounts

| Role | Display Name | Email | Default Decryption Scope |
|---|---|---|---|
| **Patient (Data Owner)** | Elena Rostova | `elena.rostova@patient.example` | Owns & manages grants for `CP-REC-001..003` |
| **General Practitioner (GP)** | Dr. Aris Thorne | `dr.thorne@melbourne-gp.au` | Unlocks `CP-REC-001` once granted by patient |
| **Physiotherapist** | Dr. Maya Lin | `maya.lin@rehab-physio.au` | Unlocks `CP-REC-002` once granted by patient |
| **Rogue Operator / Admin** | Marcus Vance | `operator-admin@carepassport.internal` | **0 records** (Blocked with `HTTP 403` on all actions) |
| **Ethics Board (IRB Chair)** | Dr. Hannah Vance | `h.vance@stjude-irb.org` | 1-of-3 IGA governance quorum signer |

---

## 📁 Project Structure

```text
medpool/
├── public/                        # Static assets & tide_dpop_auth.html (DPoP relay)
├── src/
│   ├── app/
│   │   ├── api/medpool/           # Server API routes (state, policies, auth)
│   │   ├── trust/                 # Cryptographic trust boundary breakdown
│   │   ├── why/                   # Zero-trust architectural rationale
│   │   ├── login/                 # Zero-Knowledge Login page
│   │   ├── signup/                # Account registration (zero passwords stored)
│   │   └── page.tsx               # Main Care Passport web dashboard
│   ├── components/                # UI components, GuidedDemoPanel, AuthGuard
│   └── lib/
│       ├── auth/                  # Tide JWT & RFC 9449 DPoP verifiers
│       ├── medpool/
│       │   ├── types.ts           # Isomorphic types & constants (client & server safe)
│       │   ├── store.ts           # Server-only persistence store
│       │   └── sandbox.ts         # In-browser RAM decryption boundary
│       └── tide/
│           ├── attestation.server.ts # Server-only attestation builder & verifier
│           ├── attestation.client.ts # Browser-safe codecs & WebCrypto signing
│           └── attestation.ts        # Tide core SDK helpers
├── scratch/
│   └── verify_demo_flow.mjs       # End-to-end automated security verification
└── README.md                      # Project documentation
```