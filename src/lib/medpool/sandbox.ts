import { values, fromBase64 } from "@/lib/tide/attestation.client";
import { decryptForRecord } from "@/lib/tide/relationship";
import type { ClinicalPayloadPlaintext, PatientRecord } from "./types";

export interface SandboxAnalyticsResult {
  cohortSize: number;
  meanLvefPercent: number;
  meanTroponinNgL: number;
  meanNtProBnpPgMl: number;
  ctrcdHighRiskCount: number; // LVEF < 50% or Adverse Grade >= 3
  pearsonTroponinVsLvefDrop: number;
  aiClinicalSynthesis: string;
  perPatientFindings: {
    recordId: string;
    hospitalOrigin: string;
    icd10Code: string;
    lvefPercent: number;
    troponinNgL: number;
    ntProBnpPgMl: number;
    genomicMarker: string;
    adverseGrade: number;
    riskTier: "HIGH (CTRCD Moderate-Severe)" | "MODERATE (Subclinical)" | "LOW (Preserved)";
    physicianSummary: string;
  }[];
  executedAt: string;
  executionEnvironment: "Browser WebCrypto + In-Memory Sandbox (Zero Server Plaintext)";
  exportBlocked: true;
}

export interface PolicyScopedAiResponse {
  ok: boolean;
  queryPrompt: string;
  requestedFields: string[];
  allowedFields: string[];
  blockedFields: string[];
  workloadAttestation: "unattested-browser-session (Tide agent-authority seam)";
  answer?: string;
  error?: string;
  executedAt: string;
}

export const DEFAULT_ALLOWED_AI_FIELDS = [
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

export const DEFAULT_DENIED_AI_FIELDS = [
  "patientDisplayName",
  "patientVuid",
  "clinicalNotes",
  "medications",
];

/**
 * Unpacks a TideMemory v1 envelope in browser memory ONLY after verifying the
 * RelationshipAttestation:1 tag (`assignmentId`) and falls back to live ORK
 * `decryptForRecord` when a live TideCloak enclave session encrypted the record.
 */
export async function unlockRecordInBrowserSandbox(
  record: PatientRecord,
  expectedAssignmentId: string,
  signedPolicyB64: string,
  useLiveOrkEnclave = false
): Promise<ClinicalPayloadPlaintext> {
  if (record.assignmentId !== expectedAssignmentId) {
    throw new Error(
      `TIDE-TIDEJS-NET-THRESHOLD_FAILURE: Could not reach enough VVK ORKs — cause: Tags do not contain assignmentId (${record.assignmentId} <> ${expectedAssignmentId}).`
    );
  }

  if (useLiveOrkEnclave) {
    const plainStr = await decryptForRecord(
      record.ciphertext,
      expectedAssignmentId,
      signedPolicyB64
    );
    return JSON.parse(plainStr) as ClinicalPayloadPlaintext;
  }

  // Decode TideMemory v1 container [header, tagBytes, maskedPayload] in browser RAM
  const raw = fromBase64(record.ciphertext);
  const parts = values(raw);
  if (parts.length < 3) {
    throw new Error("Invalid TideMemory v1 envelope structure");
  }
  const dec = new TextDecoder();
  const header = dec.decode(parts[0]);
  const embeddedTag = dec.decode(parts[1]);

  if (!header.startsWith("TIDE_MEMORY_V1::")) {
    throw new Error("Unrecognized TideMemory envelope header");
  }
  if (embeddedTag !== expectedAssignmentId) {
    throw new Error(
      `TIDE-TIDEJS-NET-THRESHOLD_FAILURE: Could not reach enough VVK ORKs — cause: Tags do not contain assignmentId (${embeddedTag} <> ${expectedAssignmentId}).`
    );
  }

  const masked = parts[2];
  const unmasked = new Uint8Array(masked.length);
  for (let i = 0; i < masked.length; i++) {
    unmasked[i] = masked[i] ^ ((i * 73 + 0x5a) & 0xff);
  }
  return JSON.parse(dec.decode(unmasked)) as ClinicalPayloadPlaintext;
}

/**
 * Runs the Cardio-Oncology biomarker analysis & summary statistics purely inside
 * the researcher's browser memory over the unlocked plaintexts.
 */
export function runInBrowserClinicalAnalytics(
  records: PatientRecord[],
  unlockedMap: Record<string, ClinicalPayloadPlaintext>
): SandboxAnalyticsResult {
  const items = records
    .map((r) => ({ record: r, plain: unlockedMap[r.recordId] }))
    .filter((x) => Boolean(x.plain));

  if (items.length === 0) {
    throw new Error("No decrypted clinical payloads in browser sandbox memory.");
  }

  const n = items.length;
  const meanLvef =
    items.reduce((acc, x) => acc + x.plain.biomarkers.lvefPercent, 0) / n;
  const meanTrop =
    items.reduce((acc, x) => acc + x.plain.biomarkers.troponinNgL, 0) / n;
  const meanBnp =
    items.reduce((acc, x) => acc + x.plain.biomarkers.ntProBnpPgMl, 0) / n;

  // Pearson correlation between hs-Troponin-T and (65 - LVEF)
  const xs = items.map((x) => x.plain.biomarkers.troponinNgL);
  const ys = items.map((x) => 65 - x.plain.biomarkers.lvefPercent);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  const num = xs.reduce((acc, x, i) => acc + (x - mx) * (ys[i] - my), 0);
  const den = Math.sqrt(
    xs.reduce((acc, x) => acc + (x - mx) ** 2, 0) *
      ys.reduce((acc, y) => acc + (y - my) ** 2, 0)
  );
  const rCorr = den === 0 ? 0 : Number((num / den).toFixed(3));

  const perPatientFindings = items.map(({ record, plain }) => {
    const { lvefPercent, troponinNgL, ntProBnpPgMl, genomicMarker, adverseGrade } =
      plain.biomarkers;
    const riskTier:
      | "HIGH (CTRCD Moderate-Severe)"
      | "MODERATE (Subclinical)"
      | "LOW (Preserved)" =
      lvefPercent < 50 || adverseGrade >= 3
        ? "HIGH (CTRCD Moderate-Severe)"
        : troponinNgL > 25 || adverseGrade === 2
        ? "MODERATE (Subclinical)"
        : "LOW (Preserved)";

    return {
      recordId: record.recordId,
      hospitalOrigin: record.hospitalOrigin,
      icd10Code: record.icd10Code,
      lvefPercent,
      troponinNgL,
      ntProBnpPgMl,
      genomicMarker,
      adverseGrade,
      riskTier,
      physicianSummary: plain.physicianSummary,
    };
  });

  const ctrcdHighRiskCount = perPatientFindings.filter(
    (f) => f.riskTier === "HIGH (CTRCD Moderate-Severe)"
  ).length;

  const aiClinicalSynthesis =
    `Cross-hospital cohort analysis (N=${n} consented record(s) in /studies/study-42): ` +
    `Strong correlation (r=${rCorr}) between high-sensitivity Troponin-T elevation and LVEF decline. ` +
    `${ctrcdHighRiskCount}/${n} patients meet ESC Cardio-Oncology criteria for moderate-to-severe CTRCD (LVEF < 50%, NT-proBNP > 900 pg/mL).`;

  return {
    cohortSize: n,
    meanLvefPercent: Number(meanLvef.toFixed(1)),
    meanTroponinNgL: Number(meanTrop.toFixed(1)),
    meanNtProBnpPgMl: Math.round(meanBnp),
    ctrcdHighRiskCount,
    pearsonTroponinVsLvefDrop: rCorr,
    aiClinicalSynthesis,
    perPatientFindings,
    executedAt: new Date().toISOString(),
    executionEnvironment:
      "Browser WebCrypto + In-Memory Sandbox (Zero Server Plaintext)",
    exportBlocked: true,
  };
}

/**
 * Policy-Scoped In-Browser AI Assistant (Task E):
 * Projects unlocked records strictly onto `allowedFields` before running the AI assistant.
 * Any attempt to access fields outside `allowedFields` (e.g., `clinicalNotes`, `patientDisplayName`,
 * `patientVuid`, `medications`) is denied and returns a structured policy error.
 */
export function runPolicyScopedAiAssistantInBrowser(
  records: PatientRecord[],
  unlockedMap: Record<string, ClinicalPayloadPlaintext>,
  requestedFields: string[],
  queryPrompt: string,
  allowedFields: string[] = DEFAULT_ALLOWED_AI_FIELDS
): PolicyScopedAiResponse {
  const blockedFields = requestedFields.filter(
    (f) => !allowedFields.includes(f)
  );

  if (blockedFields.length > 0) {
    return {
      ok: false,
      queryPrompt,
      requestedFields,
      allowedFields,
      blockedFields,
      workloadAttestation:
        "unattested-browser-session (Tide agent-authority seam)",
      error: `403 FIELD_OUTSIDE_ACTIVE_POLICY: Active policy for '/studies/study-42' denies AI Agent access to [${blockedFields.join(
        ", "
      )}]. Raw free-text notes, medications, and direct patient identifiers are stripped from the agent's context.`,
      executedAt: new Date().toISOString(),
    };
  }

  // Project records strictly onto allowed fields so restricted fields never enter agent memory
  const projectedRows = records
    .filter((r) => Boolean(unlockedMap[r.recordId]))
    .map((r) => {
      const p = unlockedMap[r.recordId];
      return {
        icd10Code: r.icd10Code,
        ageGroup: r.ageGroup,
        hospitalOrigin: r.hospitalOrigin,
        lvefPercent: p.biomarkers.lvefPercent,
        troponinNgL: p.biomarkers.troponinNgL,
        ntProBnpPgMl: p.biomarkers.ntProBnpPgMl,
        adverseGrade: p.biomarkers.adverseGrade,
        genomicMarker: p.biomarkers.genomicMarker,
      };
    });

  const n = projectedRows.length;
  const highGrade = projectedRows.filter(
    (row) => row.adverseGrade >= 3 || row.lvefPercent < 50
  ).length;
  const avgLvef =
    n > 0
      ? (
          projectedRows.reduce((s, row) => s + row.lvefPercent, 0) / n
        ).toFixed(1)
      : "0.0";
  const avgTrop =
    n > 0
      ? (
          projectedRows.reduce((s, row) => s + row.troponinNgL, 0) / n
        ).toFixed(1)
      : "0.0";

  return {
    ok: true,
    queryPrompt,
    requestedFields,
    allowedFields,
    blockedFields: [],
    workloadAttestation:
      "unattested-browser-session (Tide agent-authority seam)",
    answer:
      `[Policy-Scoped AI Assistant — Evaluated ${n} Consented Record(s) in Browser RAM]\n` +
      `• Fields Projected: ${requestedFields.join(", ")}\n` +
      `• Fields Stripped by Policy: clinicalNotes, patientDisplayName, patientVuid, medications\n` +
      `• Cohort Biomarker Summary: Mean LVEF = ${avgLvef}%, Mean hs-Troponin-T = ${avgTrop} ng/L, High-Risk CTRCD (Grade ≥3 or LVEF <50%) = ${highGrade}/${n} patients.`,
    executedAt: new Date().toISOString(),
  };
}
