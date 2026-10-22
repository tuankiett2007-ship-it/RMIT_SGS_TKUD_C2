"use client";

import { useEffect, useState } from "react";
import { useTideCloak } from "@tidecloak/nextjs";
import { appFetch } from "@/lib/auth/appFetch";

const DISMISS_KEY = "tide.profile-onboarding.dismissed";

type Props = {
  baseUrl: string;
  realm: string;
  fields?: Array<"email" | "firstName" | "lastName">;
  required?: boolean;
  onDone?: () => void;
};

export function ProfileOnboarding({
  baseUrl,
  realm,
  fields = ["firstName", "lastName", "email"],
  required = false,
  onDone,
}: Props) {
  const { authenticated, getValueFromToken, token } = useTideCloak();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState({ email: "", firstName: "", lastName: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!authenticated) return;
    if (!required && localStorage.getItem(DISMISS_KEY) === "1") return;

    const hasName = getValueFromToken("given_name") || getValueFromToken("name");
    const hasEmail = getValueFromToken("email");

    const missing =
      (fields.includes("firstName") && !hasName) ||
      (fields.includes("email") && !hasEmail);

    if (missing) {
      setValues((v) => ({
        ...v,
        email: (getValueFromToken("email") as string) || "",
        firstName: (getValueFromToken("given_name") as string) || "",
        lastName: (getValueFromToken("family_name") as string) || "",
      }));
      setOpen(true);
    }
  }, [authenticated, fields, required, getValueFromToken]);

  if (!open) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, "1");
    setOpen(false);
    onDone?.();
  };

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, string> = {};
      for (const f of fields) if (values[f]) body[f] = values[f].trim();

      const res = await fetch(`${baseUrl}/realms/${realm}/account/`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (res.status === 401 || res.status === 403) {
        throw new Error(
          "Not authorised to update your profile. Check the token includes the `account` audience."
        );
      }
      if (res.status === 202) {
        throw new Error(
          "Your changes were queued for approval and are not saved yet."
        );
      }
      if (!res.ok) throw new Error(`Could not save your details (${res.status}).`);

      // Sync collected name & email to MedPool account record via secureFetch wrapper
      const vuid = (getValueFromToken("vuid") as string) || "";
      const fullName = [values.firstName.trim(), values.lastName.trim()]
        .filter(Boolean)
        .join(" ");
      if (vuid && (fullName || values.email.trim())) {
        await appFetch("/api/medpool/state", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "UPDATE_PROFILE_DETAILS",
            vuid,
            name: fullName,
            email: values.email.trim(),
          }),
        }).catch(() => {});
      }

      setOpen(false);
      onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const label: Record<string, string> = {
    email: "Email",
    firstName: "First name",
    lastName: "Last name",
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="tide-onboarding-title"
      className="mp-modal-overlay"
    >
      <div className="mp-modal">
        <div className="mp-modal__header">
          <h2 id="tide-onboarding-title" className="mp-modal__title">
            Complete Your MedPool Profile
          </h2>
        </div>
        <div className="mp-modal__body">
          <p className="mp-card__subtitle" style={{ marginBottom: "1rem" }}>
            A new TideCloak identity asserts only your zero-knowledge{" "}
            <code className="mp-code-inline">vuid</code> — it starts with no name or
            email. Enter your details below to attach them via the self-service Account API.
          </p>
          {fields.map((f) => (
            <div key={f} className="mp-field" style={{ marginBottom: "0.75rem" }}>
              <label className="mp-label" htmlFor={`onboard-${f}`}>
                {label[f]}
              </label>
              <input
                id={`onboard-${f}`}
                className="mp-input"
                type={f === "email" ? "email" : "text"}
                value={values[f]}
                onChange={(e) => setValues({ ...values, [f]: e.target.value })}
              />
            </div>
          ))}
          {error && (
            <p role="alert" style={{ color: "var(--mp-danger)", fontSize: "0.82rem" }}>
              {error}
            </p>
          )}
        </div>
        <div className="mp-modal__footer">
          {!required && (
            <button type="button" className="mp-btn" onClick={dismiss} disabled={busy}>
              Not now
            </button>
          )}
          <button
            type="button"
            className="mp-btn mp-btn--primary"
            onClick={save}
            disabled={busy}
          >
            {busy ? "Saving..." : "Save Profile"}
          </button>
        </div>
      </div>
    </div>
  );
}
