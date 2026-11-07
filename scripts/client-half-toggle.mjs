#!/usr/bin/env node
/**
 * Turn the browser half of this bundle on or off without needing a running app.
 *
 * A client entry that never settles leaves the renderer boot gate waiting, and
 * the shell answers that with Recovery Mode. This script edits only this
 * package's manifest, so it works from a plain terminal while DSH is stuck.
 *
 *   node scripts/client-half-toggle.mjs off   # remove dsh.client + "./client"
 *   node scripts/client-half-toggle.mjs on    # restore them
 *   node scripts/client-half-toggle.mjs       # report the current state
 */
import { readFile, writeFile } from "node:fs/promises";

const MANIFEST = new URL("../package.json", import.meta.url);
const CLIENT_INJECT = [
  "@deepseek-ai/dsh-client-ui-settings",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-settings-plugins",
  "@deepseek-ai/dsh-client-locale",
];

const pkg = JSON.parse(await readFile(MANIFEST, "utf8"));
const action = (process.argv[2] ?? "status").toLowerCase();

const describe = () => ({
  clientExport: pkg.exports?.["./client"] ?? null,
  clientBlock: pkg.dsh?.client ?? null,
});

if (action === "status") {
  console.log(JSON.stringify(describe(), null, 2));
} else if (action === "off") {
  if (pkg.exports !== undefined) delete pkg.exports["./client"];
  if (pkg.dsh !== undefined) delete pkg.dsh.client;
  await writeFile(MANIFEST, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  console.log("client half OFF — relaunch DSH NEXT", JSON.stringify(describe()));
} else if (action === "on") {
  pkg.exports = { ...pkg.exports, "./client": "./lib/client.js" };
  pkg.dsh = { ...pkg.dsh, client: { inject: [...CLIENT_INJECT], platform: "web" } };
  await writeFile(MANIFEST, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  console.log("client half ON — relaunch DSH NEXT", JSON.stringify(describe()));
} else {
  console.error(`unknown action ${JSON.stringify(action)}: use on, off, or status`);
  process.exitCode = 2;
}
