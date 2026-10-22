/**
 * Care Passport / MedPool shared domain types and constants.
 *
 * ISOMORPHIC: this module is safe to import from BOTH client components and server code.
 * It must never import Node built-ins (fs, path), server-only modules, or anything with
 * side effects. Persistence lives in `./store` (server-only).
 */

export const STUDY_GROUP_ID = "/studies/study-42";

export const REVOCATION_HONESTY_NOTE =
  "Revocation stops future authorised access; it cannot recall material a recipient has already viewed or copied.";

export interface ClinicalPayloadPlaintext {
  patientCode: string;
  documentTitle?: string;
  authoringClinician?: string;
  clinicalNotes: string;
  biomarkers: {
    lvefPercent: number;
    troponinNgL: number;
    ntProBnpPgMl: number;
    genomicMarker: string;
    adverseGrade: number;
  };
  medications: string[];
  physicianSummary: string;
}

export interface PatientRecord {
  recordId: string;
  // Plaintext non-sensitive metadata (safe to list without decrypting the clinical payload)
  recordType:
    | "Specialist Referral"
    | "Physiotherapy Care Plan"
    | "Genomic & Pathology Summary";
  title: string;
  summaryMetadata: string;
  hospitalOrigin: string;
  icd10Code: string;
  icd10Category: string;
  ageGroup: "35-44" | "45-54" | "55-64" | "65-74";
  admissionDate: string; // YYYY-MM-DD
  studyGroup: string;
  assignmentId: string; // Unique per-record tag (`recordId`) enforced by RelationshipAttestation:1 (AP-RA03)
  patientVuid: string;
  patientDisplayName: string;
  // Encrypted clinical payload (TideMemory v1 envelope; server & operator never see plaintext)
  ciphertext: string;
  encryptionContract: "RelationshipAttestation:1";
  encryptedAt: string;
}

/**
 * Per-record, per-clinician share grant attested by the Patient (`owner` mode `shared-with` claim)
 * and paired with a per-user, per-record `RelationshipAttestation:1` policy.
 *
 * AP-AT02: We store the raw statement columns + 64-byte Ed25519 signature + signerPublicJwk
 * and NEVER the pre-built signed bytes. Every access check rebuilds `buildAttestation()` from
 * these columns and verifies the signature via `verifyAttestation()`.
 */
export interface ClinicianShareGrant {
  id: string;
  recordId: string;
  recordTitle: string;
  patientVuid: string;
  patientName: string;
  clinicianAccountId: string;
  clinicianName: string;
  clinicianRoleLabel: string;
  clinicianEmail: string;
  clinicianVuid: string;
  clinicianUserKey: string;
  // Attestation statement columns (rebuilt on every server check via buildAttestation + verifyAttestation)
  claim: "shared-with";
  issuer: string; // patientVuid (owner mode: issuer === owner === patientVuid)
  owner: string; // patientVuid
  subject: string; // clinicianVuid
  object: string; // recordId
  value: "read";
  expiry: number; // Unix seconds
  contractId: string;
  keyId: string;
  version: string;
  signature: string; // 64-byte Ed25519 signature (base64)
  signerPublicJwk?: JsonWebKey;
  // Accompanying RelationshipAttestation:1 policy (subjectType="User", subjectId=clinicianUserKey, assignmentId=recordId)
  policyB64: string;
  status: "ACTIVE" | "REVOKED";
  grantedAt: string;
  revokedAt?: string;
}

export interface ConsentAttestationRow {
  id: string;
  recordId: string;
  studyId: string;
  claim: "consented";
  issuer: string;
  subject: string;
  object: string;
  value: string;
  expiry: number;
  contractId: string;
  keyId: string;
  version: string;
  signature: string;
  signerPublicJwk?: JsonWebKey;
  dpopBoundThumbprint: string;
  status: "PENDING" | "GRANTED" | "ACTIVE" | "REVOKED";
  updatedAt: string;
}

export interface IgaChangeRequest {
  id: string;
  actionType:
    | "ADD_GROUP_MEMBERSHIP"
    | "GRANT_ROLES"
    | "REVOKE_GROUP_MEMBERSHIP"
    | "MODIFY_QUORUM_RULE";
  entityType: "USER_GROUP_MEMBERSHIP" | "USER_ROLE" | "REALM_IGA_POLICY";
  targetUser: string;
  targetGroupOrRole: string;
  requestedBy: string;
  requestedByRole: "researcher" | "sysadmin" | "ethics-board";
  httpStatusOnCreate: 202;
  status: "PENDING" | "APPROVED" | "COMMITTED" | "DENIED" | "REVOKED";
  threshold: number;
  totalAdmins: number;
  approvals: {
    adminId: string;
    adminName: string;
    hospital: string;
    enclaveSigPreview: string;
    approvedAt: string;
  }[];
  readyToCommit: boolean;
  createdAt: string;
  committedAt?: string;
  expiresAt?: number;
}

export interface StoredRelationshipPolicy {
  subjectType: "Group" | "User" | "Role";
  subjectId: string;
  clientId: string;
  recordId: string;
  roles: string; // '["_tide_decryptor"]'
  policyB64: string;
  contractId: "RelationshipAttestation:1";
  allowedAiFields: string[];
  deniedAiFields: string[];
  expiresAt: number;
  grantedBy: string;
  createdAt: string;
}

export type MedPoolRole =
  | "patient"
  | "doctor"
  | "researcher"
  | "ethics-board"
  | "sysadmin"
  | "pending";

export type RequestedRoleType =
  | "patient"
  | "doctor"
  | "researcher"
  | "ethics-board";

export interface MedPoolAccount {
  id: string;
  name: string;
  email: string;
  vuid: string;
  tideUserKey: string;
  dpopThumbprint: string;
  activeRole: MedPoolRole;
  clinicianSpecialty?: "General Practitioner (GP)" | "Physiotherapist" | "Specialist";
  requestedRole: RequestedRoleType;
  roleRequestStatus: "NONE" | "PENDING" | "APPROVED" | "REJECTED";
  realmRoles: string[];
  adminId?: string;
  hospital?: string;
  linkedRecordId?: string;
  createdAt: string;
  lastLoginAt?: string;
  sessionRefreshedAt?: string;
  authMethod: "TIDECLOAK_SWE" | "SEEDED_DEMO_ACCOUNT";
}

export interface RoleApprovalRequest {
  id: string;
  accountId: string;
  userName: string;
  userEmail: string;
  userVuid: string;
  requestedRole: "researcher" | "ethics-board";
  currentRole: MedPoolRole;
  httpStatusOnCreate: 202;
  status: "PENDING" | "APPROVED" | "REJECTED";
  threshold: number;
  totalAdmins: number;
  approvals: {
    adminId: string;
    adminName: string;
    hospital: string;
    enclaveSigPreview: string;
    approvedAt: string;
  }[];
  rejectedBy?: {
    adminId: string;
    adminName: string;
    reason: string;
    rejectedAt: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  actor: string;
  actorAccountId?: string;
  targetClinicianId?: string;
  targetClinicianName?: string;
  targetRecordId?: string;
  category?:
    | "SHARE_GRANT"
    | "DECRYPT_ALLOWED"
    | "DECRYPT_REFUSED"
    | "REVOCATION"
    | "ROGUE_ADMIN"
    | "AUTH"
    | "ROLE_REQUEST"
    | "SEARCH"
    | "CONSENT"
    | "QUORUM"
    | "UNLOCK"
    | "AI_POLICY";
  action: string;
  httpStatus: number;
  outcome: "ALLOWED" | "PENDING_QUORUM_202" | "DENIED_403" | "REVOKED";
  detail: string;
}

export interface MedPoolDatabase {
  records: PatientRecord[];
  accounts: MedPoolAccount[];
  shareGrants: ClinicianShareGrant[];
  roleRequests: RoleApprovalRequest[];
  consentAttestation: ConsentAttestationRow | null;
  consentByRecord: Record<string, ConsentAttestationRow>;
  changeRequests: IgaChangeRequest[];
  relationshipPolicies: StoredRelationshipPolicy[];
  researcherGroupMemberships: string[];
  researcherRealmRoles: string[];
  studyAccessExpiresAt?: number | null;
  auditLog: AuditLogEntry[];
}
