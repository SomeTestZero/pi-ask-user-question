/**
 * Standalone test setup (fork): trimmed from the rpiv-mono monorepo setup to
 * the state this package actually owns. Sandboxes $HOME per worker and clears
 * the config/agent files the package reads, before each test. The monorepo
 * setup additionally reset sibling-package state (rpiv-todo, rpiv-advisor,
 * rpiv-i18n, …) — none of that is reachable from this package.
 *
 * Dynamic imports inside `beforeEach` (rather than static imports at the top)
 * are deliberate upstream design: static imports execute before the $HOME
 * sandbox is set, letting production modules capture the real homedir.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach } from "vitest";

const TEST_HOME = mkdtempSync(join(tmpdir(), "rpiv-test-home-"));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
delete process.env.PI_CODING_AGENT_DIR;
delete process.env.XDG_CONFIG_HOME;
delete process.env.WEB_SEARCH_PROVIDER;

beforeEach(async () => {
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.XDG_CONFIG_HOME;
	delete process.env.WEB_SEARCH_PROVIDER;

	// Mirrors the monorepo setup's `i18n.__resetState()` — the i18n stub keeps
	// registered strings and the active locale across tests otherwise.
	const i18n = await import("./i18n-missing-stub.js");
	i18n.__resetState();

	const askUserQuestionConfig = join(process.env.HOME!, ".config", "rpiv-ask-user-question", "config.json");
	const piAgentSettings = join(process.env.HOME!, ".pi", "agent", "settings.json");
	const xdgPiAgentDir = join(process.env.HOME!, ".config", "pi", "agent");
	rmSync(askUserQuestionConfig, { force: true });
	rmSync(piAgentSettings, { force: true });
	rmSync(xdgPiAgentDir, { recursive: true, force: true });
	rmSync(join(process.env.HOME!, ".pi", "agent"), { recursive: true, force: true });
});
