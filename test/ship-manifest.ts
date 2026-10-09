/**
 * Standalone replacement for the monorepo-internal `@juicesharp/rpiv-test-utils`
 * `verifyShipManifest` (not published to npm). Mirrors its contract for this
 * package: every production .ts module on disk must be covered by the `files`
 * array in package.json — either listed exactly or under an included directory
 * prefix. `!`/`-` entries are exclusions. Test modules and fixtures are not
 * shipped and therefore not checked.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export function verifyShipManifest(moduleUrl: string): { missing: string[] } {
	const root = dirname(fileURLToPath(moduleUrl));
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { files?: string[] };
	const files = pkg.files ?? [];
	const includes = files.filter((f) => !f.startsWith("!") && !f.startsWith("-"));
	const excludes = files.filter((f) => f.startsWith("!") || f.startsWith("-")).map((f) => f.slice(1));

	const missing: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const abs = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "test") continue;
				walk(abs);
				continue;
			}
			if (!entry.name.endsWith(".ts")) continue;
			if (entry.name.endsWith(".test.ts") || entry.name === "test-fixtures.ts") continue;
			const rel = relative(root, abs).split(sep).join("/");
			const covered =
				includes.some((f) => f === rel || (f.endsWith("/") && rel.startsWith(f))) &&
				!excludes.some((f) => f === rel || (f.endsWith("/") && rel.startsWith(f)));
			if (!covered) missing.push(rel);
		}
	};
	walk(root);
	return { missing };
}
