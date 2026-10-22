"use client";

import { TideCloakProvider } from "@tidecloak/nextjs";
import tcConfig from "../../data/tidecloak.json";
import { ProfileOnboarding } from "@/components/ProfileOnboarding";

// The provider takes the adapter JSON directly as the config prop.
// useDPoP goes inside the config object, not as a separate JSX prop (I-12).
// Gotcha #9 (AP-85): Mount <ProfileOnboarding /> inside the provider so newly registered
// TideCloak users (who have a vuid but no given_name or email yet) are prompted to enter them.
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <TideCloakProvider
      config={{ ...tcConfig, useDPoP: { mode: "strict", alg: "ES256" } }}
    >
      <ProfileOnboarding
        baseUrl={tcConfig["auth-server-url"].replace(/\/+$/, "")}
        realm={tcConfig.realm}
      />
      {children}
    </TideCloakProvider>
  );
}
