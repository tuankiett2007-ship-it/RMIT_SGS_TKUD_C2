import { NextRequest } from "next/server";
import { withAuth, withRole } from "@/lib/auth/middleware";
import { readDb, writeDb, STUDY_GROUP_ID } from "@/lib/medpool/store";
import {
  DEFAULT_ALLOWED_AI_FIELDS,
  DEFAULT_DENIED_AI_FIELDS,
} from "@/lib/medpool/sandbox";
import { describeRelationshipPolicy } from "@/lib/tide/relationship";

/**
 * GET /api/medpool/policies?record=/studies/study-42
 * Protected by server-side EdDSA JWT verification + RFC 9449 DPoP proof verification (AP-RA07, AP-RA13).
 * Returns the signed RelationshipAttestation:1 policy ONLY if the caller matches its subject
 * (User tideuserkey, Group in `groups` claim, or Role).
 */
export const GET = withAuth(async (req: NextRequest, jwt) => {
  const url = new URL(req.url);
  const recordId = url.searchParams.get("record") || STUDY_GROUP_ID;

  const db = readDb();
  const callerGroups = Array.isArray(jwt.groups)
    ? (jwt.groups as string[])
    : db.researcherGroupMemberships;
  const callerKey = typeof jwt.tideuserkey === "string" ? jwt.tideuserkey : "";
  const callerRoles = Array.isArray((jwt.realm_access as any)?.roles)
    ? ((jwt.realm_access as any).roles as string[])
    : [];

  const matching = db.relationshipPolicies.find((p) => {
    if (p.recordId !== recordId) return false;
    if (p.subjectType === "Group") return callerGroups.includes(p.subjectId);
    if (p.subjectType === "User") return Boolean(callerKey) && p.subjectId === callerKey;
    if (p.subjectType === "Role") return callerRoles.includes(p.subjectId);
    return false;
  });

  if (!matching) {
    return Response.json(
      {
        error: `No RelationshipAttestation:1 policy grants caller access to '${recordId}'. Caller groups: [${callerGroups.join(", ")}]`,
      },
      { status: 403 }
    );
  }

  return Response.json({ policy: matching });
});

/**
 * POST /api/medpool/policies
 * Protected by `withRole("tide-realm-admin")` + DPoP verification (AP-RA08).
 * Parses the signed policy bytes to verify it uses `RelationshipAttestation:1` before storing.
 */
export const POST = withRole("tide-realm-admin", async (req: NextRequest, jwt) => {
  const body = await req.json();
  const { policyB64, expiresAt } = body as { policyB64: string; expiresAt?: number };

  if (!policyB64 || typeof policyB64 !== "string") {
    return Response.json({ error: "Missing policyB64" }, { status: 400 });
  }

  const info = describeRelationshipPolicy(policyB64);
  if (!info.isRelationshipPolicy || !info.signed) {
    return Response.json(
      { error: "Rejected: Policy is not a signed RelationshipAttestation:1 policy" },
      { status: 400 }
    );
  }

  const db = readDb();
  const entry = {
    subjectType: info.subjectType as "Group" | "User" | "Role",
    subjectId: info.subjectId,
    clientId: info.clientId,
    recordId: info.recordId,
    roles: info.roles,
    policyB64,
    contractId: "RelationshipAttestation:1" as const,
    allowedAiFields: DEFAULT_ALLOWED_AI_FIELDS,
    deniedAiFields: DEFAULT_DENIED_AI_FIELDS,
    expiresAt: expiresAt || Math.floor(Date.now() / 1000) + 600,
    grantedBy: String(jwt.preferred_username || jwt.sub || "tide-realm-admin"),
    createdAt: new Date().toISOString(),
  };

  db.relationshipPolicies = db.relationshipPolicies.filter(
    (p) =>
      !(
        p.subjectType === entry.subjectType &&
        p.subjectId === entry.subjectId &&
        p.recordId === entry.recordId
      )
  );
  db.relationshipPolicies.push(entry);
  writeDb(db);

  return Response.json({ ok: true, policy: entry }, { status: 201 });
});

