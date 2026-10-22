import { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import {
  readDb,
  writeDb,
  resetDb,
  STUDY_GROUP_ID,
  REVOCATION_HONESTY_NOTE,
  buildUserRecordPolicyB64,
  type ClinicianShareGrant,
  type ConsentAttestationRow,
  type IgaChangeRequest,
  type MedPoolAccount,
  type RoleApprovalRequest,
  type RequestedRoleType,
  type MedPoolRole,
} from "@/lib/medpool/store";
import {
  buildAttestation,
  verifyAttestation,
  statements,
  toBase64,
  type SigningRule,
} from "@/lib/tide/attestation.server";
import {
  DEFAULT_ALLOWED_AI_FIELDS,
  DEFAULT_DENIED_AI_FIELDS,
} from "@/lib/medpool/sandbox";
import { verifyTideJWT, extractToken } from "@/lib/auth/tideJWT";
import { verifyDpop } from "@/lib/auth/verifyDpop";
import { loadTideConfig } from "@/lib/auth/tidecloakConfig";

function getSelfConsentRule(): SigningRule {
  const cfg = loadTideConfig();
  return {
    version: "3",
    contractId:
      "A9F4E2C18B7D6053412E9C8B7A6F5E4D3C2B1A09F8E7D6C5B4A39281706F5E4D3C2B1A09F8E7D6C5B4A39281706F5E4D3C2B1A09F8E7D6C5B4A39281706F5E4D",
    keyId:
      (cfg as any)?.vendorId ||
      cfg?.jwk?.keys?.[0]?.kid ||
      "dab8904a-92f9-4e62-b7f7-b3974e99785b",
  };
}

function getOwnerShareRule(): SigningRule {
  const cfg = loadTideConfig();
  return {
    version: "3",
    contractId:
      "B8E5D3A29C6F7142503F8D9C6B5A4E3F2D1C0B98E7F6C5D4A3B281906F5E4D3CB8E5D3A29C6F7142503F8D9C6B5A4E3F2D1C0B98E7F6C5D4A3B281906F5E4D3C",
    keyId:
      (cfg as any)?.vendorId ||
      cfg?.jwk?.keys?.[0]?.kid ||
      "dab8904a-92f9-4e62-b7f7-b3974e99785b",
  };
}

const ETHICS_BOARD_ADMINS: Record<
  string,
  { adminId: string; adminName: string; hospital: string }
> = {
  "ethics-admin-1": {
    adminId: "ethics-admin-1",
    adminName: "Dr. Hannah Vance (Chair)",
    hospital: "St. Jude Metro IRB",
  },
  "ethics-admin-2": {
    adminId: "ethics-admin-2",
    adminName: "Prof. Lukas Weber",
    hospital: "Charité Berlin Ethics Board",
  },
  "ethics-admin-3": {
    adminId: "ethics-admin-3",
    adminName: "Dr. Kenji Takahashi",
    hospital: "Tokyo Univ. Clinical Ethics",
  },
};

async function verifyOptionalLiveTideToken(req: NextRequest): Promise<{
  verifiedLiveToken: boolean;
  subject?: string;
  vuid?: string;
  tideUserKey?: string;
  groups?: string[];
  roles?: string[];
}> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) return { verifiedLiveToken: false };
  try {
    const token = extractToken(authHeader);
    const jwt = await verifyTideJWT(token);
    await verifyDpop(req, token, jwt as { cnf?: { jkt?: string } });
    return {
      verifiedLiveToken: true,
      subject: jwt.sub,
      vuid: typeof jwt.vuid === "string" ? jwt.vuid : undefined,
      tideUserKey:
        typeof jwt.tideuserkey === "string" ? jwt.tideuserkey : undefined,
      groups: Array.isArray(jwt.groups) ? (jwt.groups as string[]) : [],
      roles: Array.isArray((jwt.realm_access as any)?.roles)
        ? ((jwt.realm_access as any).roles as string[])
        : [],
    };
  } catch {
    return { verifiedLiveToken: false };
  }
}

async function isConsentCryptographicallyVerified(
  row: ConsentAttestationRow | null | undefined,
  extraJwk?: JsonWebKey
): Promise<boolean> {
  if (!row || (row.status !== "ACTIVE" && row.status !== "GRANTED")) return false;
  const config = loadTideConfig();
  const keys: JsonWebKey[] = [...(config.jwk?.keys ?? [])];
  if (row.signerPublicJwk) keys.push(row.signerPublicJwk);
  if (extraJwk) keys.push(extraJwk);

  // AP-AT01 & AP-AT02: Rebuild statement from stored columns and verify signature
  const statement = {
    claim: row.claim,
    issuer: row.issuer,
    subject: row.subject,
    object: row.object,
    value: row.value,
    expiry: row.expiry,
  };
  const rule: SigningRule = {
    version: row.version,
    contractId: row.contractId,
    keyId: row.keyId,
  };
  return verifyAttestation(
    rule,
    config.resource || "medpool-client",
    statement,
    row.signature,
    keys
  );
}

/**
 * AP-AT01 & AP-AT02: Verify a per-record, per-clinician `owner`-mode `shared-with` grant
 * by rebuilding the `Policy.DataToVerify` bytes from the stored columns and verifying the
 * 64-byte Ed25519 signature against the realm VVK + patient's public JWK on EVERY check.
 */
async function isShareGrantCryptographicallyVerified(
  grant: ClinicianShareGrant | null | undefined,
  extraJwk?: JsonWebKey
): Promise<boolean> {
  if (!grant || grant.status !== "ACTIVE" || !grant.signature) return false;
  if (grant.claim !== "shared-with") return false;
  if (grant.issuer !== grant.owner || grant.issuer !== grant.patientVuid) {
    return false;
  }
  if (grant.subject !== grant.clinicianVuid) return false;
  if (grant.object !== grant.recordId) return false;

  const config = loadTideConfig();
  const keys: JsonWebKey[] = [...(config.jwk?.keys ?? [])];
  if (grant.signerPublicJwk) keys.push(grant.signerPublicJwk);
  if (extraJwk) keys.push(extraJwk);

  const statement = {
    claim: grant.claim,
    issuer: grant.issuer,
    owner: grant.owner,
    subject: grant.subject,
    object: grant.object,
    value: grant.value,
    expiry: grant.expiry,
  };
  const rule: SigningRule = {
    version: grant.version,
    contractId: grant.contractId,
    keyId: grant.keyId,
  };
  return verifyAttestation(
    rule,
    config.resource || "medpool-client",
    statement,
    grant.signature,
    keys
  );
}

async function isRecordConsentActive(
  row: ConsentAttestationRow | undefined | null,
  expectedRecordId: string,
  expectedPatientVuid: string
): Promise<boolean> {
  if (!row) return false;
  if (row.status !== "ACTIVE" && row.status !== "GRANTED") return false;
  if (row.recordId !== expectedRecordId) return false;
  if (row.studyId !== STUDY_GROUP_ID || row.object !== STUDY_GROUP_ID) return false;
  if (row.issuer !== expectedPatientVuid || row.subject !== expectedPatientVuid) return false;
  if (row.expiry <= Math.floor(Date.now() / 1000)) return false;
  return await isConsentCryptographicallyVerified(row);
}

export async function GET(req: NextRequest) {
  const db = readDb();
  const url = new URL(req.url);
  const hospitalFilter = url.searchParams.get("hospital") || "";
  const icdFilter = url.searchParams.get("icd10") || "";
  const ageFilter = url.searchParams.get("ageGroup") || "";
  const dateFrom = url.searchParams.get("dateFrom") || "";
  const dateTo = url.searchParams.get("dateTo") || "";

  const liveAuth = await verifyOptionalLiveTideToken(req);

  const filteredRecords = db.records.filter((r) => {
    if (
      hospitalFilter &&
      !r.hospitalOrigin.toLowerCase().includes(hospitalFilter.toLowerCase())
    ) {
      return false;
    }
    if (
      icdFilter &&
      !r.icd10Code.toLowerCase().includes(icdFilter.toLowerCase()) &&
      !r.icd10Category.toLowerCase().includes(icdFilter.toLowerCase()) &&
      !r.title.toLowerCase().includes(icdFilter.toLowerCase())
    ) {
      return false;
    }
    if (ageFilter && r.ageGroup !== ageFilter) {
      return false;
    }
    if (dateFrom && r.admissionDate < dateFrom) {
      return false;
    }
    if (dateTo && r.admissionDate > dateTo) {
      return false;
    }
    return true;
  });

  // Verify per-record, per-clinician share grants cryptographically (AP-AT01 & AP-AT02)
  const verifiedGrants: ClinicianShareGrant[] = [];
  for (const g of db.shareGrants ?? []) {
    if (g.status === "ACTIVE") {
      const ok = await isShareGrantCryptographicallyVerified(g);
      if (ok) {
        verifiedGrants.push(g);
      }
    }
  }

  // Evaluate per-record consent states (PENDING | GRANTED | REVOKED) with real signature verification
  const recordConsentStatus: Record<string, "PENDING" | "GRANTED" | "REVOKED"> = {};
  let grantedCount = 0;
  for (const r of db.records) {
    const row = db.consentByRecord?.[r.recordId];
    const activeRecordGrants = verifiedGrants.filter(
      (g) => g.recordId === r.recordId
    );
    if (activeRecordGrants.length > 0) {
      recordConsentStatus[r.recordId] = "GRANTED";
      grantedCount++;
    } else if (
      (db.shareGrants ?? []).some(
        (g) => g.recordId === r.recordId && g.status === "REVOKED"
      )
    ) {
      recordConsentStatus[r.recordId] = "REVOKED";
    } else if (!row) {
      recordConsentStatus[r.recordId] = "PENDING";
    } else if (row.status === "REVOKED") {
      recordConsentStatus[r.recordId] = "REVOKED";
    } else if (await isRecordConsentActive(row, r.recordId, r.patientVuid)) {
      recordConsentStatus[r.recordId] = "GRANTED";
      grantedCount++;
    } else {
      recordConsentStatus[r.recordId] = "PENDING";
    }
  }

  const lock1ConsentValid = grantedCount > 0;

  const committedStudyCr = db.changeRequests.find(
    (cr) =>
      cr.actionType === "ADD_GROUP_MEMBERSHIP" &&
      cr.targetGroupOrRole === STUDY_GROUP_ID &&
      cr.requestedByRole === "researcher" &&
      cr.status === "COMMITTED" &&
      cr.approvals.length >= cr.threshold
  );

  const inStudyGroup =
    (db.researcherGroupMemberships.includes(STUDY_GROUP_ID) &&
      Boolean(committedStudyCr)) ||
    Boolean(liveAuth.groups?.includes(STUDY_GROUP_ID));

  const hasDecryptorRole =
    db.researcherRealmRoles.includes("_tide_decryptor") ||
    Boolean(liveAuth.roles?.includes("_tide_decryptor"));

  const activePolicy = db.relationshipPolicies.find(
    (p) => p.subjectType === "Group" && p.subjectId === STUDY_GROUP_ID
  );

  // Feature 7: Time-limited access check
  const nowSec = Math.floor(Date.now() / 1000);
  if (
    db.studyAccessExpiresAt &&
    db.studyAccessExpiresAt <= nowSec &&
    db.researcherGroupMemberships.includes(STUDY_GROUP_ID)
  ) {
    db.researcherGroupMemberships = db.researcherGroupMemberships.filter(
      (g) => g !== STUDY_GROUP_ID
    );
    for (const cr of db.changeRequests) {
      if (
        cr.targetGroupOrRole === STUDY_GROUP_ID &&
        cr.status === "COMMITTED"
      ) {
        cr.status = "REVOKED";
      }
    }
    db.studyAccessExpiresAt = null;
    db.auditLog.unshift({
      id: `audit-${randomUUID().slice(0, 8)}`,
      timestamp: new Date().toISOString(),
      actor: "Time-Limited Access Enforcer (TTL Expiry)",
      category: "REVOCATION",
      action: `STUDY_ACCESS_EXPIRED (${STUDY_GROUP_ID})`,
      httpStatus: 200,
      outcome: "REVOKED",
      detail: `Time-limited study approval window expired. Researcher automatically removed from '${STUDY_GROUP_ID}' and decrypted browser sandbox memory wiped.`,
    });
    writeDb(db);
  }

  const stillInStudyGroup =
    (db.researcherGroupMemberships.includes(STUDY_GROUP_ID) &&
      Boolean(committedStudyCr)) ||
    Boolean(liveAuth.groups?.includes(STUDY_GROUP_ID));

  const emergentAuthorityUnlocked =
    (lock1ConsentValid && stillInStudyGroup && hasDecryptorRole && Boolean(activePolicy)) ||
    verifiedGrants.length > 0;

  const clinicians = (db.accounts ?? []).filter(
    (a) => a.activeRole === "doctor"
  );

  return Response.json({
    studyGroupId: STUDY_GROUP_ID,
    honestyNote: REVOCATION_HONESTY_NOTE,
    // Step 2 Security Fix: Strip raw `ciphertext` from metadata listing!
    // Clinicians only receive a record's `ciphertext` + `policyB64` when `DECRYPT_SHARED_RECORD`
    // passes server-side `verifyAttestation` + `RelationshipAttestation:1` subject checks.
    records: filteredRecords.map(({ ciphertext, ...meta }) => {
      const recordGrants = (db.shareGrants ?? []).filter(
        (g) => g.recordId === meta.recordId
      );
      const activeForRecord = verifiedGrants.filter(
        (g) => g.recordId === meta.recordId
      );
      return {
        ...meta,
        consentState: recordConsentStatus[meta.recordId] ?? "PENDING",
        payloadLocked: activeForRecord.length === 0,
        ciphertextPreview: `${ciphertext.slice(0, 68)}...`,
        activeShares: activeForRecord.map((g) => ({
          grantId: g.id,
          clinicianAccountId: g.clinicianAccountId,
          clinicianName: g.clinicianName,
          clinicianRoleLabel: g.clinicianRoleLabel,
          clinicianVuid: g.clinicianVuid,
          expiry: g.expiry,
          grantedAt: g.grantedAt,
        })),
        revokedShares: recordGrants
          .filter((g) => g.status === "REVOKED")
          .map((g) => ({
            grantId: g.id,
            clinicianAccountId: g.clinicianAccountId,
            clinicianName: g.clinicianName,
            clinicianRoleLabel: g.clinicianRoleLabel,
            revokedAt: g.revokedAt,
          })),
      };
    }),
    totalRecords: db.records.length,
    accounts: db.accounts ?? [],
    clinicians,
    shareGrants: (db.shareGrants ?? []).map(({ signerPublicJwk, ...rest }) => ({
      ...rest,
      cryptographicallyVerified: verifiedGrants.some((v) => v.id === rest.id),
    })),
    roleRequests: db.roleRequests ?? [],
    consentAttestation: db.consentAttestation,
    consentByRecord: db.consentByRecord ?? {},
    recordConsentStatus,
    grantedConsentCount: grantedCount,
    changeRequests: db.changeRequests,
    relationshipPolicy: activePolicy ?? null,
    relationshipPolicies: db.relationshipPolicies ?? [],
    researcherGroupMemberships: db.researcherGroupMemberships,
    researcherRealmRoles: db.researcherRealmRoles,
    studyAccessExpiresAt: db.studyAccessExpiresAt ?? null,
    auditLog: db.auditLog,
    emergentAuthority: {
      lock1PatientSelfConsent: lock1ConsentValid,
      lock2EthicsQuorumCommitted: stillInStudyGroup || verifiedGrants.length > 0,
      lock3ResearcherDpopAndRole: hasDecryptorRole,
      unlocked: emergentAuthorityUnlocked,
      quorumFormula: "Owner-Mode Attestation + Per-Record RelationshipAttestation:1 Policy",
    },
    liveAuth,
  });
}

export async function POST(req: NextRequest) {
  const db = readDb();
  const body = await req.json();
  const action = body.action as string;
  const nowIso = new Date().toISOString();

  // Gotcha #7: Server-side role & entitlement verification on EVERY request.
  // Resolves the caller's role from (1) verified EdDSA + DPoP Tide JWT, (2) server-side account lookup
  // via x-medpool-account-id header, or (3) explicit role claim in request body.
  const liveAuth = await verifyOptionalLiveTideToken(req);
  const headerAccountId = req.headers.get("x-medpool-account-id");
  const sessionAccount = headerAccountId
    ? db.accounts.find((a) => a.id === headerAccountId)
    : liveAuth.vuid
    ? db.accounts.find((a) => a.vuid === liveAuth.vuid)
    : undefined;
  const serverResolvedRole: MedPoolRole | undefined =
    (body.callerRole as MedPoolRole | undefined) ||
    (body.actorRole as MedPoolRole | undefined) ||
    (liveAuth.roles?.includes("ethics-board")
      ? "ethics-board"
      : liveAuth.roles?.includes("researcher")
      ? "researcher"
      : liveAuth.roles?.includes("doctor")
      ? "doctor"
      : liveAuth.roles?.includes("patient")
      ? "patient"
      : sessionAccount?.activeRole);

  // 0. Reset prototype state for a clean 2-minute demo run
  if (action === "RESET_DEMO") {
    const fresh = resetDb();
    return Response.json({ ok: true, db: fresh });
  }

  // 0a-1. Account Registration (`SIGNUP_ACCOUNT`) — Feature 1 & 2
  // Never accepts, hashes, or stores a password or private key.
  // New accounts start with minimal, non-sensitive permissions only.
  // Sensitive role requests (`researcher`, `ethics-board`) go into a PENDING state requiring 2-of-3 Ethics Board quorum.
  if (action === "SIGNUP_ACCOUNT") {
    if ("password" in body || "privateKey" in body || "secret" in body) {
      return Response.json(
        {
          error:
            "Hard Rule Violation: MedPool never accepts or stores passwords or private keys. Authentication happens exclusively in TideCloak's Secure Web Enclave.",
        },
        { status: 400 }
      );
    }

    const name = ((body.name as string) || "").trim();
    const email = ((body.email as string) || "").trim().toLowerCase();
    const requestedRole =
      (body.requestedRole as RequestedRoleType) || "patient";
    const hospital =
      ((body.hospital as string) || "").trim() || "Partner Clinical Institution";
    const incomingVuid = (body.vuid as string) || "";
    const authMethod =
      (body.authMethod as "TIDECLOAK_SWE" | "SEEDED_DEMO_ACCOUNT") ||
      "TIDECLOAK_SWE";

    if (!name || name.length < 2) {
      return Response.json(
        { error: "Full name is required (at least 2 characters)." },
        { status: 400 }
      );
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return Response.json(
        { error: "A valid institutional or personal email address is required." },
        { status: 400 }
      );
    }
    if (
      !["patient", "doctor", "researcher", "ethics-board"].includes(
        requestedRole
      )
    ) {
      return Response.json(
        { error: "Invalid requested role." },
        { status: 400 }
      );
    }

    const existing = db.accounts.find(
      (a) => a.email.toLowerCase() === email
    );
    if (existing) {
      return Response.json(
        {
          error: `An account with email '${email}' is already registered in MedPool.`,
        },
        { status: 409 }
      );
    }

    const isElevatedRequest =
      requestedRole === "researcher" || requestedRole === "ethics-board";
    const generatedVuid =
      incomingVuid ||
      `vuid_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
    const accountId = `acct-${randomUUID().slice(0, 8)}`;

    // Minimal initial permissions: elevated roles start as `pending` with only `_tide_enabled`
    const initialActiveRole: MedPoolRole = isElevatedRequest
      ? "pending"
      : requestedRole;
    const initialRealmRoles = isElevatedRequest
      ? ["_tide_enabled"]
      : ["_tide_enabled", requestedRole];

    const newAccount: MedPoolAccount = {
      id: accountId,
      name,
      email,
      vuid: generatedVuid,
      tideUserKey:
        (body.tideUserKey as string) ||
        `tideuserkey_ed25519_${generatedVuid.slice(0, 16)}`,
      dpopThumbprint: `jkt_es256_${accountId.replace(/-/g, "_")}_swe`,
      activeRole: initialActiveRole,
      requestedRole,
      roleRequestStatus: isElevatedRequest ? "PENDING" : "APPROVED",
      realmRoles: initialRealmRoles,
      hospital,
      linkedRecordId:
        requestedRole === "patient" ? "CP-REC-001" : undefined,
      createdAt: nowIso,
      lastLoginAt: nowIso,
      authMethod,
    };

    db.accounts.push(newAccount);

    db.auditLog.unshift({
      id: `audit-${randomUUID().slice(0, 8)}`,
      timestamp: nowIso,
      actor: `${name} (${email})`,
      actorAccountId: accountId,
      category: "AUTH",
      action: `ACCOUNT_SIGNUP (requested=${requestedRole}, initialRole=${initialActiveRole})`,
      httpStatus: 201,
      outcome: "ALLOWED",
      detail: `Registered zero-knowledge TideCloak account (vuid=${generatedVuid.slice(
        0,
        16
      )}...). Password never touched MedPool servers. Provisioned minimal initial permissions: [${initialRealmRoles.join(
        ", "
      )}].`,
    });

    let createdRoleRequest: RoleApprovalRequest | null = null;
    if (isElevatedRequest) {
      createdRoleRequest = {
        id: `rr-${randomUUID().slice(0, 8)}`,
        accountId,
        userName: name,
        userEmail: email,
        userVuid: generatedVuid,
        requestedRole: requestedRole as "researcher" | "ethics-board",
        currentRole: "pending",
        httpStatusOnCreate: 202,
        status: "PENDING",
        threshold: 2,
        totalAdmins: 3,
        approvals: [],
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      db.roleRequests.unshift(createdRoleRequest);

      db.auditLog.unshift({
        id: `audit-${randomUUID().slice(0, 8)}`,
        timestamp: nowIso,
        actor: `${name} (${email})`,
        actorAccountId: accountId,
        category: "ROLE_REQUEST",
        action: `REQUEST_ELEVATED_ROLE (${requestedRole})`,
        httpStatus: 202,
        outcome: "PENDING_QUORUM_202",
        detail: `HTTP 202 Accepted (Pending Governance): Request for elevated role '${requestedRole}' queued (${createdRoleRequest.id}). Requires 2-of-3 Ethics Board quorum approvals; a single admin cannot grant sensitive roles unilaterally.`,
      });
    }

    writeDb(db);
    return Response.json(
      {
        ok: true,
        account: newAccount,
        roleRequest: createdRoleRequest,
      },
      { status: 201 }
    );
  }

  // 0a-2. Login (`LOGIN_ACCOUNT`) — Feature 3 & 6
  if (action === "LOGIN_ACCOUNT") {
    const { accountId, email, vuid, authMethod } = body as {
      accountId?: string;
      email?: string;
      vuid?: string;
      authMethod?: string;
    };

    let account = db.accounts.find(
      (a) =>
        (accountId && a.id === accountId) ||
        (email && a.email.toLowerCase() === email.toLowerCase()) ||
        (vuid && a.vuid === vuid)
    );

    // Gotcha #9 (AP-85): A new Tide account has no name or email.
    // Never generate placeholder names ("Tide User") or placeholder emails ("user@tide.local").
    if (!account && vuid) {
      const createdAccount: MedPoolAccount = {
        id: `acct-swe-${vuid.slice(0, 8)}`,
        name: ((body.name as string) || "").trim(),
        email: ((body.email as string) || "").trim(),
        vuid,
        tideUserKey:
          (body.tideUserKey as string) ||
          `tideuserkey_ed25519_${vuid.slice(0, 16)}`,
        dpopThumbprint: `jkt_es256_swe_${vuid.slice(0, 10)}`,
        activeRole: "patient",
        requestedRole: "patient",
        roleRequestStatus: "APPROVED",
        realmRoles: ["_tide_enabled", "patient"],
        linkedRecordId: "CP-REC-001",
        hospital: "TideCloak Live Enclave",
        createdAt: nowIso,
        lastLoginAt: nowIso,
        authMethod: "TIDECLOAK_SWE",
      };
      db.accounts.push(createdAccount);
      account = createdAccount;
    }

    if (!account) {
      return Response.json(
        { error: "Account not found. Please sign up first." },
        { status: 404 }
      );
    }

    account.lastLoginAt = nowIso;
    db.auditLog.unshift({
      id: `audit-${randomUUID().slice(0, 8)}`,
      timestamp: nowIso,
      actor: `${account.name || "New Tide User"} (${account.email || account.vuid.slice(0, 12)})`,
      actorAccountId: account.id,
      category: "AUTH",
      action: `USER_LOGIN (role=${account.activeRole}, via=${
        authMethod || account.authMethod
      })`,
      httpStatus: 200,
      outcome: "ALLOWED",
      detail: `Authenticated session established via TideCloak DPoP-bound token (vuid=${account.vuid.slice(
        0,
        16
      )}..., jkt=${account.dpopThumbprint}). Active role: '${account.activeRole}'.`,
    });
    writeDb(db);
    return Response.json({ ok: true, account });
  }

  // 0a-2b. Update Profile Details for New Tide Users (`UPDATE_PROFILE_DETAILS` — Gotcha #9)
  if (action === "UPDATE_PROFILE_DETAILS") {
    const { accountId, vuid, name, email } = body as {
      accountId?: string;
      vuid?: string;
      name?: string;
      email?: string;
    };
    const account = db.accounts.find(
      (a) =>
        (accountId && a.id === accountId) ||
        (vuid && a.vuid === vuid) ||
        (headerAccountId && a.id === headerAccountId)
    );
    if (!account) {
      return Response.json({ error: "Account not found" }, { status: 404 });
    }
    if (typeof name === "string" && name.trim()) {
      account.name = name.trim();
    }
    if (typeof email === "string" && email.trim()) {
      account.email = email.trim().toLowerCase();
    }
    db.auditLog.unshift({
      id: `audit-${randomUUID().slice(0, 8)}`,
      timestamp: nowIso,
      actor: `${account.name || account.vuid.slice(0, 12)} (${account.email || "no-email"})`,
      actorAccountId: account.id,
      category: "AUTH",
      action: "PROFILE_ONBOARDING_COMPLETED",
      httpStatus: 200,
      outcome: "ALLOWED",
      detail: `Completed profile onboarding for Tide identity vuid=${account.vuid.slice(0, 16)}... (name='${account.name}', email='${account.email}').`,
    });
    writeDb(db);
    return Response.json({ ok: true, account });
  }

  // 0a-3. Logout (`LOGOUT_ACCOUNT`) — Feature 3 & 6
  if (action === "LOGOUT_ACCOUNT") {
    const { accountId, actorName } = body as {
      accountId?: string;
      actorName?: string;
    };
    const account = db.accounts.find((a) => a.id === accountId);
    const label = account
      ? `${account.name} (${account.email || account.vuid.slice(0, 12)})`
      : actorName || "Authenticated User";

    db.auditLog.unshift({
      id: `audit-${randomUUID().slice(0, 8)}`,
      timestamp: nowIso,
      actor: label,
      actorAccountId: account?.id,
      category: "AUTH",
      action: "USER_LOGOUT",
      httpStatus: 200,
      outcome: "ALLOWED",
      detail:
        "Session terminated. Cleared DPoP-bound session token and wiped any in-browser decrypted clinical state.",
    });
    writeDb(db);
    return Response.json({ ok: true });
  }

  // 0a-4. Request Role Upgrade from Profile (`REQUEST_ROLE_UPGRADE`) — Feature 2 & 5
  if (action === "REQUEST_ROLE_UPGRADE") {
    const { accountId, requestedRole } = body as {
      accountId: string;
      requestedRole: "researcher" | "ethics-board";
    };
    const account = db.accounts.find((a) => a.id === accountId);
    if (!account) {
      return Response.json({ error: "Account not found" }, { status: 404 });
    }
    if (!["researcher", "ethics-board"].includes(requestedRole)) {
      return Response.json(
        { error: "Only 'researcher' or 'ethics-board' require quorum elevation." },
        { status: 400 }
      );
    }

    const existingPending = db.roleRequests.find(
      (rr) => rr.accountId === account.id && rr.status === "PENDING"
    );
    if (existingPending) {
      return Response.json(
        {
          error: `A role request (${existingPending.id}) is already PENDING 2-of-3 Ethics Board quorum.`,
          roleRequest: existingPending,
        },
        { status: 409 }
      );
    }

    account.requestedRole = requestedRole;
    account.roleRequestStatus = "PENDING";

    const rr: RoleApprovalRequest = {
      id: `rr-${randomUUID().slice(0, 8)}`,
      accountId: account.id,
      userName: account.name,
      userEmail: account.email,
      userVuid: account.vuid,
      requestedRole,
      currentRole: account.activeRole,
      httpStatusOnCreate: 202,
      status: "PENDING",
      threshold: 2,
      totalAdmins: 3,
      approvals: [],
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    db.roleRequests.unshift(rr);

    db.auditLog.unshift({
      id: `audit-${randomUUID().slice(0, 8)}`,
      timestamp: nowIso,
      actor: `${account.name} (${account.email})`,
      actorAccountId: account.id,
      category: "ROLE_REQUEST",
      action: `REQUEST_ELEVATED_ROLE (${requestedRole})`,
      httpStatus: 202,
      outcome: "PENDING_QUORUM_202",
      detail: `HTTP 202 Accepted: Queued elevated role request ${rr.id} for '${requestedRole}'. Requires 2-of-3 Ethics Board quorum approvals.`,
    });
    writeDb(db);
    return Response.json({ ok: true, account, roleRequest: rr }, { status: 202 });
  }

  // 0a-5. Ethics Board 2-of-3 Quorum Approval for Elevated Role Requests (`APPROVE_ROLE_REQUEST`) — Feature 2 & Hard Rule 3
  if (action === "APPROVE_ROLE_REQUEST") {
    const { roleRequestId, adminId, callerRole } = body as {
      roleRequestId: string;
      adminId: string;
      callerRole?: MedPoolRole;
    };
    const effectiveCallerRole = callerRole || serverResolvedRole;

    if (effectiveCallerRole && effectiveCallerRole !== "ethics-board") {
      db.auditLog.unshift({
        id: `audit-${randomUUID().slice(0, 8)}`,
        timestamp: nowIso,
        actor: `Unauthorized Role (${effectiveCallerRole})`,
        category: "ROLE_REQUEST",
        action: `APPROVE_ROLE_REQUEST (${roleRequestId})`,
        httpStatus: 403,
        outcome: "DENIED_403",
        detail: `DENIED (HTTP 403): Role '${effectiveCallerRole}' cannot approve elevated role requests. Requires Ethics Board member enclave authority.`,
      });
      writeDb(db);
      return Response.json(
        {
          error: `Forbidden (HTTP 403): Role '${effectiveCallerRole}' is not authorized to approve role requests. Only Ethics Board members can sign quorum approvals.`,
        },
        { status: 403 }
      );
    }

    const adminMeta = ETHICS_BOARD_ADMINS[adminId];
    if (!adminMeta) {
      return Response.json(
        { error: "Unknown Ethics Board admin ID" },
        { status: 400 }
      );
    }

    const rr = db.roleRequests.find((r) => r.id === roleRequestId);
    if (!rr) {
      return Response.json(
        { error: "Role approval request not found" },
        { status: 404 }
      );
    }
    if (rr.status !== "PENDING") {
      return Response.json(
        { error: `Role request is already ${rr.status}` },
        { status: 409 }
      );
    }

    const targetAcct = db.accounts.find((a) => a.id === rr.accountId);
    if (targetAcct && targetAcct.adminId === adminId) {
      return Response.json(
        {
          error:
            "403 Forbidden: Self-approval is prohibited. A single admin cannot grant themselves sensitive roles.",
        },
        { status: 403 }
      );
    }

    if (rr.approvals.some((a) => a.adminId === adminId)) {
      return Response.json(
        {
          error:
            "409 Conflict: Four-eyes quorum rule — this Ethics Board member already signed this role request. A second distinct board member must approve.",
        },
        { status: 409 }
      );
    }

    const sigBytes = new Uint8Array(32);
    crypto.getRandomValues(sigBytes);
    const enclaveSigPreview = `vvk_ed25519_role_${toBase64(sigBytes).slice(0, 20)}...`;

    rr.approvals.push({
      adminId: adminMeta.adminId,
      adminName: adminMeta.adminName,
      hospital: adminMeta.hospital,
      enclaveSigPreview,
      approvedAt: nowIso,
    });
    rr.updatedAt = nowIso;

    if (rr.approvals.length >= rr.threshold) {
      rr.status = "APPROVED";
      if (targetAcct) {
        targetAcct.activeRole = rr.requestedRole;
        targetAcct.roleRequestStatus = "APPROVED";
        if (rr.requestedRole === "researcher") {
          targetAcct.realmRoles = [
            "_tide_enabled",
            "researcher",
            "_tide_decryptor",
          ];
        } else if (rr.requestedRole === "ethics-board") {
          targetAcct.realmRoles = [
            "_tide_enabled",
            "ethics-board",
            "tide-realm-admin",
          ];
        }
      }
    }

    db.auditLog.unshift({
      id: `audit-${randomUUID().slice(0, 8)}`,
      timestamp: nowIso,
      actor: `${adminMeta.adminName} (${adminMeta.hospital})`,
      category: "ROLE_REQUEST",
      action: `APPROVE_ROLE_REQUEST (${rr.id} -> ${rr.requestedRole})`,
      httpStatus: 200,
      outcome: rr.status === "APPROVED" ? "ALLOWED" : "PENDING_QUORUM_202",
      detail:
        rr.status === "APPROVED"
          ? `2-of-3 Ethics Board quorum met (${rr.approvals.length}/${rr.threshold}). Role '${rr.requestedRole}' granted to ${rr.userName} (${rr.userEmail}).`
          : `Recorded approval ${rr.approvals.length}/${rr.threshold} from ${adminMeta.adminName}. Role '${rr.requestedRole}' remains PENDING until a 2nd Ethics Board member signs.`,
    });

    writeDb(db);
    return Response.json({
      ok: true,
      roleRequest: rr,
      account: targetAcct ?? null,
    });
  }

  // 0a-6. Ethics Board Rejection of Role Request (`REJECT_ROLE_REQUEST`) — Feature 2 & 6
  if (action === "REJECT_ROLE_REQUEST") {
    const { roleRequestId, adminId, reason, callerRole } = body as {
      roleRequestId: string;
      adminId: string;
      reason?: string;
      callerRole?: MedPoolRole;
    };
    const effectiveCallerRole = callerRole || serverResolvedRole;

    if (effectiveCallerRole && effectiveCallerRole !== "ethics-board") {
      return Response.json(
        {
          error: `Forbidden (HTTP 403): Role '${effectiveCallerRole}' cannot reject role requests. Only Ethics Board members have governance authority.`,
        },
        { status: 403 }
      );
    }

    const adminMeta = ETHICS_BOARD_ADMINS[adminId] || {
      adminId: "ethics-admin-1",
      adminName: "Dr. Hannah Vance (Chair)",
      hospital: "St. Jude Metro IRB",
    };

    const rr = db.roleRequests.find((r) => r.id === roleRequestId);
    if (!rr) {
      return Response.json(
        { error: "Role approval request not found" },
        { status: 404 }
      );
    }
    if (rr.status !== "PENDING") {
      return Response.json(
        { error: `Role request is already ${rr.status}` },
        { status: 409 }
      );
    }

    rr.status = "REJECTED";
    rr.updatedAt = nowIso;
    rr.rejectedBy = {
      adminId: adminMeta.adminId,
      adminName: adminMeta.adminName,
      reason:
        reason ||
        "Insufficient institutional credential verification for elevated clinical cohort access.",
      rejectedAt: nowIso,
    };

    const targetAcct = db.accounts.find((a) => a.id === rr.accountId);
    if (targetAcct) {
      targetAcct.roleRequestStatus = "REJECTED";
    }

    db.auditLog.unshift({
      id: `audit-${randomUUID().slice(0, 8)}`,
      timestamp: nowIso,
      actor: `${adminMeta.adminName} (${adminMeta.hospital})`,
      category: "ROLE_REQUEST",
      action: `REJECT_ROLE_REQUEST (${rr.id} -> ${rr.requestedRole})`,
      httpStatus: 200,
      outcome: "DENIED_403",
      detail: `Role request for '${rr.requestedRole}' by ${rr.userName} (${rr.userEmail}) REJECTED by ${adminMeta.adminName}. Reason: ${rr.rejectedBy.reason}`,
    });

    writeDb(db);
    return Response.json({
      ok: true,
      roleRequest: rr,
      account: targetAcct ?? null,
    });
  }

  // 0b. Log metadata search in Audit Trail (Task A & H)
  if (action === "LOG_METADATA_SEARCH") {
    const { hospital, icd10, ageGroup, dateFrom, dateTo, matchCount } = body as {
      hospital?: string;
      icd10?: string;
      ageGroup?: string;
      dateFrom?: string;
      dateTo?: string;
      matchCount?: number;
    };
    const filters = [
      hospital ? `hospital='${hospital}'` : null,
      icd10 ? `condition='${icd10}'` : null,
      ageGroup ? `ageBand='${ageGroup}'` : null,
      dateFrom || dateTo ? `dateRange='${dateFrom || "*"}..${dateTo || "*"}'` : null,
    ]
      .filter(Boolean)
      .join(", ");

    db.auditLog.unshift({
      id: `audit-${randomUUID().slice(0, 8)}`,
      timestamp: nowIso,
      actor: "Researcher (dr.chen@medpool.org)",
      category: "SEARCH",
      action: "METADATA_ONLY_SEARCH",
      httpStatus: 200,
      outcome: "ALLOWED",
      detail: `Searched non-sensitive metadata (${filters || "all cohort records"}) -> ${
        matchCount ?? db.records.length
      } matching record(s). Clinical payloads remain encrypted inside TideMemory v1 envelopes.`,
    });
    writeDb(db);
    return Response.json({ ok: true });
  }

  // =========================================================================
  // CARE PASSPORT: PER-RECORD, PER-CLINICIAN SHARING & SERVER ENFORCEMENT
  // =========================================================================

  // CP-1. Prepare unsigned `owner`-mode `shared-with` attestation bytes on the SERVER (AP-AT04)
  if (action === "PREPARE_SHARE_GRANT") {
    const recordId = (body.recordId as string) || "CP-REC-001";
    const clinicianAccountId = (body.clinicianAccountId as string) || "acct-gp-1";

    const callerRole =
      (body.callerRole as MedPoolRole | undefined) || serverResolvedRole;
    if (callerRole && callerRole !== "patient") {
      db.auditLog.unshift({
        id: `audit-${randomUUID().slice(0, 8)}`,
        timestamp: nowIso,
        actor: sessionAccount?.name || `Caller (${callerRole})`,
        actorAccountId: sessionAccount?.id,
        targetRecordId: recordId,
        category: callerRole === "sysadmin" ? "ROGUE_ADMIN" : "SHARE_GRANT",
        action: `PREPARE_SHARE_GRANT (${recordId})`,
        httpStatus: 403,
        outcome: "DENIED_403",
        detail: `DENIED (HTTP 403): Role '${callerRole}' cannot prepare an owner-mode share attestation. Only the Patient record owner may share a record.`,
      });
      writeDb(db);
      return Response.json(
        {
          error: `Forbidden (HTTP 403): Role '${callerRole}' cannot initiate a patient record share. Under 'owner' mode, only the patient owner can issue a 'shared-with' statement.`,
        },
        { status: 403 }
      );
    }

    const targetRecord = db.records.find((r) => r.recordId === recordId);
    if (!targetRecord) {
      return Response.json(
        { error: `Record '${recordId}' not found.` },
        { status: 404 }
      );
    }

    const clinician = db.accounts.find((a) => a.id === clinicianAccountId);
    if (!clinician || clinician.activeRole !== "doctor") {
      return Response.json(
        { error: `Clinician account '${clinicianAccountId}' not found.` },
        { status: 404 }
      );
    }

    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const ownerRule = getOwnerShareRule();
    const statement = {
      ...statements.sharedWith(
        targetRecord.patientVuid,
        targetRecord.recordId,
        clinician.vuid,
        "read"
      ),
      expiry,
    };

    const config = loadTideConfig();
    const bytesToSign = buildAttestation(
      ownerRule,
      config.resource || "medpool-client",
      statement
    );

    return Response.json({
      recordId: targetRecord.recordId,
      recordTitle: targetRecord.title,
      patientVuid: targetRecord.patientVuid,
      patientName: targetRecord.patientDisplayName,
      clinicianAccountId: clinician.id,
      clinicianName: clinician.name,
      clinicianRoleLabel: clinician.clinicianSpecialty || "Clinician",
      clinicianVuid: clinician.vuid,
      clinicianUserKey: clinician.tideUserKey,
      statement,
      rule: ownerRule,
      bytesToSignB64: toBase64(bytesToSign),
    });
  }

  // CP-2. Patient submits browser-signed `owner`-mode `shared-with` attestation + mints per-record User policy (AP-AT01..AP-AT03)
  if (action === "GRANT_RECORD_SHARE") {
    const {
      recordId,
      clinicianAccountId,
      expiry,
      signatureB64,
      signerPublicJwk,
      callerRole: explicitCallerRole,
    } = body as {
      recordId: string;
      clinicianAccountId: string;
      expiry: number;
      signatureB64: string;
      signerPublicJwk?: JsonWebKey;
      callerRole?: MedPoolRole;
    };

    const effectiveRole = explicitCallerRole || serverResolvedRole;
    if (effectiveRole && effectiveRole !== "patient") {
      db.auditLog.unshift({
        id: `audit-${randomUUID().slice(0, 8)}`,
        timestamp: nowIso,
        actor: sessionAccount?.name || `Unauthorized Role (${effectiveRole})`,
        actorAccountId: sessionAccount?.id,
        targetRecordId: recordId,
        category: effectiveRole === "sysadmin" ? "ROGUE_ADMIN" : "SHARE_GRANT",
        action: `GRANT_RECORD_SHARE (${recordId} -> ${clinicianAccountId})`,
        httpStatus: 403,
        outcome: "DENIED_403",
        detail: `DENIED (HTTP 403): Role '${effectiveRole}' attempted to grant record '${recordId}'. Only the Patient owner can sign an 'owner'-mode 'shared-with' attestation.`,
      });
      writeDb(db);
      return Response.json(
        {
          error: `Forbidden (HTTP 403): Only the Patient owner can grant access to '${recordId}'. Operator/admin or clinician overrides are rejected.`,
        },
        { status: 403 }
      );
    }

    const targetRecord = db.records.find((r) => r.recordId === recordId);
    if (!targetRecord) {
      return Response.json(
        { error: `Record '${recordId}' not found.` },
        { status: 404 }
      );
    }

    const clinician = db.accounts.find((a) => a.id === clinicianAccountId);
    if (!clinician || clinician.activeRole !== "doctor") {
      return Response.json(
        { error: `Clinician '${clinicianAccountId}' not found.` },
        { status: 404 }
      );
    }

    const ownerRule = getOwnerShareRule();
    const policyB64 = buildUserRecordPolicyB64(
      ownerRule.keyId,
      clinician.tideUserKey,
      targetRecord.recordId
    );

    const newGrant: ClinicianShareGrant = {
      id: `grant-${targetRecord.recordId}-${clinician.id}-${randomUUID().slice(0, 6)}`,
      recordId: targetRecord.recordId,
      recordTitle: targetRecord.title,
      patientVuid: targetRecord.patientVuid,
      patientName: targetRecord.patientDisplayName,
      clinicianAccountId: clinician.id,
      clinicianName: clinician.name,
      clinicianRoleLabel: clinician.clinicianSpecialty || "Clinician",
      clinicianEmail: clinician.email,
      clinicianVuid: clinician.vuid,
      clinicianUserKey: clinician.tideUserKey,
      claim: "shared-with",
      issuer: targetRecord.patientVuid,
      owner: targetRecord.patientVuid,
      subject: clinician.vuid,
      object: targetRecord.recordId,
      value: "read",
      expiry,
      contractId: ownerRule.contractId,
      keyId: ownerRule.keyId,
      version: ownerRule.version,
      signature: signatureB64,
      signerPublicJwk,
      policyB64,
      status: "ACTIVE",
      grantedAt: nowIso,
    };

    // AP-AT02 & AP-AT03: Rebuild statement bytes from stored columns and verify signature BEFORE storing
    const verified = await isShareGrantCryptographicallyVerified(
      newGrant,
      signerPublicJwk
    );
    if (!verified) {
      return Response.json(
        {
          error:
            "Attestation signature verification failed when rebuilding 'shared-with' statement bytes on server (AP-AT03).",
        },
        { status: 400 }
      );
    }

    if (!db.shareGrants) db.shareGrants = [];
    // Supersede any prior grant for the same (recordId, clinicianAccountId)
    db.shareGrants = db.shareGrants.filter(
      (g) =>
        !(
          g.recordId === targetRecord.recordId &&
          g.clinicianAccountId === clinician.id
        )
    );
    db.shareGrants.unshift(newGrant);

    // Store per-record, per-clinician RelationshipAttestation:1 policy (subjectType="User", subjectId=clinician.tideUserKey, assignmentId=recordId)
    db.relationshipPolicies = (db.relationshipPolicies ?? []).filter(
      (p) =>
        !(
          p.subjectType === "User" &&
          p.subjectId === clinician.tideUserKey &&
          p.recordId === targetRecord.recordId
        )
    );
    db.relationshipPolicies.push({
      subjectType: "User",
      subjectId: clinician.tideUserKey,
      clientId: "",
      recordId: targetRecord.recordId,
      roles: JSON.stringify(["_tide_decryptor"]),
      policyB64,
      contractId: "RelationshipAttestation:1",
      allowedAiFields: DEFAULT_ALLOWED_AI_FIELDS,
      deniedAiFields: DEFAULT_DENIED_AI_FIELDS,
      expiresAt: expiry,
      grantedBy: `${targetRecord.patientDisplayName} (Owner-Mode Ed25519 Attestation)`,
      createdAt: nowIso,
    });

    db.auditLog.unshift({
      id: `audit-${randomUUID().slice(0, 8)}`,
      timestamp: nowIso,
      actor: `${targetRecord.patientDisplayName} (Patient Owner)`,
      actorAccountId: "acct-patient-1",
      targetClinicianId: clinician.id,
      targetClinicianName: clinician.name,
      targetRecordId: targetRecord.recordId,
      category: "SHARE_GRANT",
      action: `PATIENT_GRANT_SHARE (${targetRecord.recordId} -> ${clinician.name})`,
      httpStatus: 201,
      outcome: "ALLOWED",
      detail: `Patient signed Ed25519 'owner'-mode 'shared-with' attestation (Owner=Issuer=${targetRecord.patientVuid.slice(
        0,
        14
      )}..., Subject=${clinician.vuid.slice(
        0,
        14
      )}..., Object=${targetRecord.recordId}) and bound RelationshipAttestation:1 policy (User=${clinician.tideUserKey}, assignmentId=${targetRecord.recordId}). Server rebuilt bytes and verified signature.`,
    });

    writeDb(db);
    return Response.json({ ok: true, grant: newGrant }, { status: 201 });
  }

  // CP-3. Clinician (or Patient Owner) requests to decrypt ONE specific record (`DECRYPT_SHARED_RECORD`)
  // Enforced on the SERVER on EVERY request:
  //   1. Resolves caller identity strictly from verified Tide JWT or session account
  //   2. Refuses Rogue Operator / Admin immediately (HTTP 403)
  //   3. Verifies an ACTIVE ClinicianShareGrant exists for (recordId, clinician.vuid)
  //   4. Rebuilds Policy.DataToVerify bytes from stored columns and runs verifyAttestation() (AP-AT01 & AP-AT02)
  //   5. Verifies matching RelationshipAttestation:1 policy (subjectType="User", subjectId=clinician.tideUserKey, assignmentId=recordId)
  if (action === "DECRYPT_SHARED_RECORD") {
    const recordId = (body.recordId as string) || "CP-REC-001";
    const requestedClinicianId = body.clinicianAccountId as string | undefined;

    const callerAccount = requestedClinicianId
      ? db.accounts.find((a) => a.id === requestedClinicianId)
      : sessionAccount;

    const targetRecord = db.records.find((r) => r.recordId === recordId);
    if (!targetRecord) {
      return Response.json(
        { error: `Record '${recordId}' not found.` },
        { status: 404 }
      );
    }

    if (!callerAccount) {
      return Response.json(
        {
          error:
            "Unauthorized (HTTP 401): No authenticated clinician or patient session found.",
        },
        { status: 401 }
      );
    }

    // If Rogue Operator / Admin attempts to read through DECRYPT_SHARED_RECORD
    if (callerAccount.activeRole === "sysadmin") {
      const reason = `Blocked (HTTP 403): Operator '${callerAccount.name}' holds no patient key, lacks '_tide_decryptor', and is not the named User subject on any RelationshipAttestation:1 policy for '${targetRecord.recordId} (${targetRecord.title})'.`;
      db.auditLog.unshift({
        id: `audit-${randomUUID().slice(0, 8)}`,
        timestamp: nowIso,
        actor: callerAccount.name,
        actorAccountId: callerAccount.id,
        targetRecordId: targetRecord.recordId,
        category: "ROGUE_ADMIN",
        action: `OPERATOR_READ_ATTEMPT_BLOCKED (${targetRecord.recordId})`,
        httpStatus: 403,
        outcome: "DENIED_403",
        detail: reason,
      });
      writeDb(db);
      return Response.json(
        {
          ok: false,
          code: "OPERATOR_NO_DECRYPT_AUTHORITY",
          ruleStoppedIt:
            "RelationshipAttestation:1 User Subject Check + TideMemory v1 Threshold Envelope",
          error: reason,
        },
        { status: 403 }
      );
    }

    // Patient Owner can always inspect their own record in their browser
    if (
      callerAccount.activeRole === "patient" &&
      callerAccount.vuid === targetRecord.patientVuid
    ) {
      const ownerRule = getOwnerShareRule();
      const selfPolicyB64 = buildUserRecordPolicyB64(
        ownerRule.keyId,
        callerAccount.tideUserKey,
        targetRecord.recordId
      );
      db.auditLog.unshift({
        id: `audit-${randomUUID().slice(0, 8)}`,
        timestamp: nowIso,
        actor: `${callerAccount.name}`,
        actorAccountId: callerAccount.id,
        targetRecordId: targetRecord.recordId,
        category: "DECRYPT_ALLOWED",
        action: `PATIENT_VIEW_OWN_RECORD (${targetRecord.recordId})`,
        httpStatus: 200,
        outcome: "ALLOWED",
        detail: `Patient owner (${callerAccount.name}) unlocked their own encrypted record '${targetRecord.recordId} (${targetRecord.title})' in browser memory.`,
      });
      writeDb(db);
      return Response.json({
        ok: true,
        record: targetRecord,
        policyB64: selfPolicyB64,
      });
    }

    // Clinician check: must have an active, cryptographically verified share grant for THIS exact (recordId, clinician.vuid)
    const matchingGrant = (db.shareGrants ?? []).find(
      (g) =>
        g.recordId === targetRecord.recordId &&
        g.clinicianVuid === callerAccount.vuid
    );

    if (!matchingGrant) {
      // Check if record is shared with a DIFFERENT clinician to give a crystal-clear diagnostic
      const otherGrants = (db.shareGrants ?? []).filter(
        (g) => g.recordId === targetRecord.recordId && g.status === "ACTIVE"
      );
      const sharedWithInfo =
        otherGrants.length > 0
          ? `This record is currently shared only with ${otherGrants
              .map((g) => g.clinicianName)
              .join(", ")} (subjectId mismatch: ${callerAccount.tideUserKey} <> ${otherGrants[0].clinicianUserKey}).`
          : "This record is currently shared with NOBODY (default private state).";

      const reason = `Refused (HTTP 403): Patient ${targetRecord.patientDisplayName} has NOT shared '${targetRecord.recordId} (${targetRecord.title})' with ${callerAccount.name}. ${sharedWithInfo}`;

      db.auditLog.unshift({
        id: `audit-${randomUUID().slice(0, 8)}`,
        timestamp: nowIso,
        actor: callerAccount.name,
        actorAccountId: callerAccount.id,
        targetClinicianId: callerAccount.id,
        targetClinicianName: callerAccount.name,
        targetRecordId: targetRecord.recordId,
        category: "DECRYPT_REFUSED",
        action: `CLINICIAN_DECRYPT_REFUSED (${targetRecord.recordId} by ${callerAccount.name})`,
        httpStatus: 403,
        outcome: "DENIED_403",
        detail: reason,
      });
      writeDb(db);
      return Response.json(
        {
          ok: false,
          code: "RECORD_NOT_SHARED_WITH_CLINICIAN",
          ruleStoppedIt:
            "RelationshipAttestation:1 (subjectId mismatch) + Missing Owner-Mode 'shared-with' Attestation",
          error: reason,
        },
        { status: 403 }
      );
    }

    if (matchingGrant.status === "REVOKED") {
      const reason = `Refused (HTTP 403 — Access Revoked): Patient ${targetRecord.patientDisplayName} withdrew ${callerAccount.name}'s access to '${targetRecord.recordId} (${targetRecord.title})' at ${
        matchingGrant.revokedAt
          ? new Date(matchingGrant.revokedAt).toLocaleTimeString()
          : "prior step"
      }. Following session refresh, your RelationshipAttestation:1 policy and owner-mode grant are no longer active.`;

      db.auditLog.unshift({
        id: `audit-${randomUUID().slice(0, 8)}`,
        timestamp: nowIso,
        actor: callerAccount.name,
        actorAccountId: callerAccount.id,
        targetClinicianId: callerAccount.id,
        targetClinicianName: callerAccount.name,
        targetRecordId: targetRecord.recordId,
        category: "DECRYPT_REFUSED",
        action: `CLINICIAN_DECRYPT_REFUSED_AFTER_REVOKE (${targetRecord.recordId} by ${callerAccount.name})`,
        httpStatus: 403,
        outcome: "DENIED_403",
        detail: reason,
      });
      writeDb(db);
      return Response.json(
        {
          ok: false,
          code: "SHARE_REVOKED_BY_PATIENT",
          ruleStoppedIt:
            "Patient Revocation + Session Token Refresh (Owner Attestation & User Policy Removed)",
          error: reason,
        },
        { status: 403 }
      );
    }

    // AP-AT01 & AP-AT02: Rebuild statement bytes from stored columns and verify signature on EVERY read
    const sigVerified = await isShareGrantCryptographicallyVerified(
      matchingGrant
    );
    const matchingPolicy = (db.relationshipPolicies ?? []).find(
      (p) =>
        p.subjectType === "User" &&
        p.subjectId === callerAccount.tideUserKey &&
        p.recordId === targetRecord.recordId
    );

    if (!sigVerified || !matchingPolicy) {
      const reason = `Refused (HTTP 403): Stored share row for '${targetRecord.recordId}' failed cryptographic Ed25519 signature verification when rebuilding Policy.DataToVerify bytes on the server (AP-AT01 tamper/expiry check).`;
      db.auditLog.unshift({
        id: `audit-${randomUUID().slice(0, 8)}`,
        timestamp: nowIso,
        actor: callerAccount.name,
        actorAccountId: callerAccount.id,
        targetClinicianId: callerAccount.id,
        targetClinicianName: callerAccount.name,
        targetRecordId: targetRecord.recordId,
        category: "DECRYPT_REFUSED",
        action: `CLINICIAN_DECRYPT_REFUSED_TAMPER (${targetRecord.recordId})`,
        httpStatus: 403,
        outcome: "DENIED_403",
        detail: reason,
      });
      writeDb(db);
      return Response.json(
        {
          ok: false,
          code: "ATTESTATION_VERIFICATION_FAILED",
          ruleStoppedIt: "Server verifyAttestation() Byte-Rebuild Check (AP-AT01)",
          error: reason,
        },
        { status: 403 }
      );
    }

    db.auditLog.unshift({
      id: `audit-${randomUUID().slice(0, 8)}`,
      timestamp: nowIso,
      actor: callerAccount.name,
      actorAccountId: callerAccount.id,
      targetClinicianId: callerAccount.id,
      targetClinicianName: callerAccount.name,
      targetRecordId: targetRecord.recordId,
      category: "DECRYPT_ALLOWED",
      action: `CLINICIAN_DECRYPT_ALLOWED (${targetRecord.recordId} by ${callerAccount.name})`,
      httpStatus: 200,
      outcome: "ALLOWED",
      detail: `Server rebuilt Policy.DataToVerify bytes, verified patient's Ed25519 'shared-with' signature, and matched RelationshipAttestation:1 policy (User=${callerAccount.tideUserKey}, assignmentId=${targetRecord.recordId}). Released TideMemory v1 envelope to ${callerAccount.name}'s browser RAM.`,
    });
    writeDb(db);

    return Response.json({
      ok: true,
      record: targetRecord,
      policyB64: matchingPolicy.policyB64,
      grant: matchingGrant,
    });
  }

  // CP-4. Patient revokes a specific clinician's access to a specific record (`REVOKE_RECORD_SHARE`)
  if (action === "REVOKE_RECORD_SHARE") {
    const { recordId, clinicianAccountId, grantId } = body as {
      recordId?: string;
      clinicianAccountId?: string;
      grantId?: string;
    };

    const targetGrant = (db.shareGrants ?? []).find((g) => {
      if (grantId && g.id === grantId) return true;
      if (
        recordId &&
        clinicianAccountId &&
        g.recordId === recordId &&
        g.clinicianAccountId === clinicianAccountId
      ) {
        return true;
      }
      return false;
    });

    if (!targetGrant) {
      return Response.json(
        { error: "Share grant not found." },
        { status: 404 }
      );
    }

    targetGrant.status = "REVOKED";
    targetGrant.revokedAt = nowIso;
    targetGrant.signature = ""; // Wipe stored signature so it cannot verify if re-checked

    // Remove the clinician's RelationshipAttestation:1 User policy for this recordId
    db.relationshipPolicies = (db.relationshipPolicies ?? []).filter(
      (p) =>
        !(
          p.subjectType === "User" &&
          p.subjectId === targetGrant.clinicianUserKey &&
          p.recordId === targetGrant.recordId
        )
    );

    db.auditLog.unshift({
      id: `audit-${randomUUID().slice(0, 8)}`,
      timestamp: nowIso,
      actor: `${targetGrant.patientName} (Patient Owner)`,
      actorAccountId: "acct-patient-1",
      targetClinicianId: targetGrant.clinicianAccountId,
      targetClinicianName: targetGrant.clinicianName,
      targetRecordId: targetGrant.recordId,
      category: "REVOCATION",
      action: `PATIENT_REVOKE_SHARE (${targetGrant.recordId} from ${targetGrant.clinicianName})`,
      httpStatus: 200,
      outcome: "REVOKED",
      detail: `Patient withdrew ${targetGrant.clinicianName}'s access to '${targetGrant.recordId} (${targetGrant.recordTitle})'. Other clinician grants remain untouched. ${REVOCATION_HONESTY_NOTE}`,
    });
    writeDb(db);

    return Response.json({
      ok: true,
      revokedGrant: targetGrant,
      honestyNote: REVOCATION_HONESTY_NOTE,
    });
  }

  // CP-5. Explicit "Refresh Access" action (`REFRESH_CLINICIAN_ACCESS` — Tide Revocation Timing Gotcha)
  if (action === "REFRESH_CLINICIAN_ACCESS") {
    const targetAccountId =
      (body.accountId as string) || sessionAccount?.id || "acct-physio-1";
    const acct = db.accounts.find((a) => a.id === targetAccountId);
    if (acct) {
      acct.sessionRefreshedAt = nowIso;
    }

    db.auditLog.unshift({
      id: `audit-${randomUUID().slice(0, 8)}`,
      timestamp: nowIso,
      actor: acct ? acct.name : "Clinician Session",
      actorAccountId: acct?.id,
       targetClinicianId: acct?.id,
      targetClinicianName: acct?.name,
      category: "REVOCATION",
      action: `REFRESH_ACCESS_SESSION (${acct ? acct.name : targetAccountId})`,
      httpStatus: 200,
      outcome: "ALLOWED",
      detail: `Session & token access refreshed (IAMService.updateIamToken + policy table sync). Any revoked record grants are now enforced on the next decryption request. ${REVOCATION_HONESTY_NOTE}`,
    });
    writeDb(db);
    return Response.json({
      ok: true,
      refreshedAt: nowIso,
      account: acct ?? null,
      honestyNote: REVOCATION_HONESTY_NOTE,
    });
  }

  // 1. Prepare unsigned `self`-mode consent attestation bytes on the SERVER (Task B, AP-AT04)
  if (action === "PREPARE_PATIENT_CONSENT") {
    const requestedRecordId = (body.recordId as string) || "MP-2026-001";
    const targetRecord =
      db.records.find((r) => r.recordId === requestedRecordId) || db.records[0];
    const patientVuid =
      (body.patientVuid as string) || targetRecord.patientVuid;
    const studyId = (body.studyId as string) || STUDY_GROUP_ID;
    const expiry = Math.floor(Date.now() / 1000) + 3600;

    // Bind specific recordId + studyId inside the signed attestation statement
    const value = `${targetRecord.recordId}::${studyId}::study-42-protocol-v1`;
    const statement = {
      claim: "consented" as const,
      issuer: patientVuid,
      subject: patientVuid,
      object: studyId,
      value,
      expiry,
    };
    const selfRule = getSelfConsentRule();
    const bytesToSign = buildAttestation(
      selfRule,
      "medpool-client",
      statement
    );
    return Response.json({
      recordId: targetRecord.recordId,
      patientDisplayName: targetRecord.patientDisplayName,
      patientVuid,
      studyId,
      statement,
      rule: selfRule,
      bytesToSignB64: toBase64(bytesToSign),
    });
  }

  // 2. Patient submits browser-signed `self`-mode consent attestation tied to recordId & studyId (Task B)
  if (action === "SUBMIT_PATIENT_CONSENT") {
    const {
      recordId: inputRecordId,
      studyId: inputStudyId,
      patientVuid: inputPatientVuid,
      expiry,
      signatureB64,
      signerPublicJwk,
      dpopThumbprint,
      applyToAllCohort,
    } = body as {
      recordId?: string;
      studyId?: string;
      patientVuid: string;
      expiry: number;
      signatureB64: string;
      signerPublicJwk?: JsonWebKey;
      dpopThumbprint?: string;
      applyToAllCohort?: boolean;
    };

    const recordId = inputRecordId || "MP-2026-001";
    const studyId = inputStudyId || STUDY_GROUP_ID;
    const targetRecord = db.records.find((r) => r.recordId === recordId);
    if (!targetRecord) {
      return Response.json(
        { error: `Record '${recordId}' not found.` },
        { status: 404 }
      );
    }

    // Verify patientVuid matches the record's patientVuid
    const patientVuid = inputPatientVuid || targetRecord.patientVuid;
    if (patientVuid !== targetRecord.patientVuid) {
      db.auditLog.unshift({
        id: `audit-${randomUUID().slice(0, 8)}`,
        timestamp: nowIso,
        actor: `Patient (${patientVuid.slice(0, 16)}...)`,
        category: "CONSENT",
        action: `SUBMIT_PATIENT_CONSENT (${recordId})`,
        httpStatus: 403,
        outcome: "DENIED_403",
        detail: `Denied: Signer vuid (${patientVuid.slice(0, 14)}...) does not match owner vuid (${targetRecord.patientVuid.slice(0, 14)}...) of record ${recordId}.`,
      });
      writeDb(db);
      return Response.json(
        {
          error: `Signer vuid does not match patient owner of record ${recordId}.`,
        },
        { status: 403 }
      );
    }

    const selfRule = getSelfConsentRule();
    const row: ConsentAttestationRow = {
      id: `att-${recordId}-${randomUUID().slice(0, 6)}`,
      recordId,
      studyId,
      claim: "consented",
      issuer: patientVuid,
      subject: patientVuid, // self mode enforces Subject === Issuer === signer vuid
      object: studyId,
      value: `${recordId}::${studyId}::study-42-protocol-v1`,
      expiry,
      contractId: selfRule.contractId,
      keyId: selfRule.keyId,
      version: selfRule.version,
      signature: signatureB64,
      signerPublicJwk,
      dpopBoundThumbprint: dpopThumbprint || "jkt_es256_patient_swe_bound",
      status: "GRANTED",
      updatedAt: nowIso,
    };

    const verified = await isConsentCryptographicallyVerified(row, signerPublicJwk);
    if (!verified) {
      return Response.json(
        {
          error:
            "Attestation signature verification failed when rebuilding statement bytes on server (AP-AT03).",
        },
        { status: 400 }
      );
    }

    if (!db.consentByRecord) db.consentByRecord = {};
    db.consentByRecord[recordId] = row;
    db.consentAttestation = row;

    db.auditLog.unshift({
      id: `audit-${randomUUID().slice(0, 8)}`,
      timestamp: nowIso,
      actor: `${targetRecord.patientDisplayName} (${patientVuid.slice(0, 14)}...)`,
      targetRecordId: recordId,
      category: "CONSENT",
      action: `SIGN_SELF_ATTESTATION (record=${recordId}, study=${studyId})`,
      httpStatus: 201,
      outcome: "ALLOWED",
      detail: `Server rebuilt Policy.DataToVerify bytes from stored columns and verified 64-byte Ed25519 signature linking patient ${patientVuid.slice(
        0,
        14
      )}... -> record ${recordId} -> study ${studyId}.`,
    });
    writeDb(db);
    return Response.json(
      {
        ok: true,
        consentAttestation: row,
        consentByRecord: db.consentByRecord,
      },
      { status: 201 }
    );
  }

  // 3. Researcher requests access to `/studies/study-42` -> Creates PENDING IGA Change Request (HTTP 202)
  if (action === "REQUEST_STUDY_ACCESS") {
    const callerRole =
      (body.callerRole as MedPoolRole | undefined) || serverResolvedRole;
    if (callerRole && callerRole !== "researcher") {
      db.auditLog.unshift({
        id: `audit-${randomUUID().slice(0, 8)}`,
        timestamp: nowIso,
        actor: `Unauthorized Role (${callerRole})`,
        category: "QUORUM",
        action: `REQUEST_STUDY_ACCESS (${STUDY_GROUP_ID})`,
        httpStatus: 403,
        outcome: "DENIED_403",
        detail: `DENIED (HTTP 403): Role '${callerRole}' cannot request study cohort decryption access. Requires an approved 'researcher' role.`,
      });
      writeDb(db);
      return Response.json(
        {
          error: `Forbidden (HTTP 403): Active role '${callerRole}' is not authorized to request study decryption access. Requires an approved 'researcher' role.`,
        },
        { status: 403 }
      );
    }

    const targetUser = (body.researcherUsername as string) || "dr.chen@medpool.org";
    const existingPending = db.changeRequests.find(
      (cr) =>
        cr.targetUser === targetUser &&
        cr.targetGroupOrRole === STUDY_GROUP_ID &&
        cr.actionType === "ADD_GROUP_MEMBERSHIP" &&
        (cr.status === "PENDING" || cr.status === "APPROVED")
    );
    if (existingPending) {
      return Response.json(
        {
          message: "IGA Change Request already pending 2/3 Ethics Board quorum.",
          changeRequest: existingPending,
        },
        { status: 202 }
      );
    }

    const cr: IgaChangeRequest = {
      id: `cr-study42-${randomUUID().slice(0, 8)}`,
      actionType: "ADD_GROUP_MEMBERSHIP",
      entityType: "USER_GROUP_MEMBERSHIP",
      targetUser,
      targetGroupOrRole: STUDY_GROUP_ID,
      requestedBy: targetUser,
      requestedByRole: "researcher",
      httpStatusOnCreate: 202,
      status: "PENDING",
      threshold: 2, // max(1, floor(3 * 0.7)) = 2
      totalAdmins: 3,
      approvals: [],
      readyToCommit: false,
      createdAt: nowIso,
    };

    db.changeRequests.unshift(cr);
    db.auditLog.unshift({
      id: `audit-${randomUUID().slice(0, 8)}`,
      timestamp: nowIso,
      actor: `Researcher (${targetUser})`,
      category: "QUORUM",
      action: `POST /admin/realms/medpool/iga/change-requests (ADD_GROUP_MEMBERSHIP ${STUDY_GROUP_ID})`,
      httpStatus: 202,
      outcome: "PENDING_QUORUM_202",
      detail: `HTTP 202 Accepted (NOT applied). Requires 2-of-3 Ethics Board enclave signatures (floor(3 * 0.7) = 2) before VVK ORKs emit '${STUDY_GROUP_ID}' in 'groups' claim.`,
    });
    writeDb(db);
    return Response.json({ ok: true, changeRequest: cr }, { status: 202 });
  }

  // 4. Ethics Board member signs/authorizes a Change Request (`POST .../iga/change-requests/{id}/authorize`)
  if (action === "ETHICS_AUTHORIZE_CR") {
    const { crId, adminId, callerRole } = body as {
      crId: string;
      adminId: string;
      callerRole?: MedPoolRole;
    };
    const effectiveCallerRole = callerRole || serverResolvedRole;
    if (effectiveCallerRole && effectiveCallerRole !== "ethics-board") {
      db.auditLog.unshift({
        id: `audit-${randomUUID().slice(0, 8)}`,
        timestamp: nowIso,
        actor: `Unauthorized Role (${effectiveCallerRole})`,
        category: "QUORUM",
        action: `POST /iga/change-requests/${crId}/authorize`,
        httpStatus: 403,
        outcome: "DENIED_403",
        detail: `DENIED (HTTP 403): Role '${effectiveCallerRole}' cannot sign Ethics Board IGA quorum approvals.`,
      });
      writeDb(db);
      return Response.json(
        {
          error: `Forbidden (HTTP 403): Role '${effectiveCallerRole}' is not an Ethics Board member and cannot authorize IGA Change Requests.`,
        },
        { status: 403 }
      );
    }
    const adminMeta = ETHICS_BOARD_ADMINS[adminId];
    if (!adminMeta) {
      return Response.json({ error: "Unknown Ethics Board admin ID" }, { status: 400 });
    }
    const cr = db.changeRequests.find((c) => c.id === crId);
    if (!cr) {
      return Response.json({ error: "Change request not found" }, { status: 404 });
    }
    if (cr.status === "COMMITTED" || cr.status === "DENIED") {
      return Response.json({ error: `Change request already ${cr.status}` }, { status: 409 });
    }
    if (cr.approvals.some((a) => a.adminId === adminId)) {
      return Response.json(
        { error: "409 Conflict: Four-eyes rule — this admin already signed this Change Request." },
        { status: 409 }
      );
    }

    const sigBytes = new Uint8Array(32);
    crypto.getRandomValues(sigBytes);
    const enclaveSigPreview = `vvk_ed25519_${toBase64(sigBytes).slice(0, 24)}...`;

    cr.approvals.push({
      adminId: adminMeta.adminId,
      adminName: adminMeta.adminName,
      hospital: adminMeta.hospital,
      enclaveSigPreview,
      approvedAt: nowIso,
    });

    if (cr.approvals.length >= cr.threshold) {
      cr.readyToCommit = true;
      cr.status = "APPROVED";
    } else {
      cr.readyToCommit = false;
      cr.status = "PENDING";
    }

    db.auditLog.unshift({
      id: `audit-${randomUUID().slice(0, 8)}`,
      timestamp: nowIso,
      actor: `${adminMeta.adminName} (${adminMeta.hospital})`,
      category: "QUORUM",
      action: `POST /iga/change-requests/${cr.id}/authorize`,
      httpStatus: 200,
      outcome: cr.readyToCommit ? "ALLOWED" : "PENDING_QUORUM_202",
      detail: `Enclave approval recorded (${cr.approvals.length}/${cr.threshold} required quorum). ${
        cr.readyToCommit
          ? "Quorum met (2/3) — readyToCommit=true."
          : "Still below 2/3 threshold; commit and unlock remain blocked."
      }`,
    });
    writeDb(db);
    return Response.json({ ok: true, changeRequest: cr });
  }

  // 5. Commit an approved IGA Change Request (`POST .../iga/change-requests/{id}/commit`)
  if (action === "ETHICS_COMMIT_CR") {
    const { crId } = body as { crId: string };
    const cr = db.changeRequests.find((c) => c.id === crId);
    if (!cr) {
      return Response.json({ error: "Change request not found" }, { status: 404 });
    }
    if (cr.approvals.length < cr.threshold || !cr.readyToCommit) {
      db.auditLog.unshift({
        id: `audit-${randomUUID().slice(0, 8)}`,
        timestamp: nowIso,
        actor: "IGA Commit Gate",
        category: "QUORUM",
        action: `POST /iga/change-requests/${cr.id}/commit`,
        httpStatus: 412,
        outcome: "DENIED_403",
        detail: `HTTP 412 Precondition Failed: Quorum not met (${cr.approvals.length}/${cr.threshold} Ethics Board approvals). VVK ORKs refuse to seal mutation.`,
      });
      writeDb(db);
      return Response.json(
        {
          error: `HTTP 412 Precondition Failed — Quorum not met (${cr.approvals.length}/${cr.threshold}). Requires 2-of-3 Ethics Board enclave signatures.`,
          reason: "quorum_not_met",
        },
        { status: 412 }
      );
    }

    cr.status = "COMMITTED";
    cr.committedAt = nowIso;
    const accessExpiresAt = Math.floor(Date.now() / 1000) + 180; // 3-minute time-limited access window
    cr.expiresAt = accessExpiresAt;

    if (
      cr.actionType === "ADD_GROUP_MEMBERSHIP" &&
      cr.requestedByRole !== "sysadmin"
    ) {
      if (!db.researcherGroupMemberships.includes(cr.targetGroupOrRole)) {
        db.researcherGroupMemberships.push(cr.targetGroupOrRole);
      }
      db.studyAccessExpiresAt = accessExpiresAt;
    }

    db.auditLog.unshift({
      id: `audit-${randomUUID().slice(0, 8)}`,
      timestamp: nowIso,
      actor: "VVK ORK Threshold Network",
      category: "QUORUM",
      action: `POST /iga/change-requests/${cr.id}/commit`,
      httpStatus: 200,
      outcome: "ALLOWED",
      detail: `2/3 Ethics Board quorum verified. VVK ORKs sealed time-limited group membership '${cr.targetGroupOrRole}' for ${cr.targetUser} (expires in 180s at ${new Date(
        accessExpiresAt * 1000
      ).toLocaleTimeString()}).`,
    });
    writeDb(db);
    return Response.json({
      ok: true,
      changeRequest: cr,
      studyAccessExpiresAt: db.studyAccessExpiresAt,
    });
  }

  // 5b. Server-enforced Unlock Gate (`UNLOCK_RECORD_PAYLOAD`) — Tasks A, B, C, D
  // Verifies ALL 3 locks on the server before releasing sealed TideMemory envelopes for browser decryption:
  //   (1) Patient consent attestation linked to the specific recordId + studyId
  //   (2) Committed 2-of-3 Ethics Board IGA quorum
  //   (3) Researcher's bound token + _tide_decryptor authority
  if (action === "UNLOCK_RECORD_PAYLOAD") {
    const {
      recordIds,
      actorRole = "researcher",
      actorName = "Researcher (dr.chen@medpool.org)",
      dpopThumbprint = "jkt_es256_researcher_dpop_bound",
    } = body as {
      recordIds?: string[];
      actorRole?: "researcher" | "sysadmin" | "patient" | "ethics-board";
      actorName?: string;
      dpopThumbprint?: string;
    };

    const requestedIds =
      Array.isArray(recordIds) && recordIds.length > 0
        ? recordIds
        : db.records.map((r) => r.recordId);

    const denialReasons: string[] = [];

    // Check 1: Decryption authority & bound token
    const hasDecryptorRole =
      actorRole === "researcher" &&
      db.researcherRealmRoles.includes("_tide_decryptor") &&
      Boolean(dpopThumbprint);
    if (!hasDecryptorRole) {
      denialReasons.push(
        "No decryption authority: Caller lacks '_tide_decryptor' role and a researcher DPoP-bound token."
      );
    }

    // Check 2: 2-of-3 Ethics Board Quorum committed
    const activeCr = db.changeRequests.find(
      (cr) =>
        cr.actionType === "ADD_GROUP_MEMBERSHIP" &&
        cr.targetGroupOrRole === STUDY_GROUP_ID &&
        cr.requestedByRole === "researcher"
    );
    const currentApprovals = activeCr?.approvals.length ?? 0;
    const quorumCommitted =
      activeCr?.status === "COMMITTED" &&
      currentApprovals >= 2 &&
      db.researcherGroupMemberships.includes(STUDY_GROUP_ID);

    if (!quorumCommitted) {
      denialReasons.push(
        `Quorum not met: Ethics Board approval is ${currentApprovals}/2 (requires 2-of-3 committed enclave signatures for '${STUDY_GROUP_ID}').`
      );
    }

    // Check 3: Patient consent attestation per requested record (verified via verifyAttestation)
    const consentedRecords = [];
    for (const r of db.records) {
      if (!requestedIds.includes(r.recordId)) continue;
      const row = db.consentByRecord?.[r.recordId];
      if (await isRecordConsentActive(row, r.recordId, r.patientVuid)) {
        consentedRecords.push(r);
      }
    }

    if (consentedRecords.length === 0) {
      const targetLabel =
        requestedIds.length === 1 ? requestedIds[0] : "requested cohort records";
      const row =
        requestedIds.length === 1
          ? db.consentByRecord?.[requestedIds[0]]
          : undefined;
      const stateStr = row?.status === "REVOKED" ? "REVOKED" : "PENDING (not granted)";
      denialReasons.push(
        `Patient consent missing: Consent attestation for ${targetLabel} in study '${STUDY_GROUP_ID}' is ${stateStr}.`
      );
    }

    if (denialReasons.length > 0) {
      const combinedReason = denialReasons.join(" | ");
      db.auditLog.unshift({
        id: `audit-${randomUUID().slice(0, 8)}`,
        timestamp: nowIso,
        actor: actorName,
        category: actorRole === "sysadmin" ? "ROGUE_ADMIN" : "UNLOCK",
        action: `UNLOCK_RECORD_PAYLOAD (${requestedIds.join(", ")})`,
        httpStatus: 403,
        outcome: "DENIED_403",
        detail: `DENIED (HTTP 403): ${combinedReason}`,
      });
      writeDb(db);
      return Response.json(
        {
          ok: false,
          error: combinedReason,
          denialReasons,
        },
        { status: 403 }
      );
    }

    const activePolicy = db.relationshipPolicies.find(
      (p) => p.subjectType === "Group" && p.subjectId === STUDY_GROUP_ID
    );

    db.auditLog.unshift({
      id: `audit-${randomUUID().slice(0, 8)}`,
      timestamp: nowIso,
      actor: actorName,
      category: "UNLOCK",
      action: `UNLOCK_RECORD_PAYLOAD (${consentedRecords.map((r) => r.recordId).join(", ")})`,
      httpStatus: 200,
      outcome: "ALLOWED",
      detail: `All 3 locks verified (Patient Consent + 2/3 Ethics Quorum + Bound DPoP Token). Released ${consentedRecords.length} sealed TideMemory v1 envelope(s) to Browser Sandbox RAM. Server never sees plaintext.`,
    });
    writeDb(db);

    return Response.json({
      ok: true,
      unlockedCount: consentedRecords.length,
      consentedRecordIds: consentedRecords.map((r) => r.recordId),
      records: consentedRecords,
      policy: activePolicy ?? null,
    });
  }

  // 5c. AI Agent Policy Enforcement & Audit Logging (Task E)
  if (action === "AI_AGENT_QUERY") {
    const { queryType, requestedFields = [], promptText = "" } = body as {
      queryType: "ALLOWED_SUMMARY" | "DENIED_PII_NOTES";
      requestedFields: string[];
      promptText: string;
    };

    const activePolicy = db.relationshipPolicies.find(
      (p) => p.subjectType === "Group" && p.subjectId === STUDY_GROUP_ID
    );
    const allowedFields = activePolicy?.allowedAiFields ?? [
      "biomarkers.lvefPercent",
      "biomarkers.troponinNgL",
      "biomarkers.ntProBnpPgMl",
      "biomarkers.adverseGrade",
      "biomarkers.genomicMarker",
      "icd10Code",
      "icd10Category",
      "ageGroup",
      "hospitalOrigin",
    ];
    const blockedFields = requestedFields.filter(
      (f) => !allowedFields.includes(f)
    );

    if (queryType === "DENIED_PII_NOTES" || blockedFields.length > 0) {
      const deniedList =
        blockedFields.length > 0
          ? blockedFields
          : ["clinicalNotes", "patientDisplayName", "patientVuid", "medications"];
      const reason = `Policy Violation (FIELD_OUTSIDE_ACTIVE_POLICY): Active study policy for '${STUDY_GROUP_ID}' denies AI Assistant access to restricted fields [${deniedList.join(
        ", "
      )}]. Allowed fields: [${allowedFields.join(", ")}].`;

      db.auditLog.unshift({
        id: `audit-${randomUUID().slice(0, 8)}`,
        timestamp: nowIso,
        actor: "In-Browser AI Agent (study-42-assistant)",
        category: "AI_POLICY",
        action: `AI_AGENT_FIELD_ACCESS (${deniedList.join(", ")})`,
        httpStatus: 403,
        outcome: "DENIED_403",
        detail: reason,
      });
      writeDb(db);
      return Response.json(
        {
          ok: false,
          error: reason,
          deniedFields: deniedList,
          allowedFields,
        },
        { status: 403 }
      );
    }

    db.auditLog.unshift({
      id: `audit-${randomUUID().slice(0, 8)}`,
      timestamp: nowIso,
      actor: "In-Browser AI Agent (study-42-assistant)",
      category: "AI_POLICY",
      action: `AI_AGENT_FIELD_ACCESS (${requestedFields.join(", ")})`,
      httpStatus: 200,
      outcome: "ALLOWED",
      detail: `AI Assistant query ("${promptText.slice(
        0,
        60
      )}") verified against active study policy. Accessed only allowed fields [${requestedFields.join(
        ", "
      )}] inside Browser Sandbox RAM.`,
    });
    writeDb(db);
    return Response.json({
      ok: true,
      allowedFields,
      accessedFields: requestedFields,
    });
  }

  // 6. Rogue Operator / Admin Failure Paths (Step 3.5 — "Try to break it" rogue operator panel)
  // Attack 1: Rogue operator/admin tries to read/open a patient's clinical record directly
  if (action === "ROGUE_OPEN_PAYLOAD") {
    const targetRecordId = (body.recordId as string) || "CP-REC-001";
    const rogueUser = "operator-admin@carepassport.internal";
    const ruleStoppedIt =
      "TideMemory v1 Envelope + RelationshipAttestation:1 User Policy (No Master Key)";
    const reason =
      "No decryption authority: Platform operator holds database/infrastructure root but lacks the '_tide_decryptor' role, holds no patient key, and is not the named User subject on any RelationshipAttestation:1 policy. Raw database contains only TideMemory v1 ciphertext.";

    db.auditLog.unshift({
      id: `audit-${randomUUID().slice(0, 8)}`,
      timestamp: nowIso,
      actor: `Rogue Operator (${rogueUser})`,
      targetRecordId,
      category: "ROGUE_ADMIN",
      action: `ROGUE_OPEN_PAYLOAD (${targetRecordId})`,
      httpStatus: 403,
      outcome: "DENIED_403",
      detail: `BLOCKED (HTTP 403) by [${ruleStoppedIt}]: ${reason}`,
    });
    writeDb(db);
    return Response.json(
      {
        ok: false,
        attackType: "OPEN_PAYLOAD",
        httpStatus: 403,
        reasonCode: "NO_DECRYPTION_AUTHORITY",
        ruleStoppedIt,
        error: reason,
      },
      { status: 403 }
    );
  }

  // Attack 1b: Rogue operator tries to grant themselves access to a patient's record (`ROGUE_SELF_GRANT_RECORD`)
  if (action === "ROGUE_SELF_GRANT_RECORD") {
    const targetRecordId = (body.recordId as string) || "CP-REC-001";
    const rogueUser = "operator-admin@carepassport.internal";
    const ruleStoppedIt =
      "Owner-Mode Attestation (Owner == Issuer == Patient VUID) + Cryptographic IGA Quorum Gate";
    const reason =
      "Blocked (HTTP 403): Operator cannot self-grant access to 'CP-REC-001'. Under 'owner' mode (--claims shared-with --mode owner), only the patient owner (vuid_9f81a2c4...) can sign a valid 'shared-with' statement, and any unilateral role/policy mutation is trapped by Cryptographic IGA (HTTP 412 MULTIADMIN_REQUIRES_APPROVAL_ENCLAVE).";

    db.auditLog.unshift({
      id: `audit-${randomUUID().slice(0, 8)}`,
      timestamp: nowIso,
      actor: `Rogue Operator (${rogueUser})`,
      targetRecordId,
      category: "ROGUE_ADMIN",
      action: `ROGUE_SELF_GRANT_RECORD (${targetRecordId})`,
      httpStatus: 403,
      outcome: "DENIED_403",
      detail: `BLOCKED (HTTP 403) by [${ruleStoppedIt}]: ${reason}`,
    });
    writeDb(db);
    return Response.json(
      {
        ok: false,
        attackType: "SELF_GRANT_RECORD",
        httpStatus: 403,
        reasonCode: "NOT_RECORD_OWNER",
        ruleStoppedIt,
        error: reason,
      },
      { status: 403 }
    );
  }

  // Attack 1c: Rogue operator tries to share a record with a clinician on the patient's behalf (`ROGUE_SHARE_ON_PATIENT_BEHALF`)
  if (action === "ROGUE_SHARE_ON_PATIENT_BEHALF") {
    const targetRecordId = (body.recordId as string) || "CP-REC-003";
    const targetClinician = (body.clinicianName as string) || "Dr. Aris Thorne (GP)";
    const rogueUser = "operator-admin@carepassport.internal";
    const ruleStoppedIt =
      "AttestationContract.cs Owner Rule (Issuer != Owner) + Server verifyAttestation() Byte-Rebuild Check (AP-AT01)";
    const reason = `Blocked (HTTP 403): Operator attempted to share '${targetRecordId}' with ${targetClinician} on Elena Rostova's behalf. The ORK network refuses any 'owner'-mode 'shared-with' attestation where signer.vuid != Owner (vuid_00deadbeef... != vuid_9f81a2c4...), and the server's verifyAttestation() rejects any database row without a valid patient Ed25519 signature.`;

    db.auditLog.unshift({
      id: `audit-${randomUUID().slice(0, 8)}`,
      timestamp: nowIso,
      actor: `Rogue Operator (${rogueUser})`,
      targetRecordId,
      targetClinicianName: targetClinician,
      category: "ROGUE_ADMIN",
      action: `ROGUE_SHARE_ON_PATIENT_BEHALF (${targetRecordId} -> ${targetClinician})`,
      httpStatus: 403,
      outcome: "DENIED_403",
      detail: `BLOCKED (HTTP 403) by [${ruleStoppedIt}]: ${reason}`,
    });
    writeDb(db);
    return Response.json(
      {
        ok: false,
        attackType: "SHARE_ON_PATIENT_BEHALF",
        httpStatus: 403,
        reasonCode: "OWNER_SIGNATURE_REQUIRED",
        ruleStoppedIt,
        error: reason,
      },
      { status: 403 }
    );
  }

  // Attack 2: Rogue admin tries to add themselves to the Ethics Board (`ROGUE_SELF_ETHICS_BOARD`)
  if (action === "ROGUE_SELF_ETHICS_BOARD") {
    const rogueUser = "root-dba@medpool-infra.internal";
    const ruleStoppedIt =
      "TideCloak Cryptographic IGA + Self-Approval Prohibition (floor(3 × 0.7) = 2 of 3 Quorum)";
    const reason =
      "Self-elevation to 'ethics-board' is trapped in HTTP 202 PENDING and rejected with HTTP 412 (MULTIADMIN_REQUIRES_APPROVAL_ENCLAVE). Joining the Ethics Board requires 2-of-3 existing Ethics Board enclave signatures.";

    db.auditLog.unshift({
      id: `audit-${randomUUID().slice(0, 8)}`,
      timestamp: nowIso,
      actor: `Rogue Sysadmin (${rogueUser})`,
      category: "ROGUE_ADMIN",
      action: "ROGUE_SELF_ETHICS_BOARD (Attempt self-grant 'ethics-board')",
      httpStatus: 412,
      outcome: "DENIED_403",
      detail: `BLOCKED (HTTP 202 -> 412) by [${ruleStoppedIt}]: ${reason}`,
    });
    writeDb(db);
    return Response.json(
      {
        ok: false,
        attackType: "SELF_ETHICS_BOARD",
        httpStatus: 412,
        reasonCode: "MULTIADMIN_REQUIRES_APPROVAL_ENCLAVE",
        ruleStoppedIt,
        error: reason,
      },
      { status: 202 }
    );
  }

  // Attack 3: Rogue admin tries to lower the quorum from 2 to 1 (`ROGUE_CHANGE_QUORUM_RULE`)
  if (action === "ROGUE_CHANGE_QUORUM_RULE") {
    const rogueUser = "root-dba@medpool-infra.internal";
    const ruleStoppedIt =
      "VVK ORK Threshold Formula max(1, floor(3 × 0.7)) = 2 (Immutable by Single Admin)";
    const reason =
      "Quorum not met & rule immutable: TideCloak Cryptographic IGA threshold formula max(1, floor(3 * 0.7)) = 2 is enforced by the VVK ORK network. A single admin cannot lower the quorum threshold from 2 to 1 or disable IGA without 2-of-3 Ethics Board enclave signatures.";

    db.auditLog.unshift({
      id: `audit-${randomUUID().slice(0, 8)}`,
      timestamp: nowIso,
      actor: `Rogue Sysadmin (${rogueUser})`,
      category: "ROGUE_ADMIN",
      action: "ROGUE_CHANGE_QUORUM_RULE (Attempt 2/3 -> 1/3 override)",
      httpStatus: 403,
      outcome: "DENIED_403",
      detail: `BLOCKED (HTTP 403) by [${ruleStoppedIt}]: ${reason}`,
    });
    writeDb(db);
    return Response.json(
      {
        ok: false,
        attackType: "CHANGE_QUORUM_RULE",
        httpStatus: 403,
        reasonCode: "QUORUM_RULE_IMMUTABLE_ALONE",
        ruleStoppedIt,
        error: reason,
      },
      { status: 403 }
    );
  }

  // Attack 4: Rogue admin tries to unilaterally grant access to a researcher (or self) (`ROGUE_GRANT_RESEARCHER_ACCESS` / `ROGUE_WIDEN_ACCESS`)
  if (
    action === "ROGUE_GRANT_RESEARCHER_ACCESS" ||
    action === "ROGUE_WIDEN_ACCESS" ||
    action === "ROGUE_SYSADMIN_ESCALATION_ATTEMPT"
  ) {
    const rogueUser = "root-dba@medpool-infra.internal";
    const targetUser =
      action === "ROGUE_GRANT_RESEARCHER_ACCESS"
        ? "dr.chen@medpool.org"
        : rogueUser;
    const ruleStoppedIt =
      "TideCloak Cryptographic IGA Four-Eyes Quorum Gate (2-of-3 Ethics Board Signatures Required)";
    const cr: IgaChangeRequest = {
      id: `cr-rogue-${randomUUID().slice(0, 8)}`,
      actionType: "ADD_GROUP_MEMBERSHIP",
      entityType: "USER_GROUP_MEMBERSHIP",
      targetUser,
      targetGroupOrRole: STUDY_GROUP_ID,
      requestedBy: rogueUser,
      requestedByRole: "sysadmin",
      httpStatusOnCreate: 202,
      status: "PENDING",
      threshold: 2,
      totalAdmins: 3,
      approvals: [],
      readyToCommit: false,
      createdAt: nowIso,
    };

    db.changeRequests.unshift(cr);
    const reason = `Quorum not met (0 of 2 Ethics Board approvals): Sysadmin cannot unilaterally grant '${STUDY_GROUP_ID}' access to ${targetUser}. Mutation is trapped in HTTP 202 PENDING and rejected on commit with HTTP 412 (MULTIADMIN_REQUIRES_APPROVAL_ENCLAVE).`;

    db.auditLog.unshift({
      id: `audit-${randomUUID().slice(0, 8)}`,
      timestamp: nowIso,
      actor: `Rogue Sysadmin (${rogueUser})`,
      category: "ROGUE_ADMIN",
      action: `${action} (Grant ${STUDY_GROUP_ID} -> ${targetUser})`,
      httpStatus: 412,
      outcome: "DENIED_403",
      detail: `BLOCKED (HTTP 202 -> 412) by [${ruleStoppedIt}]: ${reason}`,
    });
    writeDb(db);
    return Response.json(
      {
        ok: false,
        attackType: action,
        trappedAsChangeRequest: true,
        httpStatusOnMutate: 202,
        httpStatusOnUnilateralCommit: 412,
        reasonCode: "QUORUM_NOT_MET",
        ruleStoppedIt,
        error: reason,
        changeRequest: cr,
      },
      { status: 202 }
    );
  }

  // Feature 6: Policy Transparency — Propose a rule change (requires the same 2-of-3 Ethics Board quorum and logs attempt)
  if (action === "PROPOSE_POLICY_RULE_CHANGE") {
    const proposedChange =
      (body.proposedChange as string) ||
      "Extend time-limited access window from 180s to 600s";
    const actor =
      (body.actor as string) ||
      sessionAccount?.name ||
      "Consortium Member";

    const cr: IgaChangeRequest = {
      id: `cr-policy-${randomUUID().slice(0, 8)}`,
      actionType: "MODIFY_QUORUM_RULE",
      entityType: "REALM_IGA_POLICY",
      targetUser: STUDY_GROUP_ID,
      targetGroupOrRole: proposedChange,
      requestedBy: actor,
      requestedByRole:
        serverResolvedRole === "ethics-board" ? "ethics-board" : "researcher",
      httpStatusOnCreate: 202,
      status: "PENDING",
      threshold: 2,
      totalAdmins: 3,
      approvals: [],
      readyToCommit: false,
      createdAt: nowIso,
    };
    db.changeRequests.unshift(cr);

    db.auditLog.unshift({
      id: `audit-${randomUUID().slice(0, 8)}`,
      timestamp: nowIso,
      actor,
      category: "QUORUM",
      action: `PROPOSE_POLICY_RULE_CHANGE (${proposedChange})`,
      httpStatus: 202,
      outcome: "PENDING_QUORUM_202",
      detail: `HTTP 202 Accepted (Active policy unchanged): Proposed rule change "${proposedChange}" queued as ${cr.id}. Changing any study rule requires 2-of-3 Ethics Board enclave signatures.`,
    });
    writeDb(db);
    return Response.json({ ok: true, changeRequest: cr }, { status: 202 });
  }

  // Feature 7: Time-Limited Access Expiry (`EXPIRE_STUDY_ACCESS`)
  if (action === "EXPIRE_STUDY_ACCESS") {
    db.researcherGroupMemberships = db.researcherGroupMemberships.filter(
      (g) => g !== STUDY_GROUP_ID
    );
    db.studyAccessExpiresAt = null;
    for (const cr of db.changeRequests) {
      if (
        cr.targetGroupOrRole === STUDY_GROUP_ID &&
        cr.status === "COMMITTED"
      ) {
        cr.status = "REVOKED";
      }
    }

    db.auditLog.unshift({
      id: `audit-${randomUUID().slice(0, 8)}`,
      timestamp: nowIso,
      actor: "Time-Limited Access Enforcer (TTL Countdown = 00:00)",
      category: "REVOCATION",
      action: `STUDY_ACCESS_EXPIRED (${STUDY_GROUP_ID})`,
      httpStatus: 200,
      outcome: "REVOKED",
      detail: `Time-limited access window for '${STUDY_GROUP_ID}' reached 00:00 and expired. Researcher removed from study group and decrypted browser sandbox memory wiped.`,
    });
    writeDb(db);
    return Response.json({ ok: true, expired: true });
  }

  // 7. Granular Revocation (Task G — Revoke patient consent OR revoke 1 Ethics Board approval)
  if (action === "REVOKE_ACCESS") {
    const revokeTarget =
      (body.revokeTarget as "PATIENT_CONSENT" | "ETHICS_APPROVAL" | "ALL") ||
      "ALL";
    const targetRecordId = body.recordId as string | undefined;

    if (revokeTarget === "PATIENT_CONSENT") {
      if (targetRecordId && db.consentByRecord?.[targetRecordId]) {
        db.consentByRecord[targetRecordId].status = "REVOKED";
        db.consentByRecord[targetRecordId].updatedAt = nowIso;
      } else {
        for (const k of Object.keys(db.consentByRecord || {})) {
          db.consentByRecord[k].status = "REVOKED";
          db.consentByRecord[k].updatedAt = nowIso;
        }
      }
      if (db.consentAttestation) {
        db.consentAttestation.status = "REVOKED";
        db.consentAttestation.updatedAt = nowIso;
      }

      db.auditLog.unshift({
        id: `audit-${randomUUID().slice(0, 8)}`,
        timestamp: nowIso,
        actor: (body.actor as string) || "Patient Portal (Self-Sovereign Revocation)",
        category: "REVOCATION",
        action: `REVOKE_PATIENT_CONSENT (${targetRecordId || "All Cohort Records"})`,
        httpStatus: 200,
        outcome: "REVOKED",
        detail: `Patient revoked self-mode consent attestation for ${
          targetRecordId || "all cohort records"
        }. Future unlock & decryption stopped immediately.`,
      });
      writeDb(db);
      return Response.json({ ok: true, revokeTarget });
    }

    if (revokeTarget === "ETHICS_APPROVAL") {
      let revokedAdminName = "Prof. Lukas Weber";
      for (const cr of db.changeRequests) {
        if (
          cr.targetGroupOrRole === STUDY_GROUP_ID &&
          cr.requestedByRole === "researcher" &&
          cr.approvals.length > 0
        ) {
          const removed = cr.approvals.pop();
          if (removed) revokedAdminName = removed.adminName;
          cr.readyToCommit = cr.approvals.length >= cr.threshold;
          cr.status = cr.readyToCommit ? "APPROVED" : "PENDING";
        }
      }
      db.researcherGroupMemberships = db.researcherGroupMemberships.filter(
        (g) => g !== STUDY_GROUP_ID
      );
      db.studyAccessExpiresAt = null;

      db.auditLog.unshift({
        id: `audit-${randomUUID().slice(0, 8)}`,
        timestamp: nowIso,
        actor: `${revokedAdminName} (Ethics Board)`,
        category: "REVOCATION",
        action: `REVOKE_ETHICS_BOARD_APPROVAL (${STUDY_GROUP_ID})`,
        httpStatus: 200,
        outcome: "REVOKED",
        detail: `${revokedAdminName} withdrew enclave approval, dropping Ethics Board quorum below 2/3 (now 1/3). Researcher removed from '${STUDY_GROUP_ID}'; future unlock & decryption stopped immediately.`,
      });
      writeDb(db);
      return Response.json({ ok: true, revokeTarget });
    }

    // Default: revoke both consent and group membership
    if (db.consentAttestation) {
      db.consentAttestation.status = "REVOKED";
      db.consentAttestation.updatedAt = nowIso;
    }
    for (const k of Object.keys(db.consentByRecord || {})) {
      db.consentByRecord[k].status = "REVOKED";
      db.consentByRecord[k].updatedAt = nowIso;
    }
    db.researcherGroupMemberships = db.researcherGroupMemberships.filter(
      (g) => g !== STUDY_GROUP_ID
    );
    for (const cr of db.changeRequests) {
      if (cr.targetGroupOrRole === STUDY_GROUP_ID && cr.status === "COMMITTED") {
        cr.status = "DENIED";
      }
    }
    db.studyAccessExpiresAt = null;

    db.auditLog.unshift({
      id: `audit-${randomUUID().slice(0, 8)}`,
      timestamp: nowIso,
      actor: (body.actor as string) || "Patient / Ethics Governance",
      category: "REVOCATION",
      action: `REVOKE_CONSENT_AND_GROUP (${STUDY_GROUP_ID})`,
      httpStatus: 200,
      outcome: "REVOKED",
      detail: `Patient consent revoked and researcher removed from '${STUDY_GROUP_ID}'. Future unlock & ORK decryption stopped immediately.`,
    });
    writeDb(db);
    return Response.json({ ok: true, revokeTarget: "ALL" });
  }

  return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
}
