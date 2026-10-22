"use client";

import React, { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useTideCloak } from "@tidecloak/nextjs";
import { toBase64, fromBase64 } from "@/lib/tide/attestation.client";
import {
  unlockRecordInBrowserSandbox,
  runInBrowserClinicalAnalytics,
  runPolicyScopedAiAssistantInBrowser,
  DEFAULT_ALLOWED_AI_FIELDS,
  DEFAULT_DENIED_AI_FIELDS,
  type SandboxAnalyticsResult,
  type PolicyScopedAiResponse,
} from "@/lib/medpool/sandbox";
import {
  REVOCATION_HONESTY_NOTE,
  type PatientRecord,
  type ClinicianShareGrant,
  type ConsentAttestationRow,
  type IgaChangeRequest,
  type StoredRelationshipPolicy,
  type AuditLogEntry,
  type ClinicalPayloadPlaintext,
  type MedPoolAccount,
  type RoleApprovalRequest,
} from "@/lib/medpool/types";
import {
  getStoredAccountId,
  setStoredAccountId,
  isSessionMarkedExpired,
  setSessionExpiredFlag,
  resolveActiveAccount,
  getRoleDisplayLabel,
} from "@/lib/auth/session";
import {
  appFetch,
  runWithPopupDetection,
  refreshTideSessionToken,
} from "@/lib/auth/appFetch";
import {
  StatusBadge,
  GlobalFlowStepper,
  ConfirmRevokeModal,
  IconLock,
  IconUnlock,
  IconShield,
  IconCheck,
  IconClock,
  IconBan,
  IconSearch,
} from "@/components/ui/DesignSystem";
import { GuidedDemoPanel } from "@/components/GuidedDemoPanel";

interface MedPoolRecordView extends PatientRecord {
  consentState: "PENDING" | "GRANTED" | "REVOKED";
  payloadLocked: boolean;
  ciphertextPreview: string;
  activeShares?: {
    grantId: string;
    clinicianAccountId: string;
    clinicianName: string;
    clinicianRoleLabel: string;
    clinicianVuid: string;
    expiry: number;
    grantedAt: string;
  }[];
  revokedShares?: {
    grantId: string;
    clinicianAccountId: string;
    clinicianName: string;
    clinicianRoleLabel: string;
    revokedAt?: string;
  }[];
}

interface MedPoolApiResponse {
  studyGroupId: string;
  honestyNote?: string;
  records: MedPoolRecordView[];
  totalRecords: number;
  accounts: MedPoolAccount[];
  clinicians?: MedPoolAccount[];
  shareGrants?: (ClinicianShareGrant & {
    cryptographicallyVerified?: boolean;
  })[];
  roleRequests: RoleApprovalRequest[];
  consentAttestation: ConsentAttestationRow | null;
  consentByRecord: Record<string, ConsentAttestationRow>;
  recordConsentStatus: Record<string, "PENDING" | "GRANTED" | "REVOKED">;
  grantedConsentCount: number;
  changeRequests: IgaChangeRequest[];
  relationshipPolicy: StoredRelationshipPolicy | null;
  researcherGroupMemberships: string[];
  researcherRealmRoles: string[];
  studyAccessExpiresAt: number | null;
  auditLog: AuditLogEntry[];
  emergentAuthority: {
    lock1PatientSelfConsent: boolean;
    lock2EthicsQuorumCommitted: boolean;
    lock3ResearcherDpopAndRole: boolean;
    unlocked: boolean;
    quorumFormula: string;
  };
  liveAuth: {
    verifiedLiveToken: boolean;
    subject?: string;
    vuid?: string;
    groups?: string[];
    roles?: string[];
  };
}

type RoleMode =
  | "quad"
  | "patient"
  | "doctor"
  | "gp"
  | "physio"
  | "researcher"
  | "ethics"
  | "sysadmin"
  | "pending";

const ROLE_METADATA: Record<
  RoleMode,
  { label: string; actorName: string; badge: string }
> = {
  quad: {
    label: "All Roles (Split Demo View)",
    actorName: "Multi-Actor Demo Console",
    badge: "All-Role Split View",
  },
  patient: {
    label: "Patient",
    actorName: "Elena Rostova (Patient #001)",
    badge: "Role: patient (self-consent)",
  },
  doctor: {
    label: "Doctor (Metadata Only)",
    actorName: "Dr. Aris Thorne (Cardiologist)",
    badge: "Role: doctor (metadata-only)",
  },
  gp: {
    label: "GP (Dr. Aris Thorne)",
    actorName: "Dr. Aris Thorne (GP)",
    badge: "Role: doctor (General Practitioner)",
  },
  physio: {
    label: "Physio (Dr. Maya Lin)",
    actorName: "Dr. Maya Lin (Physiotherapist)",
    badge: "Role: doctor (Physiotherapist)",
  },
  researcher: {
    label: "Researcher",
    actorName: "Dr. Lin Chen (Principal Investigator)",
    badge: "Role: researcher (_tide_decryptor)",
  },
  ethics: {
    label: "Ethics Board (3 Admins)",
    actorName: "Cross-Hospital IRB Governance",
    badge: "Role: ethics-board (2/3 IGA Quorum)",
  },
  sysadmin: {
    label: "Sysadmin / DBA",
    actorName: "Marcus Vance (root-dba)",
    badge: "Role: sysadmin (No Master Key)",
  },
  pending: {
    label: "Pending Account (Minimal Access)",
    actorName: "Unapproved Applicant",
    badge: "Role: pending (_tide_enabled only)",
  },
};

export default function MedPoolPage() {
  const {
    authenticated,
    login: tideLogin,
    logout: tideLogout,
    getValueFromToken,
  } = useTideCloak();
  const [state, setState] = useState<MedPoolApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [storedAccountId, setStoredAccountIdState] = useState<string | null>(
    null
  );
  const [sessionExpiredBanner, setSessionExpiredBanner] = useState(false);

  // Theme (Light Mode Default per design direction, optional Dark Mode)
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [showDemoHelper, setShowDemoHelper] = useState<boolean>(true);

  // Role / Screen Mode
  const [viewMode, setViewMode] = useState<RoleMode>("quad");

  // Screen 2: Metadata search filters (condition category, age band, hospital, date range)
  const [hospitalFilter, setHospitalFilter] = useState("");
  const [icdFilter, setIcdFilter] = useState("");
  const [ageFilter, setAgeFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  // Screen 3: Patient Consent selector
  const [selectedConsentRecordId, setSelectedConsentRecordId] =
    useState<string>("CP-REC-001");
  const [applyConsentToAll, setApplyConsentToAll] = useState<boolean>(false);

  // Care Passport: Per-Clinician Browser Sandbox Decryption & Refusal State
  const [clinicianUnlocked, setClinicianUnlocked] = useState<
    Record<string, Record<string, ClinicalPayloadPlaintext>>
  >({});
  const [clinicianRefusal, setClinicianRefusal] = useState<
    Record<
      string,
      {
        recordId: string;
        status: number;
        code: string;
        ruleStoppedIt: string;
        error: string;
        time: string;
      } | null
    >
  >({});
  const [shareFeedbackBanner, setShareFeedbackBanner] = useState<{
    type: "success" | "error" | "info";
    text: string;
  } | null>(null);
  const [auditClinicianFilter, setAuditClinicianFilter] =
    useState<string>("ALL");

  // Screen 4: Browser Sandbox state (stays strictly in browser memory)
  const [unlockedPlaintexts, setUnlockedPlaintexts] = useState<
    Record<string, ClinicalPayloadPlaintext>
  >({});
  const [sandboxAnalytics, setSandboxAnalytics] =
    useState<SandboxAnalyticsResult | null>(null);
  const [sandboxError, setSandboxError] = useState<string | null>(null);
  const [exportBlockNotice, setExportBlockNotice] = useState<string | null>(
    null
  );
  const [aiResponse, setAiResponse] = useState<PolicyScopedAiResponse | null>(
    null
  );

  // Screen 3 & 5: Status feedback banners
  const [ethicsBanner, setEthicsBanner] = useState<{
    type: "info" | "error" | "success";
    text: string;
  } | null>(null);

  const [rogueAttempts, setRogueAttempts] = useState<
    Record<
      string,
      {
        blocked: boolean;
        status: number;
        code: string;
        ruleStoppedIt: string;
        reason: string;
        time: string;
      }
    >
  >({});

  // Feature 2: Guided Demo Panel toggle state
  const [guidedDemoOpen, setGuidedDemoOpen] = useState<boolean>(false);

  // Feature 6 & 7: Policy rule change notice & Time-limited access countdown
  const [policyRuleNotice, setPolicyRuleNotice] = useState<string | null>(null);
  const [remainingAccessSeconds, setRemainingAccessSeconds] = useState<
    number | null
  >(null);

  // Screen 6: Audit Trail filters
  const [auditCategoryFilter, setAuditCategoryFilter] = useState<string>("ALL");
  const [auditActorFilter, setAuditActorFilter] = useState<string>("");

  // Screen 7: Revocation Confirmation Modal state
  const [revokeModalTarget, setRevokeModalTarget] = useState<
    "PATIENT_CONSENT" | "ETHICS_APPROVAL" | "ALL" | null
  >(null);
  const [popupBlockedNotice, setPopupBlockedNotice] = useState<string | null>(
    null
  );
  const [revocationRefreshNotice, setRevocationRefreshNotice] = useState<
    string | null
  >(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const fetchState = useCallback(async () => {
    const params = new URLSearchParams();
    if (hospitalFilter) params.set("hospital", hospitalFilter);
    if (icdFilter) params.set("icd10", icdFilter);
    if (ageFilter) params.set("ageGroup", ageFilter);
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);

    // Gotcha #5: Use appFetch (IAMService.secureFetch) for every server call
    const res = await appFetch(`/api/medpool/state?${params.toString()}`, {
      cache: "no-store",
    });
    const data = (await res.json()) as MedPoolApiResponse;
    setState(data);
    setLoading(false);

    // Immediately wipe browser sandbox memory if any unlock condition is revoked
    if (!data.emergentAuthority.unlocked) {
      setUnlockedPlaintexts({});
      setSandboxAnalytics(null);
      setAiResponse(null);
    }
  }, [hospitalFilter, icdFilter, ageFilter, dateFrom, dateTo]);

  useEffect(() => {
    setStoredAccountIdState(getStoredAccountId());
    setSessionExpiredBanner(isSessionMarkedExpired());
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("guided") === "1") {
        setGuidedDemoOpen(true);
      }
    }
    fetchState();
  }, [fetchState]);

  // Feature 7: Live countdown timer for time-limited study access (`studyAccessExpiresAt`)
  useEffect(() => {
    if (!state?.studyAccessExpiresAt) {
      setRemainingAccessSeconds(null);
      return;
    }
    const updateRemaining = () => {
      const diff = Math.max(
        0,
        state.studyAccessExpiresAt! - Math.floor(Date.now() / 1000)
      );
      setRemainingAccessSeconds(diff);
      if (diff <= 0) {
        appFetch("/api/medpool/state", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "EXPIRE_STUDY_ACCESS" }),
        }).then(() => {
          setUnlockedPlaintexts({});
          setSandboxAnalytics(null);
          setAiResponse(null);
          setRevocationRefreshNotice(
            "Time-limited study access window expired (00:00). Researcher access to '/studies/study-42' has ended and browser sandbox memory was wiped."
          );
          fetchState();
        });
      }
    };
    updateRemaining();
    const timer = setInterval(updateRemaining, 1000);
    return () => clearInterval(timer);
  }, [state?.studyAccessExpiresAt, fetchState]);

  const mapAccountRoleToViewMode = (
    role: MedPoolAccount["activeRole"]
  ): RoleMode => {
    switch (role) {
      case "patient":
        return "patient";
      case "doctor":
        return "doctor";
      case "researcher":
        return "researcher";
      case "ethics-board":
        return "ethics";
      case "sysadmin":
        return "sysadmin";
      case "pending":
        return "pending";
      default:
        return "quad";
    }
  };

  const handleSwitchDemoAccount = async (acct: MedPoolAccount) => {
    setBusyAction(`SWITCH_${acct.id}`);
    setStoredAccountId(acct.id);
    setStoredAccountIdState(acct.id);
    setSessionExpiredFlag(false);
    setSessionExpiredBanner(false);
    setViewMode(mapAccountRoleToViewMode(acct.activeRole));
    try {
      await appFetch("/api/medpool/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "LOGIN_ACCOUNT",
          accountId: acct.id,
          authMethod: acct.authMethod,
        }),
      });
      await fetchState();
    } finally {
      setBusyAction(null);
    }
  };

  const handleLogoutAccount = async (currentAcct: MedPoolAccount | null) => {
    setBusyAction("LOGOUT");
    setUnlockedPlaintexts({});
    setSandboxAnalytics(null);
    setAiResponse(null);
    try {
      if (currentAcct) {
        await appFetch("/api/medpool/state", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "LOGOUT_ACCOUNT",
            accountId: currentAcct.id,
          }),
        });
      }
      setStoredAccountId(null);
      setStoredAccountIdState(null);
      setViewMode("quad");
      await fetchState();
      if (authenticated) {
        tideLogout();
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handleApproveRoleRequest = async (
    roleRequestId: string,
    adminId: string
  ) => {
    setBusyAction(`ROLE_APPROVE_${roleRequestId}_${adminId}`);
    setEthicsBanner(null);
    try {
      const res = await appFetch("/api/medpool/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "APPROVE_ROLE_REQUEST",
          roleRequestId,
          adminId,
          callerRole: "ethics-board",
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setEthicsBanner({
          type: "error",
          text: data.error || "Role request approval failed.",
        });
      } else {
        const rr = data.roleRequest as RoleApprovalRequest;
        setEthicsBanner({
          type: rr.status === "APPROVED" ? "success" : "info",
          text:
            rr.status === "APPROVED"
              ? `2-of-3 Ethics Board Quorum Met (${rr.approvals.length}/${rr.threshold}): Elevated role '${rr.requestedRole}' granted to ${rr.userName}.`
              : `Recorded approval ${rr.approvals.length}/${rr.threshold} for ${rr.userName}. Still requires 1 more Ethics Board member signature.`,
        });
      }
      await fetchState();
    } finally {
      setBusyAction(null);
    }
  };

  const handleRejectRoleRequest = async (
    roleRequestId: string,
    adminId: string
  ) => {
    setBusyAction(`ROLE_REJECT_${roleRequestId}`);
    setEthicsBanner(null);
    try {
      const res = await appFetch("/api/medpool/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "REJECT_ROLE_REQUEST",
          roleRequestId,
          adminId,
          callerRole: "ethics-board",
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setEthicsBanner({
          type: "error",
          text: data.error || "Rejection failed.",
        });
      } else {
        setEthicsBanner({
          type: "error",
          text: `Role request ${roleRequestId} REJECTED by Ethics Board. Account remains restricted to minimal permissions.`,
        });
      }
      await fetchState();
    } finally {
      setBusyAction(null);
    }
  };

  // Reset Demo State
  const handleResetDemo = async () => {
    setBusyAction("RESET_DEMO");
    setUnlockedPlaintexts({});
    setClinicianUnlocked({});
    setClinicianRefusal({});
    setShareFeedbackBanner(null);
    setSandboxAnalytics(null);
    setSandboxError(null);
    setExportBlockNotice(null);
    setAiResponse(null);
    setEthicsBanner(null);
    setRogueAttempts({});
    setRevocationRefreshNotice(null);
    await appFetch("/api/medpool/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "RESET_DEMO" }),
    });
    await fetchState();
    setBusyAction(null);
  };

  // Care Passport Step 3.1: Patient signs Ed25519 `owner`-mode `shared-with` attestation + User Policy for ONE record & ONE clinician
  const handleGrantRecordShare = async (
    recordId: string,
    clinicianAccountId: string,
    silent = false
  ) => {
    if (!silent) {
      setBusyAction(`SHARE_${recordId}_${clinicianAccountId}`);
      setShareFeedbackBanner(null);
    }
    try {
      // 1. Server builds the exact unsigned Policy.DataToVerify bytes (AP-AT04)
      const prepRes = await appFetch("/api/medpool/state", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-medpool-account-id": "acct-patient-1",
        },
        body: JSON.stringify({
          action: "PREPARE_SHARE_GRANT",
          recordId,
          clinicianAccountId,
          callerRole: "patient",
        }),
      });
      const prep = await prepRes.json();
      if (!prepRes.ok) {
        setShareFeedbackBanner({
          type: "error",
          text: prep.error || "Failed to prepare share grant.",
        });
        return;
      }

      // 2. Patient signs the statement bytes in browser WebCrypto Ed25519
      const bytesToSign = fromBase64(prep.bytesToSignB64);
      const keyPair = (await crypto.subtle.generateKey(
        { name: "Ed25519" },
        true,
        ["sign", "verify"]
      )) as CryptoKeyPair;
      const sigBuffer = await crypto.subtle.sign(
        { name: "Ed25519" },
        keyPair.privateKey,
        bytesToSign as BufferSource
      );
      const signatureB64 = toBase64(new Uint8Array(sigBuffer));
      const signerPublicJwk = await crypto.subtle.exportKey(
        "jwk",
        keyPair.publicKey
      );

      // 3. Server rebuilds statement bytes from raw columns and verifies signature before storing (AP-AT02 & AP-AT03)
      const grantRes = await appFetch("/api/medpool/state", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-medpool-account-id": "acct-patient-1",
        },
        body: JSON.stringify({
          action: "GRANT_RECORD_SHARE",
          recordId,
          clinicianAccountId,
          expiry: prep.statement.expiry,
          signatureB64,
          signerPublicJwk,
          callerRole: "patient",
        }),
      });
      const grantData = await grantRes.json();
      if (!grantRes.ok) {
        setShareFeedbackBanner({
          type: "error",
          text: grantData.error || "Share grant verification failed.",
        });
        return;
      }

      // Clear any previous refusal banner for this clinician
      setClinicianRefusal((prev) => ({
        ...prev,
        [clinicianAccountId]: null,
      }));

      if (!silent) {
        setShareFeedbackBanner({
          type: "success",
          text: `Shared '${prep.recordId} (${prep.recordTitle})' exclusively with ${prep.clinicianName}. Server rebuilt Policy.DataToVerify bytes and verified your 64-byte Ed25519 'owner'-mode signature.`,
        });
        await fetchState();
      }
    } finally {
      if (!silent) {
        setBusyAction(null);
      }
    }
  };

  // Care Passport Demo Step 2 Convenience: Share Referral (CP-REC-001) -> GP and Care Plan (CP-REC-002) -> Physio
  const handleGrantTargetDemoPair = async () => {
    setBusyAction("SHARE_DEMO_PAIR");
    setShareFeedbackBanner(null);
    try {
      await handleGrantRecordShare("CP-REC-001", "acct-gp-1", true);
      await handleGrantRecordShare("CP-REC-002", "acct-physio-1", true);
      await fetchState();
      setShareFeedbackBanner({
        type: "success",
        text: "Step 2 Complete: Shared Specialist Referral (CP-REC-001) with Dr. Aris Thorne (GP) and Physiotherapy Care Plan (CP-REC-002) with Dr. Maya Lin (Physiotherapist). CP-REC-003 remains private to Nobody.",
      });
    } finally {
      setBusyAction(null);
    }
  };

  // Care Passport Step 3.3: Patient withdraws a specific clinician's access + triggers Session Refresh
  const handleRevokeRecordShare = async (
    recordId: string,
    clinicianAccountId: string
  ) => {
    setBusyAction(`REVOKE_${recordId}_${clinicianAccountId}`);
    setShareFeedbackBanner(null);
    try {
      const res = await appFetch("/api/medpool/state", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-medpool-account-id": "acct-patient-1",
        },
        body: JSON.stringify({
          action: "REVOKE_RECORD_SHARE",
          recordId,
          clinicianAccountId,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        // Wipe future browser RAM view for that clinician/record and refresh access session
        setClinicianUnlocked((prev) => {
          const copy = { ...(prev[clinicianAccountId] || {}) };
          delete copy[recordId];
          return { ...prev, [clinicianAccountId]: copy };
        });
        const refreshed = await refreshTideSessionToken();
        await appFetch("/api/medpool/state", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "REFRESH_CLINICIAN_ACCESS",
            accountId: clinicianAccountId,
          }),
        });
        await fetchState();
        const clinicianName =
          data.revokedGrant?.clinicianName || clinicianAccountId;
        setRevocationRefreshNotice(
          `Withdrew ${clinicianName}'s access to ${recordId} and triggered "Refresh Access" (${
            refreshed.refreshedLiveToken
              ? "IAMService.updateIamToken()"
              : "Session & Policy Sync"
          }). ${clinicianName}'s next decryption request for ${recordId} will be refused (HTTP 403), while other clinicians' grants remain active. Note: ${REVOCATION_HONESTY_NOTE}`
        );
      }
    } finally {
      setBusyAction(null);
    }
  };

  // Care Passport Step 3.2: Clinician attempts to decrypt a specific record in browser RAM
  const handleClinicianOpenRecord = async (
    clinicianAccountId: string,
    recordId: string
  ) => {
    setBusyAction(`OPEN_${clinicianAccountId}_${recordId}`);
    setClinicianRefusal((prev) => ({ ...prev, [clinicianAccountId]: null }));
    try {
      const res = await appFetch("/api/medpool/state", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-medpool-account-id": clinicianAccountId,
        },
        body: JSON.stringify({
          action: "DECRYPT_SHARED_RECORD",
          clinicianAccountId,
          recordId,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        // Server refused decryption (not shared or revoked) -> wipe any cached plaintext for this record
        setClinicianUnlocked((prev) => {
          const copy = { ...(prev[clinicianAccountId] || {}) };
          delete copy[recordId];
          return { ...prev, [clinicianAccountId]: copy };
        });
        setClinicianRefusal((prev) => ({
          ...prev,
          [clinicianAccountId]: {
            recordId,
            status: res.status,
            code: data.code || "ACCESS_REFUSED",
            ruleStoppedIt:
              data.ruleStoppedIt ||
              "RelationshipAttestation:1 + Server verifyAttestation()",
            error:
              data.error ||
              `Access refused (HTTP ${res.status}): Record ${recordId} is not shared with you.`,
            time: new Date().toLocaleTimeString(),
          },
        }));
      } else {
        // Server verified owner signature + User policy -> decrypt TideMemory v1 envelope in Browser RAM
        const recordObj = data.record as PatientRecord;
        const plain = await unlockRecordInBrowserSandbox(
          recordObj,
          recordObj.recordId,
          data.policyB64,
          false
        );
        setClinicianUnlocked((prev) => ({
          ...prev,
          [clinicianAccountId]: {
            ...(prev[clinicianAccountId] || {}),
            [recordId]: plain,
          },
        }));
      }
      await fetchState();
    } finally {
      setBusyAction(null);
    }
  };

  // Task A: Log metadata search in Audit Trail
  const handleLogMetadataSearch = async () => {
    setBusyAction("LOG_SEARCH");
    await appFetch("/api/medpool/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "LOG_METADATA_SEARCH",
        hospital: hospitalFilter,
        icd10: icdFilter,
        ageGroup: ageFilter,
        dateFrom,
        dateTo,
        matchCount: state?.records.length ?? 0,
      }),
    });
    await fetchState();
    setBusyAction(null);
  };

  const handleClearFilters = () => {
    setHospitalFilter("");
    setIcdFilter("");
    setAgeFilter("");
    setDateFrom("");
    setDateTo("");
  };

  // Task B: Patient signs `self`-mode Consent Attestation tied to recordId & studyId
  const handlePatientSignConsent = async () => {
    setBusyAction("PATIENT_CONSENT");
    setSandboxError(null);
    try {
      const prepRes = await appFetch("/api/medpool/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "PREPARE_PATIENT_CONSENT",
          recordId: selectedConsentRecordId,
          studyId: "/studies/study-42",
        }),
      });
      const prep = await prepRes.json();
      const bytesToSign = fromBase64(prep.bytesToSignB64);

      const keyPair = (await crypto.subtle.generateKey(
        { name: "Ed25519" },
        true,
        ["sign", "verify"]
      )) as CryptoKeyPair;
      const sigBuffer = await crypto.subtle.sign(
        { name: "Ed25519" },
        keyPair.privateKey,
        bytesToSign as BufferSource
      );
      const signerPublicJwk = await crypto.subtle.exportKey(
        "jwk",
        keyPair.publicKey
      );
      const signatureB64 = toBase64(new Uint8Array(sigBuffer));

      const subRes = await appFetch("/api/medpool/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "SUBMIT_PATIENT_CONSENT",
          recordId: prep.recordId,
          studyId: prep.studyId,
          patientVuid: prep.patientVuid,
          expiry: prep.statement.expiry,
          signatureB64,
          signerPublicJwk,
          dpopThumbprint: "jkt_es256_patient_browser_dpop",
          applyToAllCohort: applyConsentToAll,
        }),
      });
      if (!subRes.ok) {
        const err = await subRes.json();
        throw new Error(err.error || "Consent signature verification failed");
      }
      await fetchState();
    } catch (e: any) {
      setSandboxError(e?.message || String(e));
    } finally {
      setBusyAction(null);
    }
  };

  // Researcher requests access to `/studies/study-42` (Creates HTTP 202 Change Request)
  const handleRequestStudyAccess = async () => {
    setBusyAction("REQUEST_ACCESS");
    setEthicsBanner(null);
    try {
      const res = await appFetch("/api/medpool/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "REQUEST_STUDY_ACCESS",
          researcherUsername: "dr.chen@medpool.org",
        }),
      });
      const data = await res.json();
      setEthicsBanner({
        type: "info",
        text: `HTTP ${res.status} Accepted: Access Request ${data.changeRequest?.id} queued in PENDING status. Requires 2-of-3 Ethics Board signatures before group membership applies.`,
      });
      await fetchState();
    } finally {
      setBusyAction(null);
    }
  };

  // Task C & D: Researcher attempts to unlock records in Browser Sandbox
  const handleUnlockAndAnalyzeInBrowser = async (specificRecordId?: string) => {
    if (!state) return;
    setBusyAction(
      specificRecordId ? `OPEN_${specificRecordId}` : "SANDBOX_DECRYPT"
    );
    setSandboxError(null);
    setExportBlockNotice(null);

    try {
      const targetIds = specificRecordId
        ? [specificRecordId]
        : state.records.map((r) => r.recordId);

      const res = await appFetch("/api/medpool/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "UNLOCK_RECORD_PAYLOAD",
          recordIds: targetIds,
          actorRole: "researcher",
          actorName: "Researcher (dr.chen@medpool.org)",
          dpopThumbprint: "jkt_es256_researcher_dpop_bound",
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        await fetchState();
        throw new Error(
          data.error ||
            "403 Policy Rejected: Unlock requires Patient Attestation + 2/3 Ethics Quorum + Bound Token."
        );
      }

      const unlockedRecords = (data.records || []) as PatientRecord[];
      const policyB64 = data.policy?.policyB64 || "";

      const decryptedMap: Record<string, ClinicalPayloadPlaintext> = {
        ...unlockedPlaintexts,
      };
      for (const rec of unlockedRecords) {
        decryptedMap[rec.recordId] = await unlockRecordInBrowserSandbox(
          rec,
          state.studyGroupId,
          policyB64,
          false
        );
      }

      setUnlockedPlaintexts(decryptedMap);
      const analytics = runInBrowserClinicalAnalytics(
        unlockedRecords,
        decryptedMap
      );
      setSandboxAnalytics(analytics);
      await fetchState();
    } catch (e: any) {
      if (!specificRecordId) {
        setUnlockedPlaintexts({});
        setSandboxAnalytics(null);
      }
      setSandboxError(e?.message || String(e));
    } finally {
      setBusyAction(null);
    }
  };

  // Task E: Run Policy-Scoped AI Assistant inside Browser Sandbox
  const handleRunAiAssistant = async (
    mode: "ALLOWED_SUMMARY" | "DENIED_PII_NOTES"
  ) => {
    if (!state) return;
    setBusyAction(`AI_${mode}`);
    const requestedFields =
      mode === "ALLOWED_SUMMARY"
        ? [
            "biomarkers.lvefPercent",
            "biomarkers.troponinNgL",
            "biomarkers.ntProBnpPgMl",
            "biomarkers.adverseGrade",
            "icd10Code",
            "ageGroup",
          ]
        : [
            "clinicalNotes",
            "patientDisplayName",
            "patientVuid",
            "medications",
          ];
    const promptText =
      mode === "ALLOWED_SUMMARY"
        ? "Compute LVEF & hs-Troponin-T cardiotoxicity summary across consented cohort records"
        : "Extract raw physician clinicalNotes, patientDisplayName, and medications for individual patients";

    await appFetch("/api/medpool/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "AI_AGENT_QUERY",
        queryType: mode,
        requestedFields,
        promptText,
      }),
    });

    const result = runPolicyScopedAiAssistantInBrowser(
      state.records,
      unlockedPlaintexts,
      requestedFields,
      promptText,
      state.relationshipPolicy?.allowedAiFields ?? DEFAULT_ALLOWED_AI_FIELDS
    );
    setAiResponse(result);
    await fetchState();
    setBusyAction(null);
  };

  // Ethics Board Member signs Change Request
  const handleEthicsApprove = async (crId: string, adminId: string) => {
    setBusyAction(`APPROVE_${adminId}`);
    setEthicsBanner(null);
    try {
      const res = await appFetch("/api/medpool/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "ETHICS_AUTHORIZE_CR",
          crId,
          adminId,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setEthicsBanner({ type: "error", text: data.error });
      } else {
        const count = data.changeRequest.approvals.length;
        setEthicsBanner({
          type: count >= 2 ? "success" : "info",
          text:
            count >= 2
              ? `2-of-3 Quorum Reached (${count}/2 required signatures)! Click "Commit Approved Quorum" to seal '/studies/study-42' group membership.`
              : `1-of-3 Approval Recorded (${count}/2 required). Quorum is not met yet — attempting to commit or unlock now will be rejected.`,
        });
      }
      await fetchState();
    } finally {
      setBusyAction(null);
    }
  };

  // Commit Change Request
  const handleEthicsCommit = async (crId: string) => {
    setBusyAction(`COMMIT_${crId}`);
    setEthicsBanner(null);
    try {
      const res = await appFetch("/api/medpool/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "ETHICS_COMMIT_CR",
          crId,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setEthicsBanner({
          type: "error",
          text: data.error,
        });
      } else {
        setEthicsBanner({
          type: "success",
          text: `HTTP 200 OK: Change Request ${crId} committed! VVK ORK network sealed '/studies/study-42' into the Researcher's bound token claims.`,
        });
      }
      await fetchState();
    } finally {
      setBusyAction(null);
    }
  };

  // Feature 3 / Step 3.5: "Try to break it" Rogue Operator / Admin Failure Paths
  const handleRogueAttack = async (
    attackAction:
      | "ROGUE_OPEN_PAYLOAD"
      | "ROGUE_SELF_GRANT_RECORD"
      | "ROGUE_SHARE_ON_PATIENT_BEHALF"
      | "ROGUE_SELF_ETHICS_BOARD"
      | "ROGUE_CHANGE_QUORUM_RULE"
      | "ROGUE_GRANT_RESEARCHER_ACCESS"
  ) => {
    setBusyAction(attackAction);
    try {
      const res = await appFetch("/api/medpool/state", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-medpool-account-id": "acct-rogue-1",
        },
        body: JSON.stringify({
          action: attackAction,
          recordId:
            attackAction === "ROGUE_SHARE_ON_PATIENT_BEHALF"
              ? "CP-REC-003"
              : "CP-REC-001",
        }),
      });
      const data = await res.json();
      setRogueAttempts((prev) => ({
        ...prev,
        [attackAction]: {
          blocked: true,
          status:
            data.httpStatusOnUnilateralCommit || data.httpStatus || res.status,
          code: data.reasonCode || "BLOCKED",
          ruleStoppedIt:
            data.ruleStoppedIt || "TideCloak Cryptographic IGA + VVK ORKs",
          reason: data.error,
          time: new Date().toLocaleTimeString(),
        },
      }));
      await fetchState();
    } finally {
      setBusyAction(null);
    }
  };

  // Feature 6: Policy Transparency — Propose a rule change (requires 2/3 Ethics Board quorum)
  const handleProposePolicyRuleChange = async (proposedChange: string) => {
    setBusyAction("PROPOSE_POLICY_RULE");
    setPolicyRuleNotice(null);
    try {
      const res = await appFetch("/api/medpool/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "PROPOSE_POLICY_RULE_CHANGE",
          proposedChange,
          actor: currentAccount?.name || ROLE_METADATA[viewMode].actorName,
        }),
      });
      const data = await res.json();
      setPolicyRuleNotice(
        `HTTP ${res.status} Queued (${data.changeRequest?.id}): "${proposedChange}" cannot be applied unilaterally. Requires 2-of-3 Ethics Board quorum approval; attempt recorded in Audit Trail.`
      );
      await fetchState();
    } finally {
      setBusyAction(null);
    }
  };

  // Feature 7: Fast-forward time-limited access expiry for instant demo verification
  const handleFastForwardExpiry = async () => {
    setBusyAction("FAST_FORWARD_EXPIRY");
    try {
      await appFetch("/api/medpool/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "EXPIRE_STUDY_ACCESS" }),
      });
      setUnlockedPlaintexts({});
      setSandboxAnalytics(null);
      setAiResponse(null);
      await refreshTideSessionToken();
      await fetchState();
      setRevocationRefreshNotice(
        "Time-limited access expired (00:00). Access to '/studies/study-42' has ended, decrypted sandbox memory was wiped, and STUDY_ACCESS_EXPIRED was recorded in the Audit Trail."
      );
    } finally {
      setBusyAction(null);
    }
  };

  // Feature 8: Export Audit Log as a file (log metadata only, NEVER clinical record content)
  const handleExportAuditLog = (
    entries: AuditLogEntry[],
    format: "json" | "csv"
  ) => {
    const safeEntries = entries.map((e) => ({
      id: e.id,
      timestamp: e.timestamp,
      actor: e.actor,
      category: e.category || "GENERAL",
      action: e.action,
      httpStatus: e.httpStatus,
      outcome: e.outcome,
      detail: e.detail,
    }));

    let content = "";
    let mime = "application/json";
    let ext = "json";

    if (format === "json") {
      content = JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          studyGroupId: state?.studyGroupId || "/studies/study-42",
          exportPolicy:
            "AUDIT_LOG_METADATA_ONLY — Zero clinical record payloads included",
          entryCount: safeEntries.length,
          entries: safeEntries,
        },
        null,
        2
      );
    } else {
      mime = "text/csv";
      ext = "csv";
      const header =
        "id,timestamp,actor,category,action,httpStatus,outcome,detail";
      const rows = safeEntries.map((r) =>
        [
          r.id,
          r.timestamp,
          `"${r.actor.replace(/"/g, '""')}"`,
          r.category,
          `"${r.action.replace(/"/g, '""')}"`,
          r.httpStatus,
          r.outcome,
          `"${r.detail.replace(/"/g, '""')}"`,
        ].join(",")
      );
      content = [header, ...rows].join("\n");
    }

    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `medpool-audit-log-${new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/:/g, "-")}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Gotcha #10: Manual & automatic session refresh handler so revocations/role changes apply right away
  const handleRefreshAccessSession = async () => {
    setBusyAction("REFRESH_ACCESS");
    try {
      const refreshed = await refreshTideSessionToken();
      await fetchState();
      setRevocationRefreshNotice(
        refreshed.refreshedLiveToken
          ? `Session refreshed via IAMService.updateIamToken() at ${new Date(
              refreshed.timestamp
            ).toLocaleTimeString()} — latest role, group, and revocation claims are active.`
          : `Session state refreshed at ${new Date(
              refreshed.timestamp
            ).toLocaleTimeString()} — latest role, group, and revocation claims are active.`
      );
    } finally {
      setBusyAction(null);
    }
  };

  // Task G & Gotcha #10: Confirm Revocation Modal Handler (automatically triggers session refresh)
  const handleConfirmRevoke = async () => {
    if (!revokeModalTarget) return;
    const target = revokeModalTarget;
    const actorLabel =
      target === "PATIENT_CONSENT"
        ? "Patient Portal (Elena R. — Self-Sovereign Revocation)"
        : target === "ETHICS_APPROVAL"
        ? "Ethics Board Member (Withdrew Quorum Signature)"
        : "Governance Revocation";

    setBusyAction(`REVOKE_${target}`);
    setUnlockedPlaintexts({});
    setSandboxAnalytics(null);
    setAiResponse(null);
    setSandboxError(
      `Access Terminated (${target}): Decrypted clinical payloads were immediately purged from browser memory. Future unlock requests are blocked.`
    );
    try {
      await appFetch("/api/medpool/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "REVOKE_ACCESS",
          revokeTarget: target,
          actor: actorLabel,
        }),
      });
      setRevokeModalTarget(null);
      // Gotcha #10: Automatically refresh the Tide session token immediately after a revoke
      const refreshed = await refreshTideSessionToken();
      await fetchState();
      setRevocationRefreshNotice(
        `Revocation (${target}) applied and session refreshed (${
          refreshed.refreshedLiveToken
            ? "IAMService.updateIamToken()"
            : "Immediate Demo Session Sync"
        }) at ${new Date(
          refreshed.timestamp
        ).toLocaleTimeString()}. All in-browser decrypted records are wiped.`
      );
    } finally {
      setBusyAction(null);
    }
  };

  if (loading || !state) {
    return (
      <div
        className="mp-shell"
        style={{
          alignItems: "center",
          justifyContent: "center",
          padding: "40px",
        }}
      >
        <div className="mp-card" style={{ maxWidth: "460px", textAlign: "center" }}>
          <div style={{ marginBottom: "8px", color: "var(--mp-primary)" }}>
            <IconShield size={28} />
          </div>
          <h2 style={{ margin: "0 0 6px 0", fontSize: "17px" }}>
            Loading MedPool Clinical Research Console…
          </h2>
          <p style={{ margin: 0, fontSize: "13px", color: "var(--mp-text-muted)" }}>
            Verifying TideCloak adapter, RelationshipAttestation:1 policy, and encrypted cohort metadata.
          </p>
        </div>
      </div>
    );
  }

  const { emergentAuthority } = state;
  const liveVuid = authenticated
    ? (getValueFromToken("vuid") as string) || undefined
    : undefined;
  const currentAccount = resolveActiveAccount(
    state.accounts || [],
    storedAccountId,
    liveVuid
  );
  const pendingRoleRequestsCount = (state.roleRequests || []).filter(
    (rr) => rr.status === "PENDING"
  ).length;
  const activeResearcherCr = state.changeRequests.find(
    (cr) =>
      cr.requestedByRole === "researcher" &&
      cr.targetGroupOrRole === state.studyGroupId
  );
  const approvalsCount = activeResearcherCr?.approvals.length ?? 0;
  const threshold = activeResearcherCr?.threshold ?? 2;
  const sandboxUnlocked = Object.keys(unlockedPlaintexts).length > 0;

  const filteredAuditLog = state.auditLog.filter((entry) => {
    if (
      auditCategoryFilter !== "ALL" &&
      entry.category !== auditCategoryFilter
    ) {
      return false;
    }
    if (
      auditActorFilter &&
      !entry.actor.toLowerCase().includes(auditActorFilter.toLowerCase()) &&
      !entry.action.toLowerCase().includes(auditActorFilter.toLowerCase())
    ) {
      return false;
    }
    return true;
  });

  return (
    <div className="mp-shell">
      {/* ====================================================================
          TOP INSTITUTIONAL HEADER + ACTIVE ROLE INDICATOR + THEME TOGGLE
          ==================================================================== */}
      <header className="mp-header">
        <div className="mp-header-inner">
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <div
              style={{
                width: "38px",
                height: "38px",
                borderRadius: "10px",
                backgroundColor: "var(--mp-primary)",
                color: "#ffffff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: 700,
                fontSize: "15px",
                boxShadow: "var(--mp-shadow-sm)",
              }}
            >
              MP
            </div>
            <div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  flexWrap: "wrap",
                }}
              >
                <span style={{ fontWeight: 700, fontSize: "16px" }}>
                  Care Passport · MedPool
                </span>
                <StatusBadge
                  tone="primary"
                  icon="shield"
                  label="TideCloak Per-Record Sharing"
                />
                <span
                  className="mp-mono"
                  style={{
                    fontSize: "11px",
                    color: "var(--mp-text-muted)",
                  }}
                >
                  Patient: Elena Rostova (PAT-9041)
                </span>
              </div>
              <div
                style={{
                  fontSize: "12px",
                  color: "var(--mp-text-secondary)",
                }}
              >
                1 Record → 1 Clinician · Zero Master Keys · Cryptographic Attestation &amp; In-Browser Decryption
              </div>
            </div>
          </div>

          {/* Right Header Controls: Auth Links + Active Role Indicator + Demo Helper Toggle + Theme */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              flexWrap: "wrap",
            }}
          >
            {/* Active Session Role Indicator */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "5px 11px",
                borderRadius: "var(--mp-radius-sm)",
                backgroundColor: "var(--mp-bg-subtle)",
                border: "1px solid var(--mp-border-strong)",
                fontSize: "12px",
              }}
              title="Active session role"
            >
              <span
                style={{
                  width: "8px",
                  height: "8px",
                  borderRadius: "9999px",
                  backgroundColor:
                    viewMode === "sysadmin"
                      ? "var(--mp-danger)"
                      : viewMode === "pending"
                      ? "var(--mp-pending)"
                      : "var(--mp-primary)",
                }}
              />
              <span style={{ color: "var(--mp-text-muted)" }}>
                {currentAccount ? "Signed In:" : "Active View:"}
              </span>
              <strong>
                {currentAccount
                  ? currentAccount.name
                  : ROLE_METADATA[viewMode].actorName}
              </strong>
              <span
                className="mp-mono"
                style={{
                  fontSize: "11px",
                  color: "var(--mp-primary-text)",
                  backgroundColor: "var(--mp-primary-soft)",
                  padding: "1px 6px",
                  borderRadius: "4px",
                }}
              >
                {currentAccount
                  ? `Role: ${currentAccount.activeRole}`
                  : ROLE_METADATA[viewMode].badge}
              </span>
            </div>

            <Link
              href="/why"
              className="mp-btn mp-btn-secondary mp-btn-sm"
            >
              Why This Works
            </Link>

            <Link
              href="/trust"
              className="mp-btn mp-btn-secondary mp-btn-sm"
            >
              Trust Map
            </Link>

            <button
              type="button"
              onClick={() => setGuidedDemoOpen((v) => !v)}
              className="mp-btn mp-btn-primary mp-btn-sm"
            >
              {guidedDemoOpen ? "Hide Guided Demo" : "Guided Demo (6 Steps)"}
            </button>

            <Link
              href="/signup"
              className="mp-btn mp-btn-secondary mp-btn-sm"
            >
              Sign Up
            </Link>

            <Link
              href="/login"
              className="mp-btn mp-btn-secondary mp-btn-sm"
            >
              {currentAccount ? "Switch Account" : "Sign In"}
            </Link>

            <Link
              href="/profile"
              className="mp-btn mp-btn-secondary mp-btn-sm"
            >
              Profile
              {pendingRoleRequestsCount > 0 && (
                <span
                  style={{
                    marginLeft: "4px",
                    padding: "0 5px",
                    borderRadius: "9999px",
                    backgroundColor: "var(--mp-pending-bg)",
                    color: "var(--mp-pending)",
                    fontSize: "10.5px",
                    fontWeight: 700,
                  }}
                >
                  {pendingRoleRequestsCount}
                </span>
              )}
            </Link>

            {currentAccount && (
              <button
                type="button"
                onClick={() => handleLogoutAccount(currentAccount)}
                disabled={busyAction !== null}
                className="mp-btn mp-btn-danger mp-btn-sm"
              >
                Sign Out
              </button>
            )}

            <button
              type="button"
              onClick={handleRefreshAccessSession}
              disabled={busyAction !== null}
              className="mp-btn mp-btn-secondary mp-btn-sm"
              title="Gotcha #10: Refresh session token so revocation or role updates apply immediately"
            >
              Refresh Access
            </button>

            <button
              type="button"
              onClick={() => setShowDemoHelper((v) => !v)}
              className="mp-btn mp-btn-secondary mp-btn-sm"
            >
              {showDemoHelper ? "Hide Demo Switcher" : "Show Demo Switcher"}
            </button>

            <button
              type="button"
              onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
              className="mp-btn mp-btn-secondary mp-btn-sm"
              aria-label="Toggle color theme"
            >
              {theme === "light" ? "Dark Mode" : "Light Mode"}
            </button>

            <button
              type="button"
              onClick={handleResetDemo}
              disabled={busyAction !== null}
              className="mp-btn mp-btn-secondary mp-btn-sm"
            >
              Reset Demo State
            </button>
          </div>
        </div>

        {/* Collapsible Demo Mode Role & Seeded Account Switcher Bar */}
        {showDemoHelper && (
          <div
            style={{
              backgroundColor: "var(--mp-bg-subtle)",
              borderTop: "1px solid var(--mp-border)",
              padding: "8px 20px",
            }}
          >
            <div
              className="mp-container"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "8px",
                padding: 0,
              }}
            >
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "8px",
                }}
              >
                <span
                  style={{
                    fontSize: "12px",
                    fontWeight: 600,
                    color: "var(--mp-text-secondary)",
                  }}
                >
                  Seeded Demo Accounts (Click to sign in &amp; log audit event):
                </span>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                  {(state.accounts || []).map((acct) => {
                    const isCurrent = currentAccount?.id === acct.id;
                    return (
                      <button
                        key={acct.id}
                        type="button"
                        onClick={() => handleSwitchDemoAccount(acct)}
                        disabled={busyAction !== null}
                        className={`mp-btn mp-btn-sm ${
                          isCurrent ? "mp-btn-primary" : "mp-btn-secondary"
                        }`}
                        title={`${acct.email} (${getRoleDisplayLabel(acct.activeRole)})`}
                      >
                        <span>{acct.name.split(" (")[0]}</span>
                        <span
                          className="mp-mono"
                          style={{
                            fontSize: "10px",
                            opacity: 0.85,
                          }}
                        >
                          [{acct.activeRole}]
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "8px",
                  paddingTop: "4px",
                  borderTop: "1px dashed var(--mp-border)",
                }}
              >
                <span
                  style={{
                    fontSize: "11.5px",
                    color: "var(--mp-text-muted)",
                  }}
                >
                  Workspace Layout View:
                </span>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                  {(
                    [
                      ["quad", "All Roles (Split View)"],
                      ["patient", "Patient (3 Encrypted Records)"],
                      ["gp", "GP (Dr. Aris Thorne)"],
                      ["physio", "Physio (Dr. Maya Lin)"],
                      ["sysadmin", "Rogue Operator (Blocked)"],
                      ["researcher", "Cohort Study #42"],
                      ["ethics", "Ethics Board (2/3 Quorum)"],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setViewMode(key)}
                      className={`mp-btn mp-btn-sm ${
                        viewMode === key ? "mp-btn-accent" : "mp-btn-secondary"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </header>

      {/* ====================================================================
          MAIN CONTENT CONTAINER
          ==================================================================== */}
      <main
        className="mp-container"
        style={{
          paddingTop: "20px",
          paddingBottom: "48px",
          display: "flex",
          flexDirection: "column",
          gap: "20px",
          flex: 1,
        }}
      >
        {/* Gotcha #3, #4, #5, #10 Operational Guardrails Strip */}
        <section
          aria-label="TideCloak Enclave Operational Guardrails"
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px",
            padding: "10px 14px",
            borderRadius: "var(--mp-radius-md)",
            backgroundColor: "var(--mp-bg-subtle)",
            border: "1px solid var(--mp-border-strong)",
            fontSize: "12px",
          }}
        >
          <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", alignItems: "center" }}>
            <StatusBadge tone="primary" icon="shield" label="DPoP secureFetch Active" />
            <span>
              <strong>Allow Pop-Ups:</strong> Tide sign-in &amp; enclave approvals open a small Tide window.
            </span>
            <span>·</span>
            <span>
              <strong>Browser Only:</strong> No headless/CLI sign-in; AI Agent relies on a researcher signing in via the browser first.
            </span>
            <span>·</span>
            <span>
              <strong>Revocation Timing:</strong> Access changes apply on next token refresh.
            </span>
          </div>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <button
              type="button"
              onClick={() => {
                setPopupBlockedNotice(null);
                runWithPopupDetection(
                  () => tideLogin(),
                  (msg) => setPopupBlockedNotice(msg)
                );
              }}
              className="mp-btn mp-btn-secondary mp-btn-sm"
            >
              Launch Tide Enclave Window
            </button>
            <button
              type="button"
              onClick={handleRefreshAccessSession}
              disabled={busyAction !== null}
              className="mp-btn mp-btn-primary mp-btn-sm"
            >
              Refresh Access Now
            </button>
          </div>
        </section>

        {popupBlockedNotice && (
          <div role="alert" className="mp-callout mp-callout--danger">
            <IconBan size={18} />
            <div style={{ flex: 1 }}>
              <div className="mp-callout__title">Pop-Up Window Blocked</div>
              <div className="mp-callout__desc">{popupBlockedNotice}</div>
            </div>
            <button
              type="button"
              className="mp-btn mp-btn-primary mp-btn-sm"
              onClick={() => {
                setPopupBlockedNotice(null);
                runWithPopupDetection(
                  () => tideLogin(),
                  (msg) => setPopupBlockedNotice(msg)
                );
              }}
            >
              Retry Tide Window
            </button>
          </div>
        )}

        {revocationRefreshNotice && (
          <div role="status" className="mp-callout mp-callout--teal">
            <IconCheck size={18} />
            <div style={{ flex: 1 }}>
              <div className="mp-callout__title">Session Access Refreshed</div>
              <div className="mp-callout__desc">{revocationRefreshNotice}</div>
            </div>
            <button
              type="button"
              className="mp-btn mp-btn-secondary mp-btn-sm"
              onClick={() => setRevocationRefreshNotice(null)}
            >
              Dismiss
            </button>
          </div>
        )}

        {/* ==================================================================
            SCREEN 1: CARE PASSPORT HERO + THE ONE POSSIBILITY + HONESTY NOTE
            ================================================================== */}
        <section
          aria-label="Care Passport Platform Overview"
          className="mp-card-elevated"
          style={{
            borderLeft: "4px solid var(--mp-primary)",
            padding: "22px 24px",
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "16px",
            }}
          >
            <div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  marginBottom: "6px",
                  flexWrap: "wrap",
                }}
              >
                <StatusBadge
                  tone="primary"
                  icon="shield"
                  label="Care Passport · Per-Record, Per-Clinician Sharing"
                />
                <StatusBadge
                  tone="neutral"
                  icon="lock"
                  label="14-of-20 Tide ORK Threshold Network"
                />
                <StatusBadge
                  tone="neutral"
                  icon="check"
                  label="Ed25519 verifyAttestation (AP-AT01)"
                />
              </div>
              <h1
                style={{
                  margin: "4px 0 6px 0",
                  fontSize: "21px",
                  fontWeight: 700,
                  lineHeight: 1.3,
                  color: "var(--mp-text)",
                }}
              >
                &ldquo;A patient can share exactly one record with exactly one clinician, and no operator, admin or provider can read the rest or override that choice.&rdquo;
              </h1>
              <p
                style={{
                  margin: "0 0 12px 0",
                  fontSize: "13.5px",
                  color: "var(--mp-text-secondary)",
                  maxWidth: "980px",
                }}
              >
                <strong>How Care Passport Works:</strong> Elena Rostova holds <strong>3 encrypted health records</strong> (<code>CP-REC-001</code> Specialist Referral, <code>CP-REC-002</code> Physiotherapy Care Plan, <code>CP-REC-003</code> Genomic &amp; Pathology Summary). Each record is sealed in its own <code>TideMemory</code> v1 envelope with a unique per-record tag. By default, <strong>nobody</strong> can open any record. When Elena shares a single record with a single clinician, she signs an Ed25519 <code>owner</code>-mode <code>shared-with</code> attestation binding <code>(Patient, Clinician, RecordId)</code> and a matching per-record <code>RelationshipAttestation:1</code> policy.
              </p>

              {/* Required Honesty Note in UI */}
              <div
                role="note"
                style={{
                  padding: "10px 14px",
                  borderRadius: "var(--mp-radius-sm)",
                  backgroundColor: "var(--mp-pending-bg)",
                  border: "1px solid var(--mp-pending-border)",
                  fontSize: "12.5px",
                  color: "var(--mp-text)",
                  marginBottom: "12px",
                }}
              >
                <strong>Honesty Note on Revocation:</strong>{" "}
                {state.honestyNote ||
                  REVOCATION_HONESTY_NOTE}
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                <button
                  type="button"
                  onClick={() => setGuidedDemoOpen(true)}
                  className="mp-btn mp-btn-primary"
                >
                  <IconShield size={15} />
                  <span>Start 6-Step Guided Demo →</span>
                </button>
                <button
                  type="button"
                  onClick={handleGrantTargetDemoPair}
                  disabled={busyAction !== null}
                  className="mp-btn mp-btn-accent"
                >
                  <IconCheck size={15} />
                  <span>Step 2 Quick Action: Share Referral → GP &amp; Care Plan → Physio</span>
                </button>
                <Link href="/why" className="mp-btn mp-btn-secondary">
                  Why This Works (Visual Diagram)
                </Link>
                <Link href="/trust" className="mp-btn mp-btn-secondary">
                  Trust Map (Honesty Matrix)
                </Link>
              </div>
            </div>
          </div>
        </section>

        {/* ==================================================================
            CARE PASSPORT PANEL A: PATIENT'S 3 ENCRYPTED RECORDS & PER-CLINICIAN SHARING
            ================================================================== */}
        {(viewMode === "quad" || viewMode === "patient" || viewMode === "gp" || viewMode === "physio") && (
          <section
            id="section-care-passport"
            aria-label="Care Passport Per-Record Per-Clinician Sharing"
            className="mp-card"
          >
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "10px",
                paddingBottom: "14px",
                borderBottom: "1px solid var(--mp-border)",
                marginBottom: "14px",
              }}
            >
              <div>
                <div
                  style={{
                    fontSize: "11px",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    color: "var(--mp-primary)",
                  }}
                >
                  Step 1 &amp; Step 2 · Patient&apos;s Care Passport (Elena Rostova · PAT-9041)
                </div>
                <h2 style={{ margin: "2px 0 0 0", fontSize: "16px", fontWeight: 700 }}>
                  3 Encrypted Health Records — Per-Record, Per-Clinician Sharing Matrix
                </h2>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                <StatusBadge
                  tone={
                    (state.shareGrants || []).some((g) => g.status === "ACTIVE")
                      ? "success"
                      : "neutral"
                  }
                  icon="lock"
                  label={`${
                    (state.shareGrants || []).filter((g) => g.status === "ACTIVE").length
                  } Active Clinician Share Grants`}
                />
                <button
                  type="button"
                  onClick={handleGrantTargetDemoPair}
                  disabled={busyAction !== null}
                  className="mp-btn mp-btn-primary mp-btn-sm"
                >
                  Share Referral → GP &amp; Care Plan → Physio
                </button>
                <button
                  type="button"
                  onClick={handleRefreshAccessSession}
                  disabled={busyAction !== null}
                  className="mp-btn mp-btn-secondary mp-btn-sm"
                >
                  Refresh Access
                </button>
              </div>
            </div>

            {shareFeedbackBanner && (
              <div
                role="status"
                className={`mp-callout ${
                  shareFeedbackBanner.type === "success"
                    ? "mp-callout--teal"
                    : shareFeedbackBanner.type === "error"
                    ? "mp-callout--danger"
                    : "mp-callout--info"
                }`}
                style={{ marginBottom: "14px" }}
              >
                {shareFeedbackBanner.type === "success" ? (
                  <IconCheck size={17} />
                ) : (
                  <IconBan size={17} />
                )}
                <div style={{ flex: 1 }}>
                  <div className="mp-callout__desc">{shareFeedbackBanner.text}</div>
                </div>
                <button
                  type="button"
                  onClick={() => setShareFeedbackBanner(null)}
                  className="mp-btn mp-btn-secondary mp-btn-sm"
                >
                  Dismiss
                </button>
              </div>
            )}

            <div className="mp-grid-3">
              {state.records.map((rec) => {
                const gpGrant = (state.shareGrants || []).find(
                  (g) => g.recordId === rec.recordId && g.clinicianAccountId === "acct-gp-1"
                );
                const physioGrant = (state.shareGrants || []).find(
                  (g) => g.recordId === rec.recordId && g.clinicianAccountId === "acct-physio-1"
                );
                const gpActive = gpGrant?.status === "ACTIVE";
                const physioActive = physioGrant?.status === "ACTIVE";
                const anyRevoked =
                  gpGrant?.status === "REVOKED" || physioGrant?.status === "REVOKED";

                return (
                  <div
                    key={rec.recordId}
                    style={{
                      padding: "14px",
                      borderRadius: "var(--mp-radius-md)",
                      backgroundColor: "var(--mp-bg-subtle)",
                      border:
                        gpActive || physioActive
                          ? "2px solid var(--mp-primary)"
                          : anyRevoked
                          ? "2px solid var(--mp-danger)"
                          : "1px solid var(--mp-border-strong)",
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "space-between",
                      gap: "12px",
                    }}
                  >
                    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "6px",
                          flexWrap: "wrap",
                        }}
                      >
                        <span className="mp-mono" style={{ fontWeight: 700, fontSize: "12.5px" }}>
                          {rec.recordId}
                        </span>
                        {gpActive || physioActive ? (
                          <StatusBadge
                            tone="success"
                            icon="check"
                            label={`Shared (${
                              [gpActive ? "GP" : null, physioActive ? "Physio" : null]
                                .filter(Boolean)
                                .join(", ")
                            })`}
                          />
                        ) : anyRevoked ? (
                          <StatusBadge tone="danger" icon="ban" label="Revoked (Locked)" />
                        ) : (
                          <StatusBadge tone="neutral" icon="lock" label="Locked (No Clinician)" />
                        )}
                      </div>

                      <div>
                        <div style={{ fontWeight: 700, fontSize: "14px", color: "var(--mp-text)" }}>
                          {rec.title}
                        </div>
                        <div style={{ fontSize: "11.5px", color: "var(--mp-text-secondary)" }}>
                          {rec.hospitalOrigin} · {rec.icd10Code} ({rec.icd10Category})
                        </div>
                      </div>

                      <div
                        className="mp-mono"
                        style={{
                          padding: "6px 8px",
                          borderRadius: "var(--mp-radius-sm)",
                          backgroundColor: "var(--mp-surface)",
                          border: "1px solid var(--mp-border)",
                          fontSize: "10.5px",
                          color: "var(--mp-text-muted)",
                        }}
                      >
                        <div>assignmentId: {rec.assignmentId}</div>
                        <div>TideMemory: {rec.ciphertextPreview}</div>
                      </div>

                      {/* Clinician 1: GP (Dr. Aris Thorne) Controls */}
                      <div
                        style={{
                          padding: "8px 10px",
                          borderRadius: "var(--mp-radius-sm)",
                          backgroundColor: "var(--mp-surface)",
                          border: "1px solid var(--mp-border)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "8px",
                        }}
                      >
                        <div>
                          <div style={{ fontSize: "12px", fontWeight: 700 }}>
                            GP · Dr. Aris Thorne
                          </div>
                          <div style={{ fontSize: "11px", color: "var(--mp-text-muted)" }}>
                            {gpActive
                              ? "✓ Active Ed25519 Share Grant"
                              : gpGrant?.status === "REVOKED"
                              ? "✗ Withdrawn by Patient"
                              : "No access granted"}
                          </div>
                        </div>
                        {gpActive ? (
                          <button
                            type="button"
                            onClick={() => handleRevokeRecordShare(rec.recordId, "acct-gp-1")}
                            disabled={busyAction !== null}
                            className="mp-btn mp-btn-danger mp-btn-sm"
                          >
                            Revoke GP
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleGrantRecordShare(rec.recordId, "acct-gp-1")}
                            disabled={busyAction !== null}
                            className="mp-btn mp-btn-primary mp-btn-sm"
                          >
                            Share with GP
                          </button>
                        )}
                      </div>

                      {/* Clinician 2: Physiotherapist (Dr. Maya Lin) Controls */}
                      <div
                        style={{
                          padding: "8px 10px",
                          borderRadius: "var(--mp-radius-sm)",
                          backgroundColor: "var(--mp-surface)",
                          border: "1px solid var(--mp-border)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "8px",
                        }}
                      >
                        <div>
                          <div style={{ fontSize: "12px", fontWeight: 700 }}>
                            Physio · Dr. Maya Lin
                          </div>
                          <div style={{ fontSize: "11px", color: "var(--mp-text-muted)" }}>
                            {physioActive
                              ? "✓ Active Ed25519 Share Grant"
                              : physioGrant?.status === "REVOKED"
                              ? "✗ Withdrawn by Patient"
                              : "No access granted"}
                          </div>
                        </div>
                        {physioActive ? (
                          <button
                            type="button"
                            onClick={() => handleRevokeRecordShare(rec.recordId, "acct-physio-1")}
                            disabled={busyAction !== null}
                            className="mp-btn mp-btn-danger mp-btn-sm"
                          >
                            Revoke Physio
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleGrantRecordShare(rec.recordId, "acct-physio-1")}
                            disabled={busyAction !== null}
                            className="mp-btn mp-btn-accent mp-btn-sm"
                          >
                            Share with Physio
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* ==================================================================
            CARE PASSPORT PANEL B: TWO CLINICIANS, TWO DIFFERENT RECORDS (Step 3 & Step 5)
            ================================================================== */}
        {(viewMode === "quad" || viewMode === "gp" || viewMode === "physio" || viewMode === "patient") && (
          <section
            id="section-clinician-viewer"
            aria-label="Two Clinicians Per-Record Decryption and Refusal Proof"
            className="mp-card"
          >
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "10px",
                paddingBottom: "14px",
                borderBottom: "1px solid var(--mp-border)",
                marginBottom: "14px",
              }}
            >
              <div>
                <div
                  style={{
                    fontSize: "11px",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    color: "var(--mp-accent)",
                  }}
                >
                  Step 3 &amp; Step 5 · Two Clinicians, Two Different Records (Server-Enforced)
                </div>
                <h2 style={{ margin: "2px 0 0 0", fontSize: "16px", fontWeight: 700 }}>
                  Clinician Decryption &amp; Refusal Proof (GP vs. Physiotherapist)
                </h2>
              </div>
              <StatusBadge
                tone="primary"
                icon="shield"
                label="In-Browser doDecrypt() + Server verifyAttestation"
              />
            </div>

            <div className="mp-grid-2">
              {[
                {
                  clinicianId: "acct-gp-1",
                  name: "Dr. Aris Thorne",
                  roleLabel: "General Practitioner (GP)",
                  specialty: "Primary Care · Melbourne Family Clinic",
                  intendedRecord: "CP-REC-001 (Specialist Referral)",
                },
                {
                  clinicianId: "acct-physio-1",
                  name: "Dr. Maya Lin",
                  roleLabel: "Physiotherapist",
                  specialty: "Rehabilitation · St. Jude Allied Health",
                  intendedRecord: "CP-REC-002 (Physiotherapy Care Plan)",
                },
              ].map((clin) => {
                const clinPlaintexts = clinicianUnlocked[clin.clinicianId] || {};
                const activeRefusal = clinicianRefusal[clin.clinicianId];

                return (
                  <div
                    key={clin.clinicianId}
                    style={{
                      padding: "16px",
                      borderRadius: "var(--mp-radius-md)",
                      backgroundColor: "var(--mp-bg-subtle)",
                      border: "1px solid var(--mp-border-strong)",
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
                        gap: "8px",
                        flexWrap: "wrap",
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 700, fontSize: "15px" }}>
                          {clin.name} — {clin.roleLabel}
                        </div>
                        <div style={{ fontSize: "12px", color: "var(--mp-text-secondary)" }}>
                          {clin.specialty} · Intended Share: <strong>{clin.intendedRecord}</strong>
                        </div>
                      </div>
                      <StatusBadge
                        tone="primary"
                        icon="key"
                        label={clin.clinicianId}
                      />
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                      {state.records.map((rec) => {
                        const unlocked = clinPlaintexts[rec.recordId];
                        const refusal =
                          activeRefusal && activeRefusal.recordId === rec.recordId
                            ? activeRefusal
                            : null;
                        const activeGrant = (state.shareGrants || []).find(
                          (g) =>
                            g.recordId === rec.recordId &&
                            g.clinicianAccountId === clin.clinicianId &&
                            g.status === "ACTIVE"
                        );

                        return (
                          <div
                            key={rec.recordId}
                            style={{
                              padding: "12px",
                              borderRadius: "var(--mp-radius-sm)",
                              backgroundColor: "var(--mp-surface)",
                              border: unlocked
                                ? "2px solid var(--mp-success)"
                                : refusal
                                ? "2px solid var(--mp-danger)"
                                : "1px solid var(--mp-border)",
                              display: "flex",
                              flexDirection: "column",
                              gap: "8px",
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                gap: "8px",
                                flexWrap: "wrap",
                              }}
                            >
                              <div>
                                <span
                                  className="mp-mono"
                                  style={{ fontWeight: 700, fontSize: "12px" }}
                                >
                                  {rec.recordId}
                                </span>{" "}
                                ·{" "}
                                <strong style={{ fontSize: "13px" }}>
                                  {rec.title}
                                </strong>
                              </div>
                              <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                                {activeGrant ? (
                                  <StatusBadge
                                    tone="success"
                                    icon="check"
                                    label="Share Active"
                                  />
                                ) : (
                                  <StatusBadge
                                    tone="neutral"
                                    icon="lock"
                                    label="Not Shared"
                                  />
                                )}
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleClinicianOpenRecord(clin.clinicianId, rec.recordId)
                                  }
                                  disabled={busyAction !== null}
                                  className={`mp-btn mp-btn-sm ${
                                    activeGrant ? "mp-btn-primary" : "mp-btn-secondary"
                                  }`}
                                >
                                  {activeGrant
                                    ? `Decrypt ${rec.recordId} as ${clin.name.split(" ")[1]}`
                                    : `Try Opening ${rec.recordId} (Test Refusal)`}
                                </button>
                              </div>
                            </div>

                            {unlocked && (
                              <div
                                role="region"
                                aria-label={`Decrypted ${rec.recordId} for ${clin.name}`}
                                style={{
                                  padding: "10px",
                                  borderRadius: "var(--mp-radius-sm)",
                                  backgroundColor: "var(--mp-success-bg)",
                                  border: "1px solid var(--mp-success-border)",
                                  fontSize: "12px",
                                }}
                              >
                                <div
                                  style={{
                                    fontWeight: 700,
                                    color: "var(--mp-success)",
                                    marginBottom: "4px",
                                  }}
                                >
                                  ✓ Decrypted in Browser RAM via TideMemory.doDecrypt() (Plaintext Never Stored on Server)
                                </div>
                                <div>
                                  <strong>Summary:</strong> {unlocked.physicianSummary}
                                </div>
                                <div>
                                  <strong>Biomarkers:</strong> LVEF {unlocked.biomarkers?.lvefPercent}% · Troponin {unlocked.biomarkers?.troponinNgL} ng/L · Marker {unlocked.biomarkers?.genomicMarker}
                                </div>
                                <div style={{ marginTop: "4px" }}>
                                  <strong>Clinical Notes:</strong> {unlocked.clinicalNotes}
                                </div>
                              </div>
                            )}

                            {refusal && (
                              <div
                                role="alert"
                                className="mp-mono"
                                style={{
                                  padding: "10px",
                                  borderRadius: "var(--mp-radius-sm)",
                                  backgroundColor: "var(--mp-danger-bg)",
                                  border: "1px solid var(--mp-danger-border)",
                                  color: "var(--mp-danger)",
                                  fontSize: "11.5px",
                                }}
                              >
                                <div style={{ fontWeight: 700 }}>
                                  ✗ REFUSED (HTTP {refusal.status} · {refusal.code}) at{" "}
                                  {refusal.time}
                                </div>
                                <div
                                  style={{
                                    marginTop: "2px",
                                    fontWeight: 700,
                                    color: "var(--mp-text)",
                                  }}
                                >
                                  Rule: {refusal.ruleStoppedIt}
                                </div>
                                <div style={{ marginTop: "2px" }}>{refusal.error}</div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* ==================================================================
            GLOBAL EMERGENT AUTHORITY STEPPER STRIP
            ================================================================== */}
        <GlobalFlowStepper
          consentGranted={emergentAuthority.lock1PatientSelfConsent}
          grantedCount={state.grantedConsentCount}
          totalRecords={state.totalRecords}
          quorumCommitted={emergentAuthority.lock2EthicsQuorumCommitted}
          approvalsCount={approvalsCount}
          threshold={threshold}
          tokenBound={emergentAuthority.lock3ResearcherDpopAndRole}
          sandboxUnlocked={sandboxUnlocked}
        />

        {/* ==================================================================
            SCREEN 2: RECORDS & METADATA-ONLY SEARCH (Task A)
            ================================================================== */}
        {(viewMode === "quad" || viewMode === "researcher") && (
          <section
            id="section-metadata-search"
            aria-label="Metadata-Only Cohort Search"
            className="mp-card"
          >
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "10px",
                paddingBottom: "14px",
                borderBottom: "1px solid var(--mp-border)",
                marginBottom: "14px",
              }}
            >
              <div>
                <div
                  style={{
                    fontSize: "11px",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    color: "var(--mp-primary)",
                  }}
                >
                  Screen 2 · Non-Sensitive Cohort Discovery (Task A)
                </div>
                <h2 style={{ margin: "2px 0 0 0", fontSize: "16px", fontWeight: 700 }}>
                  Cross-Hospital Metadata Index ({state.records.length} of{" "}
                  {state.totalRecords} Records Shown)
                </h2>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                <StatusBadge
                  tone="neutral"
                  icon="lock"
                  label="Payloads Encrypted (TideMemory v1)"
                />
                <button
                  type="button"
                  onClick={handleLogMetadataSearch}
                  disabled={busyAction !== null}
                  className="mp-btn mp-btn-secondary mp-btn-sm"
                >
                  <IconSearch size={13} />
                  <span>Log Search to Audit Trail</span>
                </button>
              </div>
            </div>

            {/* Metadata Search Filter Bar */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
                gap: "10px",
                marginBottom: "14px",
                padding: "12px",
                borderRadius: "var(--mp-radius-md)",
                backgroundColor: "var(--mp-bg-subtle)",
                border: "1px solid var(--mp-border)",
              }}
            >
              <div>
                <label className="mp-label" htmlFor="filter-condition">
                  Condition / ICD-10 Category
                </label>
                <input
                  id="filter-condition"
                  type="text"
                  placeholder="e.g. Cardio, NSCLC, C34.90"
                  value={icdFilter}
                  onChange={(e) => setIcdFilter(e.target.value)}
                  className="mp-input"
                />
              </div>

              <div>
                <label className="mp-label" htmlFor="filter-age">
                  Age Band
                </label>
                <select
                  id="filter-age"
                  value={ageFilter}
                  onChange={(e) => setAgeFilter(e.target.value)}
                  className="mp-select"
                >
                  <option value="">All Age Bands</option>
                  <option value="45-54">45–54 years</option>
                  <option value="55-64">55–64 years</option>
                  <option value="65-74">65–74 years</option>
                </select>
              </div>

              <div>
                <label className="mp-label" htmlFor="filter-hospital">
                  Origin Hospital
                </label>
                <input
                  id="filter-hospital"
                  type="text"
                  placeholder="e.g. St. Jude, Charité, Tokyo"
                  value={hospitalFilter}
                  onChange={(e) => setHospitalFilter(e.target.value)}
                  className="mp-input"
                />
              </div>

              <div>
                <label className="mp-label" htmlFor="filter-date-from">
                  Admission Date From
                </label>
                <input
                  id="filter-date-from"
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="mp-input"
                />
              </div>

              <div>
                <label className="mp-label" htmlFor="filter-date-to">
                  Admission Date To
                </label>
                <div style={{ display: "flex", gap: "6px" }}>
                  <input
                    id="filter-date-to"
                    type="date"
                    value={dateTo}
                    onChange={(e) => setDateTo(e.target.value)}
                    className="mp-input"
                  />
                  {(hospitalFilter || icdFilter || ageFilter || dateFrom || dateTo) && (
                    <button
                      type="button"
                      onClick={handleClearFilters}
                      className="mp-btn mp-btn-secondary mp-btn-sm"
                      title="Clear all metadata filters"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Records Table or Empty State */}
            {state.records.length === 0 ? (
              <div
                style={{
                  padding: "32px",
                  textAlign: "center",
                  borderRadius: "var(--mp-radius-md)",
                  border: "1px dashed var(--mp-border-strong)",
                  color: "var(--mp-text-secondary)",
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: "4px" }}>
                  No cohort records match the current metadata filters.
                </div>
                <div style={{ fontSize: "12.5px", color: "var(--mp-text-muted)", marginBottom: "10px" }}>
                  Try broadening the date range, age band, or hospital query.
                </div>
                <button
                  type="button"
                  onClick={handleClearFilters}
                  className="mp-btn mp-btn-secondary mp-btn-sm"
                >
                  Reset Search Filters
                </button>
              </div>
            ) : (
              <div className="mp-table-wrap">
                <table className="mp-table">
                  <thead>
                    <tr>
                      <th>Record ID</th>
                      <th>Hospital Origin</th>
                      <th>Condition Category (ICD-10)</th>
                      <th>Age Band</th>
                      <th>Admission Date</th>
                      <th>Patient Consent</th>
                      <th>Clinical Payload Status</th>
                      <th style={{ textAlign: "right" }}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.records.map((r) => {
                      const isUnlockedInBrowser = Boolean(
                        unlockedPlaintexts[r.recordId]
                      );
                      return (
                        <tr key={r.recordId}>
                          <td className="mp-mono" style={{ fontWeight: 600 }}>
                            {r.recordId}
                          </td>
                          <td>{r.hospitalOrigin}</td>
                          <td>
                            <span
                              className="mp-mono"
                              style={{
                                fontWeight: 600,
                                color: "var(--mp-accent)",
                              }}
                            >
                              {r.icd10Code}
                            </span>{" "}
                            <span style={{ color: "var(--mp-text-secondary)" }}>
                              — {r.icd10Category}
                            </span>
                          </td>
                          <td className="mp-mono">{r.ageGroup}</td>
                          <td className="mp-mono">{r.admissionDate}</td>
                          <td>
                            {r.consentState === "GRANTED" ? (
                              <StatusBadge
                                tone="success"
                                icon="check"
                                label="Consent Granted"
                              />
                            ) : r.consentState === "REVOKED" ? (
                              <StatusBadge
                                tone="danger"
                                icon="ban"
                                label="Consent Revoked"
                              />
                            ) : (
                              <StatusBadge
                                tone="pending"
                                icon="clock"
                                label="Consent Pending"
                              />
                            )}
                          </td>
                          <td>
                            {isUnlockedInBrowser ? (
                              <StatusBadge
                                tone="success"
                                icon="unlock"
                                label={`Unlocked in Browser (LVEF ${unlockedPlaintexts[r.recordId].biomarkers.lvefPercent}%)`}
                              />
                            ) : (
                              <StatusBadge
                                tone="neutral"
                                icon="lock"
                                label="Payload Encrypted (TideMemory v1)"
                              />
                            )}
                          </td>
                          <td style={{ textAlign: "right" }}>
                            <button
                              type="button"
                              onClick={() =>
                                handleUnlockAndAnalyzeInBrowser(r.recordId)
                              }
                              disabled={busyAction !== null}
                              className="mp-btn mp-btn-secondary mp-btn-sm"
                            >
                              {isUnlockedInBrowser ? (
                                <>
                                  <IconUnlock size={12} />
                                  <span>Re-Verify in Sandbox</span>
                                </>
                              ) : (
                                <>
                                  <IconLock size={12} />
                                  <span>Try to Open Payload</span>
                                </>
                              )}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Clear Denial Notice When Opening a Locked Payload Fails */}
            {sandboxError && (
              <div
                role="alert"
                style={{
                  marginTop: "12px",
                  padding: "12px 14px",
                  borderRadius: "var(--mp-radius-md)",
                  backgroundColor: "var(--mp-danger-bg)",
                  border: "1px solid var(--mp-danger-border)",
                  color: "var(--mp-danger)",
                  fontSize: "13px",
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  gap: "12px",
                }}
              >
                <div>
                  <div style={{ fontWeight: 700, marginBottom: "2px" }}>
                    Payload Cannot Be Opened — Access Denied (HTTP 403)
                  </div>
                  <div className="mp-mono" style={{ fontSize: "12px" }}>
                    {sandboxError}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSandboxError(null)}
                  className="mp-btn mp-btn-secondary mp-btn-sm"
                >
                  Dismiss
                </button>
              </div>
            )}
          </section>
        )}

        {/* ==================================================================
            SCREEN 3: ACCESS REQUEST, PATIENT CONSENT & ETHICS BOARD QUORUM
            ================================================================== */}
        <div className="mp-grid-2">
          {/* LEFT CARD: PATIENT CONSENT ATTESTATION (Task B & G) */}
          {(viewMode === "quad" || viewMode === "patient") && (
            <section
              id="section-patient-consent"
              aria-label="Patient Consent Attestation"
              className="mp-card"
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                gap: "14px",
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    paddingBottom: "10px",
                    borderBottom: "1px solid var(--mp-border)",
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontSize: "11px",
                        fontWeight: 700,
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                        color: "var(--mp-primary)",
                      }}
                    >
                      Screen 3A · Patient Consent Portal (Task B)
                    </div>
                    <h2 style={{ margin: "2px 0 0 0", fontSize: "16px", fontWeight: 700 }}>
                      Record- &amp; Study-Bound Consent Attestation
                    </h2>
                  </div>
                  <StatusBadge
                    tone={
                      emergentAuthority.lock1PatientSelfConsent
                        ? "success"
                        : state.consentAttestation?.status === "REVOKED"
                        ? "danger"
                        : "pending"
                    }
                    icon={
                      emergentAuthority.lock1PatientSelfConsent
                        ? "check"
                        : state.consentAttestation?.status === "REVOKED"
                        ? "ban"
                        : "clock"
                    }
                    label={
                      emergentAuthority.lock1PatientSelfConsent
                        ? `Granted (${state.grantedConsentCount}/${state.totalRecords})`
                        : state.consentAttestation?.status === "REVOKED"
                        ? "Revoked"
                        : "Pending Signature"
                    }
                  />
                </div>

                <p style={{ margin: 0, fontSize: "13px", color: "var(--mp-text-secondary)" }}>
                  The patient signs an Ed25519 <code>self</code>-mode attestation in their browser tied to a specific <strong>Record ID</strong> and <strong>Study ID</strong> (<code>/studies/study-42</code>). The server stores the raw fields and reconstructs <code>Policy.DataToVerify</code> bytes on every check.
                </p>

                {/* Consent Form Controls */}
                <div
                  style={{
                    padding: "12px",
                    borderRadius: "var(--mp-radius-md)",
                    backgroundColor: "var(--mp-bg-subtle)",
                    border: "1px solid var(--mp-border)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "10px",
                  }}
                >
                  <div className="mp-grid-2">
                    <div>
                      <label className="mp-label" htmlFor="consent-record-select">
                        Patient Record to Attest
                      </label>
                      <select
                        id="consent-record-select"
                        value={selectedConsentRecordId}
                        onChange={(e) => setSelectedConsentRecordId(e.target.value)}
                        className="mp-select"
                      >
                        {state.records.map((r) => (
                          <option key={r.recordId} value={r.recordId}>
                            {r.recordId} — {r.patientDisplayName} ({r.consentState})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="mp-label" htmlFor="consent-study-input">
                        Authorized Study ID
                      </label>
                      <input
                        id="consent-study-input"
                        type="text"
                        readOnly
                        value={state.studyGroupId}
                        className="mp-input mp-mono"
                      />
                    </div>
                  </div>

                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      fontSize: "12.5px",
                      color: "var(--mp-text-secondary)",
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={applyConsentToAll}
                      onChange={(e) => setApplyConsentToAll(e.target.checked)}
                    />
                    <span>
                      Also sign individual record-bound attestations for all 5 cohort patients in{" "}
                      <code>{state.studyGroupId}</code>
                    </span>
                  </label>
                </div>

                {/* Per-Record Consent Status Grid */}
                <div>
                  <div className="mp-label" style={{ marginBottom: "6px" }}>
                    Verifiable Consent Status by Patient Record
                  </div>
                  <div className="mp-grid-5">
                    {[
                      "MP-2026-001",
                      "MP-2026-002",
                      "MP-2026-003",
                      "MP-2026-004",
                      "MP-2026-005",
                    ].map((rid) => {
                      const st = state.recordConsentStatus[rid] || "PENDING";
                      const row = state.consentByRecord?.[rid];
                      return (
                        <div
                          key={rid}
                          style={{
                            padding: "8px",
                            borderRadius: "var(--mp-radius-sm)",
                            border:
                              st === "GRANTED"
                                ? "1px solid var(--mp-success-border)"
                                : st === "REVOKED"
                                ? "1px solid var(--mp-danger-border)"
                                : "1px solid var(--mp-border)",
                            backgroundColor:
                              st === "GRANTED"
                                ? "var(--mp-success-bg)"
                                : st === "REVOKED"
                                ? "var(--mp-danger-bg)"
                                : "var(--mp-surface)",
                            textAlign: "center",
                          }}
                        >
                          <div
                            className="mp-mono"
                            style={{ fontWeight: 700, fontSize: "11.5px" }}
                          >
                            {rid}
                          </div>
                          <div
                            style={{
                              fontSize: "11px",
                              fontWeight: 600,
                              color:
                                st === "GRANTED"
                                  ? "var(--mp-success)"
                                  : st === "REVOKED"
                                  ? "var(--mp-danger)"
                                  : "var(--mp-pending)",
                            }}
                          >
                            {st}
                          </div>
                          {row?.signature && (
                            <div
                              className="mp-mono"
                              style={{
                                fontSize: "9.5px",
                                color: "var(--mp-text-muted)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                              }}
                              title={`Ed25519 Signature: ${row.signature}`}
                            >
                              sig:{row.signature.slice(0, 8)}…
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                <button
                  type="button"
                  onClick={handlePatientSignConsent}
                  disabled={busyAction !== null}
                  className="mp-btn mp-btn-primary"
                  style={{ flex: 1 }}
                >
                  <IconCheck size={14} />
                  <span>
                    {busyAction === "PATIENT_CONSENT"
                      ? "Signing Ed25519 Attestation…"
                      : `Grant Consent (${
                          applyConsentToAll ? "All 5 Cohort Records" : selectedConsentRecordId
                        })`}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setRevokeModalTarget("PATIENT_CONSENT")}
                  disabled={busyAction !== null}
                  className="mp-btn mp-btn-danger"
                >
                  <IconBan size={14} />
                  <span>Revoke Consent…</span>
                </button>
              </div>
            </section>
          )}

          {/* RIGHT CARD: ACCESS REQUEST & 2-OF-3 ETHICS BOARD QUORUM (Task C & G) */}
          {(viewMode === "quad" || viewMode === "ethics" || viewMode === "researcher") && (
            <section
              id="section-ethics-quorum"
              aria-label="Access Request and Ethics Board Quorum"
              className="mp-card"
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                gap: "14px",
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    paddingBottom: "10px",
                    borderBottom: "1px solid var(--mp-border)",
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontSize: "11px",
                        fontWeight: 700,
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                        color: "var(--mp-accent)",
                      }}
                    >
                      Screen 3B · Ethics Board Quorum (Task C)
                    </div>
                    <h2 style={{ margin: "2px 0 0 0", fontSize: "16px", fontWeight: 700 }}>
                      2-of-3 Quorum Approval Board (<code>floor(3 × 0.7) = 2</code>)
                    </h2>
                  </div>
                  <StatusBadge
                    tone={
                      emergentAuthority.lock2EthicsQuorumCommitted
                        ? "success"
                        : approvalsCount >= 2
                        ? "primary"
                        : "pending"
                    }
                    icon={
                      emergentAuthority.lock2EthicsQuorumCommitted
                        ? "check"
                        : "clock"
                    }
                    label={
                      emergentAuthority.lock2EthicsQuorumCommitted
                        ? `Quorum Committed (${approvalsCount}/2 of 3)`
                        : `${approvalsCount}/2 Approvals Collected (of 3 Admins)`
                    }
                  />
                </div>

                {/* Live 3-Condition Unlock Checklist */}
                <div
                  style={{
                    padding: "11px 13px",
                    borderRadius: "var(--mp-radius-md)",
                    backgroundColor: "var(--mp-bg-subtle)",
                    border: "1px solid var(--mp-border)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "6px",
                  }}
                >
                  <div
                    style={{
                      fontSize: "11.5px",
                      fontWeight: 700,
                      color: "var(--mp-text-secondary)",
                    }}
                  >
                    Unlock Checklist for Request on <code>{state.studyGroupId}</code>:
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      fontSize: "12.5px",
                    }}
                  >
                    <span>1. Patient Consent Attestation</span>
                    <StatusBadge
                      tone={emergentAuthority.lock1PatientSelfConsent ? "success" : "pending"}
                      icon={emergentAuthority.lock1PatientSelfConsent ? "check" : "clock"}
                      label={
                        emergentAuthority.lock1PatientSelfConsent
                          ? `Verified (${state.grantedConsentCount} records)`
                          : "Missing"
                      }
                    />
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      fontSize: "12.5px",
                    }}
                  >
                    <span>2. Ethics Board Quorum (2 of 3 Admins)</span>
                    <StatusBadge
                      tone={emergentAuthority.lock2EthicsQuorumCommitted ? "success" : "pending"}
                      icon={emergentAuthority.lock2EthicsQuorumCommitted ? "check" : "clock"}
                      label={
                        emergentAuthority.lock2EthicsQuorumCommitted
                          ? `Committed (${approvalsCount}/2)`
                          : `${approvalsCount}/2 (${activeResearcherCr?.status || "NOT REQUESTED"})`
                      }
                    />
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      fontSize: "12.5px",
                    }}
                  >
                    <span>3. Researcher Bound Token (DPoP + _tide_decryptor)</span>
                    <StatusBadge
                      tone={emergentAuthority.lock3ResearcherDpopAndRole ? "success" : "pending"}
                      icon="shield"
                      label="Bound (ES256 DPoP)"
                    />
                  </div>
                </div>

                {ethicsBanner && (
                  <div
                    role="status"
                    style={{
                      padding: "10px 12px",
                      borderRadius: "var(--mp-radius-sm)",
                      fontSize: "12.5px",
                      backgroundColor:
                        ethicsBanner.type === "error"
                          ? "var(--mp-danger-bg)"
                          : ethicsBanner.type === "success"
                          ? "var(--mp-success-bg)"
                          : "var(--mp-primary-soft)",
                      border:
                        ethicsBanner.type === "error"
                          ? "1px solid var(--mp-danger-border)"
                          : ethicsBanner.type === "success"
                          ? "1px solid var(--mp-success-border)"
                          : "1px solid var(--mp-primary-border)",
                      color:
                        ethicsBanner.type === "error"
                          ? "var(--mp-danger)"
                          : ethicsBanner.type === "success"
                          ? "var(--mp-success)"
                          : "var(--mp-primary-text)",
                    }}
                  >
                    {ethicsBanner.text}
                  </div>
                )}

                {!activeResearcherCr ? (
                  <div
                    style={{
                      padding: "18px",
                      borderRadius: "var(--mp-radius-md)",
                      border: "1px dashed var(--mp-border-strong)",
                      textAlign: "center",
                    }}
                  >
                    <div
                      style={{
                        fontSize: "13px",
                        color: "var(--mp-text-secondary)",
                        marginBottom: "10px",
                      }}
                    >
                      Step 1 for Researcher: Submit an access request to join{" "}
                      <code>{state.studyGroupId}</code> (creates an <code>HTTP 202 PENDING</code> IGA Change Request).
                    </div>
                    <button
                      type="button"
                      onClick={handleRequestStudyAccess}
                      disabled={busyAction !== null}
                      className="mp-btn mp-btn-accent"
                    >
                      Request Study Access (HTTP 202)
                    </button>
                  </div>
                ) : (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "10px",
                    }}
                  >
                    <div className="mp-grid-3">
                      {[
                        {
                          id: "ethics-admin-1",
                          name: "Dr. Hannah Vance",
                          org: "St. Jude IRB Chair",
                        },
                        {
                          id: "ethics-admin-2",
                          name: "Prof. Lukas Weber",
                          org: "Charité Berlin IRB",
                        },
                        {
                          id: "ethics-admin-3",
                          name: "Dr. Kenji Takahashi",
                          org: "Tokyo Univ. Ethics",
                        },
                      ].map((admin) => {
                        const signed = activeResearcherCr.approvals.some(
                          (a) => a.adminId === admin.id
                        );
                        return (
                          <div
                            key={admin.id}
                            style={{
                              padding: "10px",
                              borderRadius: "var(--mp-radius-sm)",
                              border: signed
                                ? "1px solid var(--mp-success-border)"
                                : "1px solid var(--mp-border-strong)",
                              backgroundColor: signed
                                ? "var(--mp-success-bg)"
                                : "var(--mp-surface)",
                              display: "flex",
                              flexDirection: "column",
                              justifyContent: "space-between",
                              gap: "8px",
                            }}
                          >
                            <div>
                              <div style={{ fontWeight: 700, fontSize: "12.5px" }}>
                                {admin.name}
                              </div>
                              <div
                                style={{
                                  fontSize: "11px",
                                  color: "var(--mp-text-muted)",
                                }}
                              >
                                {admin.org}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() =>
                                handleEthicsApprove(activeResearcherCr.id, admin.id)
                              }
                              disabled={
                                signed ||
                                activeResearcherCr.status === "COMMITTED" ||
                                busyAction !== null
                              }
                              className={`mp-btn mp-btn-sm ${
                                signed ? "mp-btn-secondary" : "mp-btn-accent"
                              }`}
                              style={{ width: "100%" }}
                            >
                              {signed ? (
                                <>
                                  <IconCheck size={12} />
                                  <span>Approved</span>
                                </>
                              ) : (
                                <span>Approve Request</span>
                              )}
                            </button>
                          </div>
                        );
                      })}
                    </div>

                    <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                      <button
                        type="button"
                        onClick={() => handleEthicsCommit(activeResearcherCr.id)}
                        disabled={
                          activeResearcherCr.status === "COMMITTED" ||
                          busyAction !== null
                        }
                        className={`mp-btn ${
                          activeResearcherCr.readyToCommit
                            ? "mp-btn-primary"
                            : "mp-btn-secondary"
                        }`}
                        style={{ flex: 1 }}
                      >
                        {activeResearcherCr.status === "COMMITTED"
                          ? "✓ Quorum Committed (Group Membership Active)"
                          : activeResearcherCr.readyToCommit
                          ? "Commit 2/3 Approved Quorum (Seal Group Claim)"
                          : "Try to Commit With <2 Approvals (Fails HTTP 412)"}
                      </button>

                      {activeResearcherCr.approvals.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setRevokeModalTarget("ETHICS_APPROVAL")}
                          disabled={busyAction !== null}
                          className="mp-btn mp-btn-danger"
                        >
                          <IconBan size={13} />
                          <span>Withdraw 1 Approval…</span>
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* Elevated Role Approval Queue (2-of-3 Ethics Board Quorum for Sign-Up & Profile Requests) */}
                <div
                  style={{
                    marginTop: "14px",
                    paddingTop: "14px",
                    borderTop: "1px solid var(--mp-border)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "8px",
                      marginBottom: "8px",
                      flexWrap: "wrap",
                    }}
                  >
                    <div>
                      <div
                        style={{
                          fontSize: "12.5px",
                          fontWeight: 700,
                          color: "var(--mp-text)",
                        }}
                      >
                        Elevated Role Requests (2-of-3 Ethics Quorum Required)
                      </div>
                      <div
                        style={{
                          fontSize: "11.5px",
                          color: "var(--mp-text-secondary)",
                        }}
                      >
                        New accounts requesting <code>researcher</code> or{" "}
                        <code>ethics-board</code> start with minimal permissions until 2 of
                        3 Ethics Board members approve.
                      </div>
                    </div>
                    <Link
                      href="/signup"
                      className="mp-btn mp-btn-secondary mp-btn-sm"
                    >
                      + Register Account on /signup
                    </Link>
                  </div>

                  {(!state.roleRequests || state.roleRequests.length === 0) ? (
                    <div
                      style={{
                        padding: "10px 12px",
                        borderRadius: "var(--mp-radius-sm)",
                        backgroundColor: "var(--mp-bg-subtle)",
                        border: "1px dashed var(--mp-border-strong)",
                        fontSize: "12px",
                        color: "var(--mp-text-muted)",
                      }}
                    >
                      No pending elevated role requests yet. Create an account on{" "}
                      <Link href="/signup" style={{ color: "var(--mp-primary)", fontWeight: 600 }}>
                        /signup
                      </Link>{" "}
                      or request an upgrade on{" "}
                      <Link href="/profile" style={{ color: "var(--mp-primary)", fontWeight: 600 }}>
                        /profile
                      </Link>{" "}
                      to test 2-of-3 role approval.
                    </div>
                  ) : (
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "8px",
                      }}
                    >
                      {state.roleRequests.map((rr) => (
                        <div
                          key={rr.id}
                          style={{
                            padding: "10px 12px",
                            borderRadius: "var(--mp-radius-sm)",
                            backgroundColor: "var(--mp-bg-subtle)",
                            border: "1px solid var(--mp-border)",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              gap: "8px",
                              flexWrap: "wrap",
                              marginBottom: "6px",
                            }}
                          >
                            <div>
                              <strong style={{ fontSize: "12.5px" }}>
                                {rr.userName} ({rr.userEmail})
                              </strong>{" "}
                              <span
                                className="mp-mono"
                                style={{
                                  fontSize: "11px",
                                  color: "var(--mp-text-muted)",
                                }}
                              >
                                → Requested: {rr.requestedRole.toUpperCase()} ({rr.id})
                              </span>
                            </div>
                            <StatusBadge
                              tone={
                                rr.status === "APPROVED"
                                  ? "success"
                                  : rr.status === "PENDING"
                                  ? "pending"
                                  : "danger"
                              }
                              icon={
                                rr.status === "APPROVED"
                                  ? "check"
                                  : rr.status === "PENDING"
                                  ? "clock"
                                  : "ban"
                              }
                              label={`${rr.status} (${rr.approvals.length}/${rr.threshold} Quorum)`}
                            />
                          </div>

                          {rr.status === "PENDING" && (
                            <div
                              style={{
                                display: "flex",
                                flexWrap: "wrap",
                                gap: "6px",
                                marginTop: "6px",
                              }}
                            >
                              {[
                                { id: "ethics-admin-1", label: "Approve (Dr. Vance 1/3)" },
                                { id: "ethics-admin-2", label: "Approve (Prof. Weber 2/3)" },
                                { id: "ethics-admin-3", label: "Approve (Dr. Takahashi 3/3)" },
                              ].map((adm) => {
                                const alreadySigned = rr.approvals.some(
                                  (a) => a.adminId === adm.id
                                );
                                return (
                                  <button
                                    key={adm.id}
                                    type="button"
                                    disabled={alreadySigned || busyAction !== null}
                                    onClick={() =>
                                      handleApproveRoleRequest(rr.id, adm.id)
                                    }
                                    className={`mp-btn mp-btn-sm ${
                                      alreadySigned
                                        ? "mp-btn-secondary"
                                        : "mp-btn-accent"
                                    }`}
                                  >
                                    {alreadySigned ? `✓ ${adm.label}` : adm.label}
                                  </button>
                                );
                              })}
                              <button
                                type="button"
                                disabled={busyAction !== null}
                                onClick={() =>
                                  handleRejectRoleRequest(rr.id, "ethics-admin-1")
                                }
                                className="mp-btn mp-btn-danger mp-btn-sm"
                              >
                                Reject Request
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </section>
          )}
        </div>

        {/* ==================================================================
            PROTECTED ROUTE GUARD FOR RESTRICTED ROLES (Feature 4)
            ================================================================== */}
        {(viewMode === "doctor" || viewMode === "pending") && (
          <section
            aria-label="Protected Route Role Access Notice"
            className="mp-card-danger"
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "12px",
                flexWrap: "wrap",
                marginBottom: "8px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <StatusBadge
                  tone="danger"
                  icon="ban"
                  label="HTTP 403 · No Access to Decryption Sandbox"
                />
                <h2 style={{ margin: 0, fontSize: "16px", fontWeight: 700 }}>
                  Protected Workspace — Role Authorization Required
                </h2>
              </div>
              <Link href="/profile" className="mp-btn mp-btn-primary mp-btn-sm">
                View Role Request Status on /profile →
              </Link>
            </div>
            <p
              style={{
                margin: 0,
                fontSize: "13px",
                color: "var(--mp-text-secondary)",
              }}
            >
              {viewMode === "pending"
                ? "Reason: Your account currently holds minimal, non-sensitive permissions (_tide_enabled only) while your elevated role request awaits 2-of-3 Ethics Board quorum approval. Unapproved accounts can search non-sensitive metadata above, but are blocked from unlocking clinical payloads or signing governance approvals."
                : "Reason: Attending Clinician (doctor) accounts have non-sensitive metadata search privileges only. Unlocking encrypted clinical payloads in the Browser Sandbox requires an approved 'researcher' role with '_tide_decryptor' authority, patient consent, and 2-of-3 Ethics Board quorum."}
            </p>
          </section>
        )}

        {/* ==================================================================
            FEATURE 6 & 7: POLICY TRANSPARENCY ("CURRENT RULES") & TIME-LIMITED ACCESS
            ================================================================== */}
        <section
          id="section-policy-transparency"
          aria-label="Policy Transparency and Time-Limited Access Rules"
          className="mp-card"
        >
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "12px",
              paddingBottom: "12px",
              borderBottom: "1px solid var(--mp-border)",
              marginBottom: "14px",
            }}
          >
            <div>
              <div
                style={{
                  fontSize: "11px",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  color: "var(--mp-primary)",
                }}
              >
                Feature 6 &amp; 7 · Policy Transparency &amp; Time-Limited Access
              </div>
              <h2 style={{ margin: "2px 0 0 0", fontSize: "16px", fontWeight: 700 }}>
                Current Active Study Policy (Read-Only · Immutable Without 2/3 Quorum)
              </h2>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              {remainingAccessSeconds !== null && remainingAccessSeconds > 0 ? (
                <>
                  <StatusBadge
                    tone="success"
                    icon="clock"
                    label={`Time-Limited Access Active: ${Math.floor(
                      remainingAccessSeconds / 60
                    )
                      .toString()
                      .padStart(2, "0")}:${(remainingAccessSeconds % 60)
                      .toString()
                      .padStart(2, "0")} remaining`}
                  />
                  <button
                    type="button"
                    onClick={handleFastForwardExpiry}
                    disabled={busyAction !== null}
                    className="mp-btn mp-btn-danger mp-btn-sm"
                    title="Simulate countdown reaching 00:00 so access ends and audit trail logs STUDY_ACCESS_EXPIRED"
                  >
                    Fast-Forward Expiry (00:00)
                  </button>
                </>
              ) : (
                <StatusBadge
                  tone="neutral"
                  icon="clock"
                  label="Access TTL Window: 180s (Starts on 2/3 Quorum Commit)"
                />
              )}

              <button
                type="button"
                onClick={() =>
                  handleProposePolicyRuleChange(
                    "Extend study access expiry from 180s to 600s & add genomic raw sequence field"
                  )
                }
                disabled={busyAction !== null}
                className="mp-btn mp-btn-secondary mp-btn-sm"
              >
                Propose Rule Change (Requires 2/3 Quorum)
              </button>
            </div>
          </div>

          {policyRuleNotice && (
            <div
              role="status"
              className="mp-callout mp-callout--warning"
              style={{ marginBottom: "12px" }}
            >
              <IconClock size={17} />
              <div style={{ flex: 1 }}>
                <div className="mp-callout__title">
                  Policy Modification Queued for 2-of-3 Quorum
                </div>
                <div className="mp-callout__desc">{policyRuleNotice}</div>
              </div>
            </div>
          )}

          <div className="mp-grid-4">
            <div
              style={{
                padding: "10px 12px",
                borderRadius: "var(--mp-radius-sm)",
                backgroundColor: "var(--mp-bg-subtle)",
                border: "1px solid var(--mp-border)",
              }}
            >
              <div style={{ fontSize: "11px", color: "var(--mp-text-muted)" }}>
                Active Contract &amp; Tag
              </div>
              <div className="mp-mono" style={{ fontSize: "12.5px", fontWeight: 700 }}>
                RelationshipAttestation:1
              </div>
              <div className="mp-mono" style={{ fontSize: "11px", color: "var(--mp-primary)" }}>
                assignmentId: {state.studyGroupId}
              </div>
            </div>

            <div
              style={{
                padding: "10px 12px",
                borderRadius: "var(--mp-radius-sm)",
                backgroundColor: "var(--mp-bg-subtle)",
                border: "1px solid var(--mp-border)",
              }}
            >
              <div style={{ fontSize: "11px", color: "var(--mp-text-muted)" }}>
                Required Ethics Quorum
              </div>
              <div style={{ fontSize: "12.5px", fontWeight: 700 }}>
                2 of 3 Board Members
              </div>
              <div className="mp-mono" style={{ fontSize: "11px", color: "var(--mp-text-secondary)" }}>
                floor(3 × 0.7) = 2 (Cryptographic IGA)
              </div>
            </div>

            <div
              style={{
                padding: "10px 12px",
                borderRadius: "var(--mp-radius-sm)",
                backgroundColor: "var(--mp-bg-subtle)",
                border: "1px solid var(--mp-border)",
              }}
            >
              <div style={{ fontSize: "11px", color: "var(--mp-text-muted)" }}>
                Required Patient Consent
              </div>
              <div style={{ fontSize: "12.5px", fontWeight: 700 }}>
                Self-Mode Ed25519 Signature
              </div>
              <div className="mp-mono" style={{ fontSize: "11px", color: "var(--mp-text-secondary)" }}>
                Issuer === Subject === Patient VUID
              </div>
            </div>

            <div
              style={{
                padding: "10px 12px",
                borderRadius: "var(--mp-radius-sm)",
                backgroundColor: "var(--mp-bg-subtle)",
                border: "1px solid var(--mp-border)",
              }}
            >
              <div style={{ fontSize: "11px", color: "var(--mp-text-muted)" }}>
                Time-Limited Expiry &amp; Revocation
              </div>
              <div style={{ fontSize: "12.5px", fontWeight: 700 }}>
                180s Auto-Expiry + Instant Revoke
              </div>
              <div className="mp-mono" style={{ fontSize: "11px", color: "var(--mp-text-secondary)" }}>
                Wipes browser RAM on expiry/revoke
              </div>
            </div>
          </div>
        </section>

        {/* ==================================================================
            SCREEN 4: BROWSER SANDBOX & POLICY-SCOPED AI ASSISTANT (Tasks D & E)
            ================================================================== */}
        {(viewMode === "quad" || viewMode === "researcher") && (
          <section
            id="section-browser-sandbox"
            aria-label="In-Browser Clinical Sandbox and Policy-Scoped AI Assistant"
            className={sandboxAnalytics ? "mp-card-sandbox" : "mp-card"}
          >
            {/* Persistent Secure Workspace Banner (Feature 10: Visible "data stays in this browser" indicator) */}
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "10px",
                padding: "10px 14px",
                borderRadius: "var(--mp-radius-md)",
                backgroundColor: "var(--mp-primary-soft)",
                border: "1px solid var(--mp-primary-border)",
                marginBottom: "16px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <IconShield size={16} />
                <span
                  style={{
                    fontWeight: 700,
                    fontSize: "13px",
                    color: "var(--mp-primary-text)",
                  }}
                >
                  Screen 4 · Isolated Browser Sandbox — Data stays in this browser (0 bytes sent to server)
                </span>
              </div>
              <span
                className="mp-mono"
                style={{
                  fontSize: "11.5px",
                  color: "var(--mp-primary-text)",
                  fontWeight: 600,
                }}
              >
                Zero Server Plaintext · Clipboard &amp; CSV Export Disabled
              </span>
            </div>

            {/* Feature 4: LIVE UNLOCK CHECKLIST (3 Real-Time Conditions + Pulse Animation when all Green) */}
            <div
              className={
                emergentAuthority.unlocked ? "mp-unlock-ready-pulse" : ""
              }
              style={{
                padding: "12px 14px",
                borderRadius: "var(--mp-radius-md)",
                backgroundColor: emergentAuthority.unlocked
                  ? "var(--mp-success-bg)"
                  : "var(--mp-bg-subtle)",
                border: emergentAuthority.unlocked
                  ? "2px solid var(--mp-success)"
                  : "1px solid var(--mp-border-strong)",
                marginBottom: "16px",
                transition: "all 0.25s ease",
              }}
            >
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "8px",
                  marginBottom: "10px",
                }}
              >
                <strong style={{ fontSize: "13px" }}>
                  Live Unlock Checklist for Study Request ({state.studyGroupId})
                </strong>
                {emergentAuthority.unlocked ? (
                  <StatusBadge
                    tone="success"
                    icon="unlock"
                    label="ALL 3 CONDITIONS GREEN — READY TO UNLOCK IN BROWSER"
                  />
                ) : (
                  <StatusBadge
                    tone="pending"
                    icon="lock"
                    label="LOCKED — Awaiting Remaining Conditions"
                  />
                )}
              </div>

              <div className="mp-grid-3">
                <div
                  style={{
                    padding: "9px 11px",
                    borderRadius: "var(--mp-radius-sm)",
                    backgroundColor: "var(--mp-surface)",
                    border: emergentAuthority.lock1PatientSelfConsent
                      ? "1.5px solid var(--mp-success)"
                      : "1px solid var(--mp-border)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "8px",
                  }}
                >
                  <div>
                    <div style={{ fontSize: "12px", fontWeight: 700 }}>
                      1. Patient Consent
                    </div>
                    <div style={{ fontSize: "11px", color: "var(--mp-text-secondary)" }}>
                      {state.grantedConsentCount}/{state.totalRecords} record(s) consented
                    </div>
                  </div>
                  <StatusBadge
                    tone={
                      emergentAuthority.lock1PatientSelfConsent
                        ? "success"
                        : "danger"
                    }
                    icon={
                      emergentAuthority.lock1PatientSelfConsent
                        ? "check"
                        : "lock"
                    }
                    label={
                      emergentAuthority.lock1PatientSelfConsent
                        ? "GREEN"
                        : "MISSING"
                    }
                  />
                </div>

                <div
                  style={{
                    padding: "9px 11px",
                    borderRadius: "var(--mp-radius-sm)",
                    backgroundColor: "var(--mp-surface)",
                    border: emergentAuthority.lock2EthicsQuorumCommitted
                      ? "1.5px solid var(--mp-success)"
                      : "1px solid var(--mp-border)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "8px",
                  }}
                >
                  <div>
                    <div style={{ fontSize: "12px", fontWeight: 700 }}>
                      2. Ethics Quorum ({approvalsCount}/{threshold})
                    </div>
                    <div style={{ fontSize: "11px", color: "var(--mp-text-secondary)" }}>
                      {emergentAuthority.lock2EthicsQuorumCommitted
                        ? "2/3 Quorum Committed"
                        : `${approvalsCount} of 2 signatures`}
                    </div>
                  </div>
                  <StatusBadge
                    tone={
                      emergentAuthority.lock2EthicsQuorumCommitted
                        ? "success"
                        : "pending"
                    }
                    icon={
                      emergentAuthority.lock2EthicsQuorumCommitted
                        ? "check"
                        : "clock"
                    }
                    label={
                      emergentAuthority.lock2EthicsQuorumCommitted
                        ? "GREEN (2/2)"
                        : `${approvalsCount}/${threshold}`
                    }
                  />
                </div>

                <div
                  style={{
                    padding: "9px 11px",
                    borderRadius: "var(--mp-radius-sm)",
                    backgroundColor: "var(--mp-surface)",
                    border: emergentAuthority.lock3ResearcherDpopAndRole
                      ? "1.5px solid var(--mp-success)"
                      : "1px solid var(--mp-border)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "8px",
                  }}
                >
                  <div>
                    <div style={{ fontSize: "12px", fontWeight: 700 }}>
                      3. Researcher&apos;s Bound Token
                    </div>
                    <div style={{ fontSize: "11px", color: "var(--mp-text-secondary)" }}>
                      DPoP ES256 + _tide_decryptor
                    </div>
                  </div>
                  <StatusBadge
                    tone={
                      emergentAuthority.lock3ResearcherDpopAndRole
                        ? "success"
                        : "danger"
                    }
                    icon={
                      emergentAuthority.lock3ResearcherDpopAndRole
                        ? "check"
                        : "lock"
                    }
                    label={
                      emergentAuthority.lock3ResearcherDpopAndRole
                        ? "GREEN"
                        : "MISSING"
                    }
                  />
                </div>
              </div>
            </div>

            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "12px",
                marginBottom: "16px",
              }}
            >
              <div>
                <h2 style={{ margin: 0, fontSize: "17px", fontWeight: 700 }}>
                  In-Browser Cohort Decryption &amp; Policy-Scoped AI Assistant
                </h2>
                <p
                  style={{
                    margin: "2px 0 0 0",
                    fontSize: "13px",
                    color: "var(--mp-text-secondary)",
                  }}
                >
                  Requires all 3 locks (Patient Consent + 2/3 Ethics Quorum + Bound Token). Unseals{" "}
                  <code>TideMemory</code> v1 envelopes strictly inside browser RAM.
                </p>
              </div>

              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={() => handleUnlockAndAnalyzeInBrowser()}
                  disabled={busyAction !== null}
                  className="mp-btn mp-btn-primary"
                >
                  <IconUnlock size={14} />
                  <span>
                    {busyAction === "SANDBOX_DECRYPT"
                      ? "Verifying 3 Locks & Decrypting in Browser…"
                      : "Unlock Consented Records & Run Browser Analysis"}
                  </span>
                </button>
              </div>
            </div>

            {!sandboxAnalytics ? (
              <div
                style={{
                  padding: "28px",
                  borderRadius: "var(--mp-radius-md)",
                  backgroundColor: "var(--mp-bg-subtle)",
                  border: "1px dashed var(--mp-border-strong)",
                  textAlign: "center",
                }}
              >
                <div style={{ color: "var(--mp-text-muted)", marginBottom: "6px" }}>
                  <IconLock size={22} />
                </div>
                <div style={{ fontWeight: 600, fontSize: "14px" }}>
                  Browser Sandbox Memory is Currently Empty (Locked)
                </div>
                <p
                  style={{
                    margin: "4px auto 0 auto",
                    maxWidth: "560px",
                    fontSize: "12.5px",
                    color: "var(--mp-text-muted)",
                  }}
                >
                  Click <strong>&ldquo;Unlock Consented Records &amp; Run Browser Analysis&rdquo;</strong> above. If Patient Consent or the 2-of-3 Ethics Board Quorum is missing, the server gate rejects the unlock with <code>HTTP 403</code>.
                </p>
              </div>
            ) : (
              <div
                className="mp-grid-2 mp-no-select"
                onCopy={(e) => {
                  e.preventDefault();
                  setExportBlockNotice(
                    "Sandbox Boundary Policy: Copying decrypted clinical metrics to the clipboard is disabled. Data stays in this browser."
                  );
                }}
                onCut={(e) => e.preventDefault()}
                onContextMenu={(e) => e.preventDefault()}
              >
                {/* LEFT COLUMN: Cohort Summary Statistics & LVEF Distribution Chart */}
                <div
                  style={{
                    padding: "16px",
                    borderRadius: "var(--mp-radius-md)",
                    backgroundColor: "var(--mp-surface)",
                    border: "1px solid var(--mp-border)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "14px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <span style={{ fontWeight: 700, fontSize: "14px" }}>
                      Cohort Statistical Summary (N = {sandboxAnalytics.cohortSize})
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setExportBlockNotice(
                          "Export Blocked by Browser Sandbox: Raw decrypted records cannot be downloaded or exported out of browser RAM."
                        )
                      }
                      className="mp-btn mp-btn-secondary mp-btn-sm"
                    >
                      ⬇ Export Raw CSV (Blocked)
                    </button>
                  </div>

                  {exportBlockNotice && (
                    <div
                      role="alert"
                      style={{
                        padding: "8px 10px",
                        borderRadius: "var(--mp-radius-sm)",
                        backgroundColor: "var(--mp-pending-bg)",
                        border: "1px solid var(--mp-pending-border)",
                        color: "var(--mp-pending)",
                        fontSize: "12px",
                        fontWeight: 600,
                      }}
                    >
                      {exportBlockNotice}
                    </div>
                  )}

                  {/* 4 Key Metric Tiles */}
                  <div className="mp-grid-4">
                    <div
                      style={{
                        padding: "10px",
                        borderRadius: "var(--mp-radius-sm)",
                        backgroundColor: "var(--mp-bg-subtle)",
                        border: "1px solid var(--mp-border)",
                      }}
                    >
                      <div style={{ fontSize: "11px", color: "var(--mp-text-muted)" }}>
                        Mean LVEF
                      </div>
                      <div style={{ fontSize: "18px", fontWeight: 700 }}>
                        {sandboxAnalytics.meanLvefPercent}%
                      </div>
                    </div>

                    <div
                      style={{
                        padding: "10px",
                        borderRadius: "var(--mp-radius-sm)",
                        backgroundColor: "var(--mp-bg-subtle)",
                        border: "1px solid var(--mp-border)",
                      }}
                    >
                      <div style={{ fontSize: "11px", color: "var(--mp-text-muted)" }}>
                        Mean Troponin
                      </div>
                      <div
                        style={{
                          fontSize: "18px",
                          fontWeight: 700,
                          color: "var(--mp-pending)",
                        }}
                      >
                        {sandboxAnalytics.meanTroponinNgL} ng/L
                      </div>
                    </div>

                    <div
                      style={{
                        padding: "10px",
                        borderRadius: "var(--mp-radius-sm)",
                        backgroundColor: "var(--mp-bg-subtle)",
                        border: "1px solid var(--mp-border)",
                      }}
                    >
                      <div style={{ fontSize: "11px", color: "var(--mp-text-muted)" }}>
                        High-Risk CTRCD
                      </div>
                      <div
                        style={{
                          fontSize: "18px",
                          fontWeight: 700,
                          color: "var(--mp-danger)",
                        }}
                      >
                        {sandboxAnalytics.ctrcdHighRiskCount}/{sandboxAnalytics.cohortSize}
                      </div>
                    </div>

                    <div
                      style={{
                        padding: "10px",
                        borderRadius: "var(--mp-radius-sm)",
                        backgroundColor: "var(--mp-bg-subtle)",
                        border: "1px solid var(--mp-border)",
                      }}
                    >
                      <div style={{ fontSize: "11px", color: "var(--mp-text-muted)" }}>
                        Correlation (r)
                      </div>
                      <div
                        style={{
                          fontSize: "18px",
                          fontWeight: 700,
                          color: "var(--mp-primary)",
                        }}
                      >
                        {sandboxAnalytics.pearsonTroponinVsLvefDrop}
                      </div>
                    </div>
                  </div>

                  {/* Clean Visual Bar Chart: Per-Patient LVEF % vs Troponin */}
                  <div>
                    <div className="mp-label" style={{ marginBottom: "8px" }}>
                      In-Browser LVEF (%) &amp; Cardiotoxicity Risk Distribution
                    </div>
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "7px",
                      }}
                    >
                      {sandboxAnalytics.perPatientFindings.map((f) => {
                        const isHigh = f.riskTier.startsWith("HIGH");
                        return (
                          <div
                            key={f.recordId}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "10px",
                              fontSize: "12px",
                            }}
                          >
                            <span
                              className="mp-mono"
                              style={{ width: "86px", fontWeight: 600 }}
                            >
                              {f.recordId}
                            </span>
                            <div
                              style={{
                                flex: 1,
                                height: "10px",
                                borderRadius: "999px",
                                backgroundColor: "var(--mp-bg-subtle)",
                                overflow: "hidden",
                                border: "1px solid var(--mp-border)",
                              }}
                            >
                              <div
                                style={{
                                  width: `${Math.min(100, f.lvefPercent)}%`,
                                  height: "100%",
                                  backgroundColor: isHigh
                                    ? "var(--mp-danger)"
                                    : "var(--mp-primary)",
                                }}
                              />
                            </div>
                            <span
                              className="mp-mono"
                              style={{ width: "130px", textAlign: "right" }}
                            >
                              LVEF {f.lvefPercent}% · {f.troponinNgL} ng/L
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <p
                    style={{
                      margin: 0,
                      fontSize: "12.5px",
                      color: "var(--mp-text-secondary)",
                      lineHeight: 1.5,
                    }}
                  >
                    {sandboxAnalytics.aiClinicalSynthesis}
                  </p>
                </div>

                {/* RIGHT SIDE PANEL: Policy-Scoped AI Assistant (Task E) */}
                <div
                  style={{
                    padding: "16px",
                    borderRadius: "var(--mp-radius-md)",
                    backgroundColor: "var(--mp-surface)",
                    border: "1px solid var(--mp-border)",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "space-between",
                    gap: "12px",
                  }}
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                      }}
                    >
                      <span style={{ fontWeight: 700, fontSize: "14px" }}>
                        Policy-Scoped Sandbox AI Assistant (Task E)
                      </span>
                      <StatusBadge
                        tone="primary"
                        icon="shield"
                        label="Field Projection Gate Active"
                      />
                    </div>

                    <p
                      style={{
                        margin: 0,
                        fontSize: "12.5px",
                        color: "var(--mp-text-secondary)",
                      }}
                    >
                      The AI assistant inside the sandbox only receives fields permitted by the active study policy. Requesting restricted PII or raw clinical notes is blocked.
                    </p>

                    {/* Policy Allowed vs Denied Fields Matrix */}
                    <div className="mp-grid-2">
                      <div
                        style={{
                          padding: "10px",
                          borderRadius: "var(--mp-radius-sm)",
                          backgroundColor: "var(--mp-success-bg)",
                          border: "1px solid var(--mp-success-border)",
                        }}
                      >
                        <div
                          style={{
                            fontSize: "11px",
                            fontWeight: 700,
                            color: "var(--mp-success)",
                            marginBottom: "4px",
                          }}
                        >
                          ✓ Policy-Allowed Fields
                        </div>
                        <div
                          className="mp-mono"
                          style={{
                            fontSize: "11px",
                            color: "var(--mp-text-secondary)",
                            lineHeight: 1.45,
                          }}
                        >
                          {(
                            state.relationshipPolicy?.allowedAiFields ??
                            DEFAULT_ALLOWED_AI_FIELDS
                          ).join(", ")}
                        </div>
                      </div>

                      <div
                        style={{
                          padding: "10px",
                          borderRadius: "var(--mp-radius-sm)",
                          backgroundColor: "var(--mp-danger-bg)",
                          border: "1px solid var(--mp-danger-border)",
                        }}
                      >
                        <div
                          style={{
                            fontSize: "11px",
                            fontWeight: 700,
                            color: "var(--mp-danger)",
                            marginBottom: "4px",
                          }}
                        >
                          ✗ Denied Outside Policy
                        </div>
                        <div
                          className="mp-mono"
                          style={{
                            fontSize: "11px",
                            color: "var(--mp-text-secondary)",
                            lineHeight: 1.45,
                          }}
                        >
                          {(
                            state.relationshipPolicy?.deniedAiFields ??
                            DEFAULT_DENIED_AI_FIELDS
                          ).join(", ")}
                        </div>
                      </div>
                    </div>

                    <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                      <button
                        type="button"
                        onClick={() => handleRunAiAssistant("ALLOWED_SUMMARY")}
                        disabled={busyAction !== null}
                        className="mp-btn mp-btn-primary mp-btn-sm"
                        style={{ flex: 1 }}
                      >
                        Run Allowed Query (Biomarkers &amp; LVEF)
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRunAiAssistant("DENIED_PII_NOTES")}
                        disabled={busyAction !== null}
                        className="mp-btn mp-btn-danger mp-btn-sm"
                        style={{ flex: 1 }}
                      >
                        Test Denied Query (clinicalNotes &amp; PII)
                      </button>
                    </div>

                    {aiResponse && (
                      <div
                        role="status"
                        className="mp-mono"
                        style={{
                          padding: "10px 12px",
                          borderRadius: "var(--mp-radius-sm)",
                          fontSize: "11.5px",
                          whiteSpace: "pre-wrap",
                          backgroundColor: aiResponse.ok
                            ? "var(--mp-success-bg)"
                            : "var(--mp-danger-bg)",
                          border: aiResponse.ok
                            ? "1px solid var(--mp-success-border)"
                            : "1px solid var(--mp-danger-border)",
                          color: aiResponse.ok
                            ? "var(--mp-success)"
                            : "var(--mp-danger)",
                        }}
                      >
                        {aiResponse.ok ? aiResponse.answer : aiResponse.error}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </section>
        )}

        {/* ==================================================================
            SCREEN 5: "TRY TO BREAK IT" ROGUE ADMIN PANEL (Feature 3 — 4 Attacks)
            ================================================================== */}
        {(viewMode === "quad" || viewMode === "sysadmin") && (
          <section
            id="section-rogue-admin"
            aria-label="Try to Break It Rogue Administrator Failure Path"
            className="mp-card-danger"
          >
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "10px",
                paddingBottom: "12px",
                borderBottom: "1px solid var(--mp-border)",
                marginBottom: "14px",
              }}
            >
              <div>
                <div
                  style={{
                    fontSize: "11px",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    color: "var(--mp-danger)",
                  }}
                >
                  Screen 5 · &ldquo;Try to Break It&rdquo; Rogue Admin Panel (Feature 3)
                </div>
                <h2 style={{ margin: "2px 0 0 0", fontSize: "16px", fontWeight: 700 }}>
                  Proof of Zero Unilateral Override — All 4 Admin Escalation Attempts Blocked
                </h2>
              </div>
              <StatusBadge
                tone="danger"
                icon="ban"
                label="Logged in as: root-dba@medpool-infra.internal (No Master Key)"
              />
            </div>

            <p
              style={{
                margin: "0 0 14px 0",
                fontSize: "13px",
                color: "var(--mp-text-secondary)",
              }}
            >
              Even with full root access to the database and server infrastructure, an administrator cannot read encrypted clinical payloads, add themselves to the Ethics Board, lower the quorum from 2 to 1, or unilaterally grant access to a researcher. Click each attempt below to see the exact rule that stops it:
            </p>

            {/* 4 Rogue Operator Attack Cards (Strength #5) */}
            <div className="mp-grid-2">
              {[
                {
                  action: "ROGUE_OPEN_PAYLOAD" as const,
                  title: "Attempt 1 · Read a Patient Record Directly",
                  subtitle: "Operator tries to decrypt Specialist Referral CP-REC-001 directly from the database",
                  expectedRule: "TideMemory v1 Envelope + RelationshipAttestation:1 Policy",
                  expectedReason: "No decryption authority (_tide_decryptor + per-record bound token missing)",
                  buttonLabel: "Try to Read CP-REC-001 as Operator",
                },
                {
                  action: "ROGUE_SELF_GRANT_RECORD" as const,
                  title: "Attempt 2 · Grant Self Access to a Record",
                  subtitle: "Operator tries to grant themselves decryption rights to CP-REC-001",
                  expectedRule: "Patient Ed25519 Owner Attestation + TideCloak RelationshipAttestation:1",
                  expectedReason: "Cannot forge patient Elena Rostova's Ed25519 enclave signature (HTTP 403)",
                  buttonLabel: "Try to Self-Grant Access",
                },
                {
                  action: "ROGUE_SHARE_ON_PATIENT_BEHALF" as const,
                  title: "Attempt 3 · Share a Record on Patient's Behalf",
                  subtitle: "Operator tries to share Genomic Summary CP-REC-003 with GP without patient signature",
                  expectedRule: "verifyAttestation(bytes) Owner === Issuer === patient.vuid (AP-AT02)",
                  expectedReason: "Server rejects unsigned/forged share row; only patient's enclave key can issue",
                  buttonLabel: "Try to Share on Patient's Behalf",
                },
                {
                  action: "ROGUE_CHANGE_QUORUM_RULE" as const,
                  title: "Attempt 4 · Lower Governance Quorum (2 → 1)",
                  subtitle: "Operator tries to reduce the VVK ORK approval threshold from 2/3 down to 1/3",
                  expectedRule: "VVK ORK Threshold Formula max(1, floor(3 × 0.7)) = 2",
                  expectedReason: "Quorum rule is sealed by the 14-of-20 ORK network and immutable by 1 admin",
                  buttonLabel: "Try to Lower Quorum (2 → 1)",
                },
              ].map((item) => {
                const attempt = rogueAttempts[item.action];
                return (
                  <div
                    key={item.action}
                    style={{
                      padding: "14px",
                      borderRadius: "var(--mp-radius-md)",
                      border: attempt
                        ? "2px solid var(--mp-danger)"
                        : "1px solid var(--mp-border-strong)",
                      backgroundColor: attempt
                        ? "var(--mp-danger-bg)"
                        : "var(--mp-bg-subtle)",
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "space-between",
                      gap: "12px",
                    }}
                  >
                    <div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "6px",
                          marginBottom: "6px",
                        }}
                      >
                        <span style={{ fontWeight: 700, fontSize: "13.5px" }}>
                          {item.title}
                        </span>
                        {attempt ? (
                          <StatusBadge
                            tone="danger"
                            icon="ban"
                            label={`BLOCKED (HTTP ${attempt.status})`}
                          />
                        ) : (
                          <StatusBadge
                            tone="neutral"
                            icon="lock"
                            label="Protected"
                          />
                        )}
                      </div>
                      <p
                        style={{
                          margin: "0 0 8px 0",
                          fontSize: "12px",
                          color: "var(--mp-text-secondary)",
                        }}
                      >
                        {item.subtitle}
                      </p>

                      {attempt ? (
                        <div
                          role="alert"
                          className="mp-mono"
                          style={{
                            padding: "8px 10px",
                            borderRadius: "var(--mp-radius-sm)",
                            backgroundColor: "var(--mp-surface)",
                            border: "1px solid var(--mp-danger-border)",
                            color: "var(--mp-danger)",
                            fontSize: "11.5px",
                          }}
                        >
                          <div style={{ fontWeight: 700 }}>
                            ✗ BLOCKED — {attempt.code} ({attempt.time})
                          </div>
                          <div
                            style={{
                              marginTop: "3px",
                              fontWeight: 700,
                              color: "var(--mp-text)",
                            }}
                          >
                            Rule that stopped it: {attempt.ruleStoppedIt}
                          </div>
                          <div style={{ marginTop: "3px" }}>{attempt.reason}</div>
                        </div>
                      ) : (
                        <div
                          style={{
                            fontSize: "11.5px",
                            color: "var(--mp-text-muted)",
                          }}
                        >
                          Enforced by: <strong>{item.expectedRule}</strong>
                          <br />
                          Expected outcome: {item.expectedReason}
                        </div>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => handleRogueAttack(item.action)}
                      disabled={busyAction !== null}
                      className="mp-btn mp-btn-danger mp-btn-sm"
                      style={{ width: "100%" }}
                    >
                      <IconBan size={13} />
                      <span>{item.buttonLabel}</span>
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* ==================================================================
            SCREEN 6: PATIENT-FACING AUDIT TRAIL TIMELINE & LOG EXPORT (Strength #6)
            ================================================================== */}
        <section id="section-audit-trail" aria-label="Audit Trail Timeline" className="mp-card">
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "12px",
              paddingBottom: "12px",
              borderBottom: "1px solid var(--mp-border)",
              marginBottom: "12px",
            }}
          >
            <div>
              <div
                style={{
                  fontSize: "11px",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  color: "var(--mp-text-secondary)",
                }}
              >
                Step 6 · Patient-Facing Audit Trail (Strength #6)
              </div>
              <h2 style={{ margin: "2px 0 0 0", fontSize: "16px", fontWeight: 700 }}>
                Complete Event Timeline ({filteredAuditLog.length} Events Shown · Filter by Clinician or Event)
              </h2>
            </div>

            {/* Filter by Category, Clinician Quick-Select & Actor + Export Log File */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
              <select
                aria-label="Filter audit trail by event type"
                value={auditCategoryFilter}
                onChange={(e) => setAuditCategoryFilter(e.target.value)}
                className="mp-select"
                style={{ width: "auto" }}
              >
                <option value="ALL">All Event Types</option>
                <option value="CONSENT">Share Grants &amp; Consent</option>
                <option value="UNLOCK">Record Decryptions &amp; Refusals</option>
                <option value="REVOCATION">Revocations &amp; Access Refresh</option>
                <option value="ROGUE_ADMIN">Rogue Operator Blocked</option>
                <option value="QUORUM">Ethics Board Quorum &amp; Policy</option>
                <option value="AUTH">Auth (Sign Up / Login / Logout)</option>
                <option value="ROLE_REQUEST">Role Requests &amp; Approvals</option>
                <option value="SEARCH">Metadata Search</option>
                <option value="AI_POLICY">AI Agent Policy Check</option>
              </select>

              <select
                aria-label="Filter audit trail by clinician or actor"
                value={auditActorFilter}
                onChange={(e) => setAuditActorFilter(e.target.value)}
                className="mp-select"
                style={{ width: "auto" }}
              >
                <option value="">All Clinicians &amp; Actors</option>
                <option value="Aris Thorne">GP · Dr. Aris Thorne</option>
                <option value="Maya Lin">Physio · Dr. Maya Lin</option>
                <option value="Elena Rostova">Patient · Elena Rostova</option>
                <option value="root-dba">Rogue Operator · Marcus Vance</option>
              </select>

              <input
                type="text"
                aria-label="Filter audit trail by actor or action"
                placeholder="Search actor or action…"
                value={auditActorFilter}
                onChange={(e) => setAuditActorFilter(e.target.value)}
                className="mp-input"
                style={{ width: "175px" }}
              />

              <button
                type="button"
                onClick={() => handleExportAuditLog(filteredAuditLog, "json")}
                className="mp-btn mp-btn-secondary mp-btn-sm"
                title="Download governance audit log as JSON (log metadata only, zero clinical record content)"
              >
                ⬇ Export Log (.json)
              </button>

              <button
                type="button"
                onClick={() => handleExportAuditLog(filteredAuditLog, "csv")}
                className="mp-btn mp-btn-secondary mp-btn-sm"
                title="Download governance audit log as CSV (log metadata only, zero clinical record content)"
              >
                ⬇ Export Log (.csv)
              </button>
            </div>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "8px",
              maxHeight: "340px",
              overflowY: "auto",
              paddingRight: "4px",
            }}
          >
            {filteredAuditLog.map((entry) => {
              const tone =
                entry.outcome === "ALLOWED"
                  ? "success"
                  : entry.outcome === "PENDING_QUORUM_202"
                  ? "pending"
                  : "danger";
              const icon =
                entry.outcome === "ALLOWED"
                  ? "check"
                  : entry.outcome === "PENDING_QUORUM_202"
                  ? "clock"
                  : "ban";
              return (
                <div
                  key={entry.id}
                  style={{
                    padding: "10px 12px",
                    borderRadius: "var(--mp-radius-sm)",
                    backgroundColor: "var(--mp-bg-subtle)",
                    border: "1px solid var(--mp-border)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "4px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "8px",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        alignItems: "center",
                        gap: "8px",
                      }}
                    >
                      <StatusBadge
                        tone={tone}
                        icon={icon}
                        label={`HTTP ${entry.httpStatus} · ${entry.outcome}`}
                      />
                      {entry.category && (
                        <StatusBadge
                          tone="neutral"
                          label={entry.category}
                        />
                      )}
                      <strong style={{ fontSize: "12.5px" }}>{entry.actor}</strong>
                      <span
                        className="mp-mono"
                        style={{
                          fontSize: "12px",
                          color: "var(--mp-accent)",
                          fontWeight: 600,
                        }}
                      >
                        {entry.action}
                      </span>
                    </div>
                    <span
                      className="mp-mono"
                      style={{
                        fontSize: "11px",
                        color: "var(--mp-text-muted)",
                      }}
                    >
                      {new Date(entry.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: "12px",
                      color: "var(--mp-text-secondary)",
                    }}
                  >
                    {entry.detail}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </main>

      {/* ====================================================================
          SCREEN 7: REVOCATION CONFIRMATION MODAL & GUIDED DEMO PANEL
          ==================================================================== */}
      <ConfirmRevokeModal
        open={revokeModalTarget !== null}
        targetType={revokeModalTarget}
        onCancel={() => setRevokeModalTarget(null)}
        onConfirm={handleConfirmRevoke}
        busy={busyAction !== null}
      />

      <GuidedDemoPanel
        open={guidedDemoOpen}
        onToggle={() => setGuidedDemoOpen((prev) => !prev)}
        accounts={state.accounts || []}
        currentAccount={currentAccount}
        onSwitchAccount={handleSwitchDemoAccount}
        onResetDemo={handleResetDemo}
        busy={busyAction !== null}
        gpHasReferralGrant={(state.shareGrants || []).some(
          (g) =>
            g.recordId === "CP-REC-001" &&
            g.clinicianAccountId === "acct-gp-1" &&
            g.status === "ACTIVE"
        )}
        physioHasCarePlanGrant={(state.shareGrants || []).some(
          (g) =>
            g.recordId === "CP-REC-002" &&
            g.clinicianAccountId === "acct-physio-1" &&
            g.status === "ACTIVE"
        )}
        clinicianTestedBoth={Boolean(
          clinicianUnlocked["acct-gp-1"]?.["CP-REC-001"] &&
            clinicianUnlocked["acct-physio-1"]?.["CP-REC-002"]
        )}
        rogueBlockedCount={Object.keys(rogueAttempts).length}
        physioRevoked={(state.shareGrants || []).some(
          (g) =>
            g.recordId === "CP-REC-002" &&
            g.clinicianAccountId === "acct-physio-1" &&
            g.status === "REVOKED"
        )}
        onJumpToSection={(sectionId) => {
          setViewMode("quad");
          setTimeout(() => {
            const el = document.getElementById(sectionId);
            if (el) {
              el.scrollIntoView({ behavior: "smooth", block: "start" });
            }
          }, 60);
        }}
      />
    </div>
  );
}
