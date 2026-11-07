/**
 * Stamp `lib/index.js` with a build id.
 *
 * A host keeps an applied plugin module in memory, so "the fix is on disk" and
 * "the fix is loaded" are different claims. The stamp makes the difference
 * observable: `apply()` logs it, `GET /mistral-vibe/config` returns it, and the
 * settings page prints it. It is the hash of the file *without* the stamp line,
 * so re-stamping the same source is a no-op and an edit always changes it.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = join(root, "lib", "index.js");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const STAMP = /^const BUILD = "[^"]*";$/m;
const source = readFileSync(indexPath, "utf8");
if (!STAMP.test(source)) {
  console.error('lib/index.js has no "const BUILD = ...;" line to stamp');
  process.exit(1);
}

const bare = source.replace(STAMP, 'const BUILD = "";');
const digest = createHash("sha256").update(bare).digest("hex").slice(0, 8);
const next = source.replace(STAMP, `const BUILD = "${version}+${digest}";`);

if (next === source) {
  console.log(`build ${version}+${digest} is current`);
  process.exit(0);
}

writeFileSync(indexPath, next);
console.log(`stamped build ${version}+${digest}`);
