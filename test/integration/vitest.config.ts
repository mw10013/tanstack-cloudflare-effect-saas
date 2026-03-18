import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import path from "node:path";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrationsPath = path.join(__dirname, "../../migrations");
  const migrations = await readD1Migrations(migrationsPath);
  const wranglerConfigPath = path.resolve(__dirname, "../../wrangler.jsonc");

  return {
    plugins: [
      tsconfigPaths({
        projects: [path.resolve(__dirname, "../../tsconfig.json")],
      }),
      cloudflareTest({
        wrangler: {
          configPath: wranglerConfigPath,
        },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      include: ["test/integration/*.test.ts"],
      setupFiles: ["test/apply-migrations.ts"],
    },
  };
});
