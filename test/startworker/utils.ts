import { execFileSync } from "node:child_process";
import path from "node:path";

import { unstable_startWorker } from "wrangler";

export type StartWorker = Awaited<ReturnType<typeof unstable_startWorker>>;

export const root = path.resolve(__dirname, "../..");
export const configPath = path.resolve(root, "dist/server/wrangler.json");
export const persistPath = path.resolve(root, ".wrangler/state");

export function applyLocalMigrations() {
  execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "d1-local",
      "--local",
      "--persist-to",
      persistPath,
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, NO_D1_WARNING: "true" },
    },
  );
}

export async function startWorker() {
  const worker = await unstable_startWorker({
    config: configPath,
    entrypoint: path.resolve(root, "dist/server/index.js"),
    dev: {
      persist: persistPath,
      server: { port: 0 },
      inspector: false,
    },
  });
  await worker.ready;
  return worker;
}

export function resetDb() {
  execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "d1-local",
      "--local",
      "--persist-to",
      persistPath,
      "--command",
      [
        'delete from "Session";',
        'delete from "Member";',
        'delete from "Invitation";',
        'delete from "Verification";',
        'delete from "Organization";',
        "delete from \"Account\" where id <> 'admin';",
        "delete from \"User\" where id <> 'admin';",
      ].join(" "),
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, NO_D1_WARNING: "true" },
    },
  );
}
