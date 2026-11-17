// Accounts tests: the gateway with Clerk accounts on (a test Weft application whose public key is pinned with
// CLERK_JWKS) and Stripe configured with fake test-mode secrets (Stripe is mocked with fetchMock).
import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";
import { WEFT_JWKS } from "./test/accounts/keys";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
  return {
    test: {
      include: ["test/accounts/**/*.test.ts"],
      testTimeout: 30_000,
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          isolatedStorage: false,
          singleWorker: false,
          main: "./src/index.ts",
          wrangler: { configPath: "./wrangler.toml", environment: "test" },
          miniflare: {
            bindings: {
              WEFT_ADMIN_TOKEN: "test-admin-token",
              TEST_MIGRATIONS: migrations,
              WEFT_SIGNUPS: "open",
              WEFT_SIGNUPS_PER_IP_DAY: "1000",
              WEFT_SPACE_MAX_REPOS: "5",
              WEFT_SPACE_MAX_TOKENS: "20",
              WEFT_SPACE_RPM: "10000",
              // accounts on: the test Weft application (issuer + pinned public keys), pages on https://site.test only
              CLERK_ISSUER: "https://clerk.weft.test",
              CLERK_AUTHORIZED_PARTIES: "https://site.test",
              CLERK_JWKS: JSON.stringify(WEFT_JWKS),
              WEFT_SITE_URL: "https://site.test",
              WEFT_ACCOUNT_URL: "https://site.test/account/",
              WEFT_SITE_ORIGINS: "https://site.test",
              // billing on (Stripe mocked)
              WEFT_FREE_EVENTS: "6",
              STRIPE_SECRET_KEY: "sk_test_unit_only",
              STRIPE_WEBHOOK_SECRET: "whsec_unit_secret",
              STRIPE_PRICE_PRO_MONTH: "price_pro_month",
              STRIPE_PRICE_PRO_YEAR: "price_pro_year",
            },
          },
        },
      },
    },
  };
});
