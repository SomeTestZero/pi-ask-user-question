import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: [
			// The monorepo-internal `@juicesharp/rpiv-test-utils` is not published;
			// tests resolve it to the local standalone reimplementation.
			{
				find: "@juicesharp/rpiv-test-utils",
				replacement: fileURLToPath(new URL("./test/rpiv-test-utils.ts", import.meta.url)),
			},
			// The soft-optional peer `@juicesharp/rpiv-i18n` is not installed in this
			// standalone repo; alias every subpath to a stub whose evaluation rejects,
			// so the modules' documented try/catch fallback runs.
			{
				find: /^@juicesharp\/rpiv-i18n(?:\/.*)?$/,
				replacement: fileURLToPath(new URL("./test/i18n-missing-stub.ts", import.meta.url)),
			},
		],
	},
	test: {
		include: ["**/*.test.ts"],
		setupFiles: ["./test/setup.ts"],
		// Mirrors the upstream monorepo config: cold-cache dynamic imports in
		// test/setup.ts can exceed vitest defaults on the first test of a worker.
		hookTimeout: 30_000,
		testTimeout: 15_000,
	},
});
