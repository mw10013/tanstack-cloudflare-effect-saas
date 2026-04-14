import type { AuthInstance } from "@/lib/Auth";
import type { useOrganizationAgent } from "@/lib/OrganizationAgentContext";

type OrganizationAgentContextValue = ReturnType<typeof useOrganizationAgent>;

export const fakeOrg: AuthInstance["$Infer"]["Organization"] = {
  id: "org_test",
  name: "Test Org",
  slug: "test-org",
  logo: null,
  metadata: null,
  createdAt: new Date("2026-01-01"),
};

export const fakeUser: AuthInstance["$Infer"]["Session"]["user"] = {
  id: "user_test",
  email: "u@u.com",
  name: "Test User",
  emailVerified: true,
  image: null,
  role: "user",
  banned: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

export const fakeAppContext = {
  organization: fakeOrg,
  organizations: [fakeOrg],
  sessionUser: fakeUser,
};

const notCalled = () => {
  throw new Error("fakeAgent method called in a test that did not mock it");
};

export const fakeAgent: OrganizationAgentContextValue = {
  call: notCalled as OrganizationAgentContextValue["call"],
  stub: new Proxy({}, { get: notCalled }) as OrganizationAgentContextValue["stub"],
  ready: Promise.resolve(),
  identified: true,
};
