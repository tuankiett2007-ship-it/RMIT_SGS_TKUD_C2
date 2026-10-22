/**
 * SERVER-ONLY persistence for the Care Passport / MedPool prototype.
 *
 * Uses Node `fs` to read/write `data/medpool-db.json`. The `server-only` import below makes the
 * build FAIL if any client component imports this module (directly or transitively), instead
 * of failing later with "Module not found: Can't resolve 'fs'".
 *
 * Client components must import shared types/constants from `@/lib/medpool/types` and reach
 * this data only through the API route handlers in `src/app/api/medpool/*`.
 */
import "server-only";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { container, toBase64 } from "@/lib/tide/attestation.server";
import {
  STUDY_GROUP_ID,
  REVOCATION_HONESTY_NOTE,
  type ClinicalPayloadPlaintext,
  type PatientRecord,
  type ClinicianShareGrant,
  type ConsentAttestationRow,
  type IgaChangeRequest,
  type StoredRelationshipPolicy,
  type MedPoolRole,
  type RequestedRoleType,
  type MedPoolAccount,
  type RoleApprovalRequest,
  type AuditLogEntry,
  type MedPoolDatabase,
} from "./types";

// Re-export the shared types/constants so existing server imports of "@/lib/medpool/store" keep working.
export * from "./types";

const DATA_DIR = join(process.cwd(), "data");
mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = join(DATA_DIR, "medpool-db.json");

const utf8 = (s: string) => new TextEncoder().encode(s);

/**
 * Encodes a synthetic clinical payload into a valid TideMemory v1 binary envelope
 * tagged with the single `assignmentId` (`record.recordId`) per RelationshipAttestation:1 (AP-RA03).
 */
export function packTideMemoryEnvelope(
  payload: ClinicalPayloadPlaintext,
  tag: string
): string {
  const header = utf8("TIDE_MEMORY_V1::AES256GCM_ELGAMAL_CVK");
  const tagBytes = utf8(tag);
  const bodyBytes = utf8(JSON.stringify(payload));
  const masked = new Uint8Array(bodyBytes.length);
  for (let i = 0; i < bodyBytes.length; i++) {
    masked[i] = bodyBytes[i] ^ ((i * 73 + 0x5a) & 0xff);
  }
  const envelope = container([header, tagBytes, masked]);
  return toBase64(envelope);
}

/**
 * Builds a deterministic base64 representation of a RelationshipAttestation:1 policy
 * binding ONE clinician (`subjectType="User"`, `subjectId=clinicianUserKey`) to ONE record (`assignmentId=recordId`).
 */
export function buildUserRecordPolicyB64(
  liveKeyId: string,
  clinicianUserKey: string,
  recordId: string
): string {
  return toBase64(
    container([
      utf8("3"),
      utf8("RelationshipAttestation:1"),
      container([
        utf8("PolicyEnabledEncryption:1"),
        utf8("PolicyEnabledDecryption:1"),
      ]),
      utf8(liveKeyId),
      utf8("IMPLICIT"),
      utf8("PRIVATE"),
      utf8(
        `subjectType=User;subjectId=${clinicianUserKey};assignmentId=${recordId};roles=["_tide_decryptor"]`
      ),
    ])
  );
}

export const SYNTHETIC_CLINICAL_PAYLOADS: Record<
  string,
  ClinicalPayloadPlaintext
> = {
  "CP-REC-001": {
    patientCode: "CP-REC-001 (Elena Rostova)",
    documentTitle: "Specialist Cardiology Referral — Post-Thoracic Consult",
    authoringClinician: "Dr. Evelyn Sato, MD (St. Jude Metro Cardiology)",
    clinicalNotes:
      "REFERRAL TO GENERAL PRACTITIONER (Dr. Aris Thorne): 58yo patient (Elena Rostova) referred for ongoing primary-care blood pressure & beta-blocker titration following Stage IIA thoracic intervention. Echocardiogram demonstrates LVEF 54% with mild subclinical hs-Troponin-T elevation (28.4 ng/L). Recommend GP blood pressure check every 2 weeks and continuation of Carvedilol 12.5mg BID.",
    biomarkers: {
      lvefPercent: 54,
      troponinNgL: 28.4,
      ntProBnpPgMl: 340,
      genomicMarker: "EGFR Exon 19 / Normal Conduction",
      adverseGrade: 1,
    },
    medications: [
      "Carvedilol 12.5mg BID",
      "Lisinopril 10mg QD",
      "Atorvastatin 20mg Nocte",
    ],
    physicianSummary:
      "GP Referral Summary: Stable ventricular function (LVEF 54%); GP to monitor outpatient BP (<130/80 mmHg) and renal electrolytes.",
  },
  "CP-REC-002": {
    patientCode: "CP-REC-002 (Elena Rostova)",
    documentTitle: "Post-Thoracic Rehabilitation & Mobility Care Plan",
    authoringClinician: "Allied Health Thoracic Rehab Team (Royal Melbourne)",
    clinicalNotes:
      "PHYSIOTHERAPY CARE PLAN (For Physiotherapist Dr. Maya Lin): 12-week graded cardiopulmonary & thoracic wall rehabilitation protocol for Elena Rostova. Target heart rate zone 95–118 bpm (RPE 11–13). Includes diaphragmatic breathing retraining, scapular range-of-motion mobilization, and 20-minute stationary cycle intervals 3x/week. Avoid Valsalva and heavy upper-limb isometric loading >8 kg.",
    biomarkers: {
      lvefPercent: 54,
      troponinNgL: 19.2,
      ntProBnpPgMl: 290,
      genomicMarker: "6MWT Baseline: 445m / SpO2 97%",
      adverseGrade: 1,
    },
    medications: [
      "Salbutamol 100mcg PRN prior to rehab session",
      "Guided inspiratory spirometry 3x daily",
    ],
    physicianSummary:
      "Physiotherapy Care Plan: Cleared for Phase II outpatient aerobic & thoracic mobility rehabilitation under physiotherapist supervision.",
  },
  "CP-REC-003": {
    patientCode: "CP-REC-003 (Elena Rostova)",
    documentTitle: "Comprehensive Genomic Profiling & Oncology Pathology Vault",
    authoringClinician: "Molecular Tumor Board (Charité Berlin / St. Jude)",
    clinicalNotes:
      "PRIVATE GENOMIC & ONCOLOGY VAULT RECORD (Unshared by Default): Whole-exome sequencing and germline pharmacogenomics panel for Elena Rostova. Germline BRCA1/2 negative; somatic EGFR L858R detected (VAF 38.2%); CYP2D6 normal metabolizer. Contains sensitive family hereditary cancer pedigree notes that the patient keeps strictly private unless consulting an oncologist.",
    biomarkers: {
      lvefPercent: 56,
      troponinNgL: 14.0,
      ntProBnpPgMl: 210,
      genomicMarker: "Somatic EGFR L858R / Germline BRCA WT",
      adverseGrade: 1,
    },
    medications: [
      "Osimertinib 80mg QD (Targeted Maintenance)",
      "Cholecalciferol 1000 IU QD",
    ],
    physicianSummary:
      "Confidential Genomic & Hereditary Oncology Summary: Locked by default; neither GP nor Physiotherapist requires access.",
  },
};

export function createDefaultDemoAccounts(nowIso: string): MedPoolAccount[] {
  return [
    {
      id: "acct-patient-1",
      name: "Elena Rostova (Patient Owner)",
      email: "elena.rostova@patient.example",
      vuid: "vuid_9f81a2c4e7b031d590a12b4c8e7f6d5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e",
      tideUserKey: "tideuserkey_ed25519_patient_elena_rostova_00",
      dpopThumbprint: "jkt_es256_patient_elena_swe_bound",
      activeRole: "patient",
      requestedRole: "patient",
      roleRequestStatus: "APPROVED",
      realmRoles: ["_tide_enabled", "patient", "_tide_encryptor", "_tide_decryptor"],
      linkedRecordId: "CP-REC-001",
      hospital: "Patient — Care Passport Holder",
      createdAt: nowIso,
      authMethod: "SEEDED_DEMO_ACCOUNT",
    },
    {
      id: "acct-gp-1",
      name: "Dr. Aris Thorne (GP)",
      email: "dr.thorne@melbourne-gp.au",
      vuid: "vuid_4d21b8e7c9a0f1d2e3c4b5a6978869504132231405968778695a4b3c2d1e0f12",
      tideUserKey: "tideuserkey_ed25519_gp_aris_thorne_01",
      dpopThumbprint: "jkt_es256_gp_thorne_swe_bound",
      activeRole: "doctor",
      clinicianSpecialty: "General Practitioner (GP)",
      requestedRole: "doctor",
      roleRequestStatus: "APPROVED",
      realmRoles: ["_tide_enabled", "doctor", "_tide_decryptor"],
      hospital: "Melbourne Family Practice (GP Clinic)",
      createdAt: nowIso,
      authMethod: "SEEDED_DEMO_ACCOUNT",
    },
    {
      id: "acct-physio-1",
      name: "Dr. Maya Lin (Physiotherapist)",
      email: "maya.lin@rehab-physio.au",
      vuid: "vuid_77c4e9a1b2d3f4e5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e899",
      tideUserKey: "tideuserkey_ed25519_physio_maya_lin_02",
      dpopThumbprint: "jkt_es256_physio_maya_swe_bound",
      activeRole: "doctor",
      clinicianSpecialty: "Physiotherapist",
      requestedRole: "doctor",
      roleRequestStatus: "APPROVED",
      realmRoles: ["_tide_enabled", "doctor", "_tide_decryptor"],
      hospital: "Royal Melbourne Allied Physiotherapy",
      createdAt: nowIso,
      authMethod: "SEEDED_DEMO_ACCOUNT",
    },
    {
      id: "acct-rogue-1",
      name: "Marcus Vance (Rogue Operator / Admin)",
      email: "operator-admin@carepassport.internal",
      vuid: "vuid_00deadbeef99a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6",
      tideUserKey: "tideuserkey_ed25519_operator_marcus_vance_99",
      dpopThumbprint: "jkt_es256_sysadmin_unprivileged",
      activeRole: "sysadmin",
      requestedRole: "doctor",
      roleRequestStatus: "NONE",
      realmRoles: ["_tide_enabled", "sysadmin"],
      hospital: "Care Passport Cloud Infrastructure Ops",
      createdAt: nowIso,
      authMethod: "SEEDED_DEMO_ACCOUNT",
    },
    {
      id: "acct-researcher-1",
      name: "Dr. Lin Chen (Clinical Researcher)",
      email: "dr.chen@medpool.org",
      vuid: "vuid_8c11d4f6a2b9e0c3d5f7a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2",
      tideUserKey: "tideuserkey_ed25519_researcher_lin_chen_03",
      dpopThumbprint: "jkt_es256_researcher_dpop_bound",
      activeRole: "researcher",
      requestedRole: "researcher",
      roleRequestStatus: "APPROVED",
      realmRoles: ["_tide_enabled", "researcher", "_tide_decryptor"],
      hospital: "MedPool Cross-Hospital Consortium",
      createdAt: nowIso,
      authMethod: "SEEDED_DEMO_ACCOUNT",
    },
    {
      id: "acct-ethics-1",
      name: "Dr. Hannah Vance (IRB Chair — 1/3)",
      email: "h.vance@stjude-irb.org",
      vuid: "vuid_1a22b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2",
      tideUserKey: "tideuserkey_ed25519_ethics_vance_11",
      dpopThumbprint: "jkt_es256_ethics_vance_enclave",
      activeRole: "ethics-board",
      requestedRole: "ethics-board",
      roleRequestStatus: "APPROVED",
      realmRoles: ["_tide_enabled", "ethics-board", "tide-realm-admin"],
      adminId: "ethics-admin-1",
      hospital: "St. Jude Metro IRB",
      createdAt: nowIso,
      authMethod: "SEEDED_DEMO_ACCOUNT",
    },
    {
      id: "acct-ethics-2",
      name: "Prof. Lukas Weber (Board Member — 2/3)",
      email: "l.weber@charite-ethics.de",
      vuid: "vuid_2b33c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3",
      tideUserKey: "tideuserkey_ed25519_ethics_weber_12",
      dpopThumbprint: "jkt_es256_ethics_weber_enclave",
      activeRole: "ethics-board",
      requestedRole: "ethics-board",
      roleRequestStatus: "APPROVED",
      realmRoles: ["_tide_enabled", "ethics-board", "tide-realm-admin"],
      adminId: "ethics-admin-2",
      hospital: "Charité Berlin Ethics Board",
      createdAt: nowIso,
      authMethod: "SEEDED_DEMO_ACCOUNT",
    },
    {
      id: "acct-ethics-3",
      name: "Dr. Kenji Takahashi (Board Member — 3/3)",
      email: "k.takahashi@tokyo-ethics.jp",
      vuid: "vuid_3c44d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4",
      tideUserKey: "tideuserkey_ed25519_ethics_takahashi_13",
      dpopThumbprint: "jkt_es256_ethics_takahashi_enclave",
      activeRole: "ethics-board",
      requestedRole: "ethics-board",
      roleRequestStatus: "APPROVED",
      realmRoles: ["_tide_enabled", "ethics-board", "tide-realm-admin"],
      adminId: "ethics-admin-3",
      hospital: "Tokyo Univ. Clinical Ethics",
      createdAt: nowIso,
      authMethod: "SEEDED_DEMO_ACCOUNT",
    },
  ];
}

function createInitialState(): MedPoolDatabase {
  const nowIso = new Date().toISOString();
  const patientVuid =
    "vuid_9f81a2c4e7b031d590a12b4c8e7f6d5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e";
  const patientDisplayName = "Elena Rostova";

  // 3 Encrypted Care Passport Records owned by Elena Rostova, each tagged with its own unique recordId (AP-RA03)
  const records: PatientRecord[] = [
    {
      recordId: "CP-REC-001",
      recordType: "Specialist Referral",
      title: "Specialist Cardiology Referral — Post-Thoracic Consult",
      summaryMetadata:
        "Outpatient GP referral for blood pressure & beta-blocker titration (Dr. E. Sato -> Primary Care GP)",
      hospitalOrigin: "St. Jude Metro Hospital",
      icd10Code: "I25.10",
      icd10Category: "Specialist Referral (Cardiology Consult)",
      ageGroup: "55-64",
      admissionDate: "2026-01-14",
      studyGroup: STUDY_GROUP_ID,
      assignmentId: "CP-REC-001",
      patientVuid,
      patientDisplayName,
      ciphertext: packTideMemoryEnvelope(
        SYNTHETIC_CLINICAL_PAYLOADS["CP-REC-001"],
        "CP-REC-001"
      ),
      encryptionContract: "RelationshipAttestation:1",
      encryptedAt: nowIso,
    },
    {
      recordId: "CP-REC-002",
      recordType: "Physiotherapy Care Plan",
      title: "Post-Thoracic Rehabilitation & Mobility Care Plan",
      summaryMetadata:
        "12-week graded cardiopulmonary & thoracic mobility exercise protocol for Allied Physiotherapy",
      hospitalOrigin: "Royal Melbourne Rehabilitation",
      icd10Code: "Z50.1",
      icd10Category: "Physiotherapy Care Plan (Thoracic Rehab)",
      ageGroup: "55-64",
      admissionDate: "2026-02-03",
      studyGroup: STUDY_GROUP_ID,
      assignmentId: "CP-REC-002",
      patientVuid,
      patientDisplayName,
      ciphertext: packTideMemoryEnvelope(
        SYNTHETIC_CLINICAL_PAYLOADS["CP-REC-002"],
        "CP-REC-002"
      ),
      encryptionContract: "RelationshipAttestation:1",
      encryptedAt: nowIso,
    },
    {
      recordId: "CP-REC-003",
      recordType: "Genomic & Pathology Summary",
      title: "Comprehensive Genomic Profiling & Oncology Pathology Vault",
      summaryMetadata:
        "Whole-exome somatic EGFR & germline hereditary cancer panel (Unshared Private Vault Record)",
      hospitalOrigin: "Charité Berlin Oncology",
      icd10Code: "C34.90",
      icd10Category: "Genomic & Pathology Summary (Private Vault)",
      ageGroup: "55-64",
      admissionDate: "2026-02-19",
      studyGroup: STUDY_GROUP_ID,
      assignmentId: "CP-REC-003",
      patientVuid,
      patientDisplayName,
      ciphertext: packTideMemoryEnvelope(
        SYNTHETIC_CLINICAL_PAYLOADS["CP-REC-003"],
        "CP-REC-003"
      ),
      encryptionContract: "RelationshipAttestation:1",
      encryptedAt: nowIso,
    },
  ];

  // Default state on load / reset: Shared with NOBODY (0 active grants, 0 active User policies)
  const relationshipPolicies: StoredRelationshipPolicy[] = [];
  const accounts = createDefaultDemoAccounts(nowIso);

  return {
    records,
    accounts,
    shareGrants: [],
    roleRequests: [],
    consentAttestation: null,
    consentByRecord: {},
    changeRequests: [],
    relationshipPolicies,
    researcherGroupMemberships: [],
    researcherRealmRoles: ["_tide_enabled", "researcher", "_tide_decryptor"],
    studyAccessExpiresAt: null,
    auditLog: [
      {
        id: "audit-init-1",
        timestamp: nowIso,
        actor: "Elena Rostova (Patient Owner)",
        actorAccountId: "acct-patient-1",
        category: "AUTH",
        action: "CARE_PASSPORT_INITIALIZED (3 Encrypted Records, 0 Grants)",
        httpStatus: 201,
        outcome: "ALLOWED",
        detail:
          "3 synthetic health records (CP-REC-001 Specialist Referral, CP-REC-002 Physiotherapy Care Plan, CP-REC-003 Genomic Summary) encrypted in TideMemory v1 envelopes with unique per-record assignmentIds. Default sharing: NOBODY.",
      },
    ],
  };
}

export function readDb(): MedPoolDatabase {
  if (!existsSync(DB_PATH)) {
    const initial = createInitialState();
    writeFileSync(DB_PATH, JSON.stringify(initial, null, 2), "utf8");
    return initial;
  }
  try {
    const parsed = JSON.parse(readFileSync(DB_PATH, "utf8")) as MedPoolDatabase;
    // Automatically migrate if old schema without Care Passport CP-REC-001 or shareGrants
    if (
      !Array.isArray(parsed.shareGrants) ||
      !parsed.records?.some((r) => r.recordId === "CP-REC-001")
    ) {
      const fresh = createInitialState();
      writeFileSync(DB_PATH, JSON.stringify(fresh, null, 2), "utf8");
      return fresh;
    }
    return parsed;
  } catch {
    const initial = createInitialState();
    writeFileSync(DB_PATH, JSON.stringify(initial, null, 2), "utf8");
    return initial;
  }
}

export function writeDb(db: MedPoolDatabase): void {
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

export function resetDb(): MedPoolDatabase {
  const fresh = createInitialState();
  writeDb(fresh);
  return fresh;
}
