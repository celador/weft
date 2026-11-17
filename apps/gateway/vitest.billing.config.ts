// Usage billing tests: the gateway with Stripe configured (test-mode shaped secrets, a tiny free allowance).
// The rest of the suite runs with billing off (vitest.config.ts); `pnpm test` runs both.
import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
  return {
    test: {
      include: ["test/billing/**/*.test.ts"],
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
              // billing on: fake test-mode secrets and Pro prices (Stripe is mocked with fetchMock) and a free allowance of 6 events
              WEFT_FREE_EVENTS: "6",
              STRIPE_SECRET_KEY: "sk_test_unit_key",
              STRIPE_WEBHOOK_SECRET: "whsec_unit_secret",
              STRIPE_PRICE_PRO_MONTH: "price_pro_month",
              STRIPE_PRICE_PRO_YEAR: "price_pro_year",
              // Pro fair use: 5 events per seat per month (tiny, so a test can pass it)
              WEFT_PRO_FAIR_USE_EVENTS: "5",
              WEFT_WELCOME_URL: "https://site.test/welcome/",
              WEFT_PRICING_URL: "https://site.test/pricing/",
              WEFT_SITE_ORIGINS: "https://site.test",
              STRIPE_METER_EVENT_NAME: "weft_agent_events",
            },
          },
        },
      },
    },
  };
});
