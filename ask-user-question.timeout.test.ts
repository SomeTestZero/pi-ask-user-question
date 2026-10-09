import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createMockCtx, createMockPi, makeTheme, makeTui } from "@juicesharp/rpiv-test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAskUserQuestionTool } from "./ask-user-question.js";
import type { QuestionnaireResult } from "./tool/types.js";

type CustomFn = (...args: unknown[]) => Promise<unknown>;

// Warm the tool's lazy session-graph import NOW, under real timers: its first
// evaluation costs ~1s of worker transpilation that a fake-timer polling loop
// would never wait out. With the graph cached, execute reaches `ui.custom`
// within microtasks and the fake timeout timer can fire deterministically.
await import("./state/questionnaire-session.js");

const CONFIG_PATH = join(process.env.HOME!, ".config", "rpiv-ask-user-question", "config.json");

function writeConfig(data: Record<string, unknown>): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), "utf-8");
}

function register() {
	const { pi, captured } = createMockPi();
	registerAskUserQuestionTool(pi);
	return captured.tools.get("ask_user_question")!;
}

/** Minimal keybindings stub — no input is ever dispatched. */
const keybindings = { matches: () => false };

/**
 * Emulates `ctx.ui.custom`: runs the component factory and resolves ONLY when
 * the `done` completion callback fires — exactly how pi closes a custom UI.
 * The "user" therefore never answers and the timeout must complete the dialog.
 */
function customThatNeverAnswers() {
	return vi.fn(
		async (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (r: QuestionnaireResult) => void) => unknown) =>
			new Promise<QuestionnaireResult>((resolve) => {
				factory(makeTui(), makeTheme(), keybindings, (result) => resolve(result));
			}),
	) as unknown as CustomFn;
}

const PARAMS = {
	questions: [
		{
			question: "Which cache?",
			header: "Caching",
			options: [
				{ label: "Memory (Recommended)", description: "in-process" },
				{ label: "Redis", description: "shared" },
			],
		},
		{
			question: "Which tests?",
			header: "Testing",
			multiSelect: true,
			options: [
				{ label: "Unit", description: "fast" },
				{ label: "Integration", description: "slow" },
			],
		},
	],
};

/**
 * Wait until `execute` finishes its lazy session-graph import and opens the
 * dialog (`custom` called), then fire the 15s auto-advance timer.
 */
async function fireTimeout(custom: CustomFn): Promise<void> {
	// The lazy graph is warm, so execute reaches `ui.custom` within microtasks.
	for (let i = 0; i < 50 && custom.mock.calls.length === 0; i++) {
		await Promise.resolve();
	}
	expect(custom.mock.calls.length).toBe(1);
	await vi.advanceTimersByTimeAsync(15_000);
}

afterEach(() => {
	vi.useRealTimers();
});

describe("ask_user_question — unattended auto-advance (fork)", () => {
	it("completes the dialog via done() after the timeout and labels the answers AUTO-ADVANCED", async () => {
		writeConfig({ timeout: { minutes: 0.25 } }); // 15s
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const tool = register();
		const custom = customThatNeverAnswers();
		const ctx = createMockCtx({ hasUI: true, ui: { custom } as never });

		const pending = tool.execute?.("tc", PARAMS as never, undefined as never, undefined as never, ctx as never);
		await fireTimeout(custom);
		const r = await pending;

		expect(custom).toHaveBeenCalledTimes(1);
		expect(r?.details.cancelled).toBe(false);
		expect(r?.content[0].text).toContain("AUTO-ADVANCED");
		expect(r?.content[0].text).toContain("no user input within 0.25 minutes");
		expect(r?.content[0].text).toContain('"Which cache?"="Memory (Recommended)"');
		expect(r?.content[0].text).toContain('"Which tests?"="Unit"');
		expect(r?.content[0].text).toContain("Treat them as defaults");
		const answers = (r?.details as { answers: Array<Record<string, unknown>> }).answers;
		expect(answers).toHaveLength(2);
		expect(answers[0]).toMatchObject({ kind: "option", answer: "Memory (Recommended)" });
		expect(answers[1]).toMatchObject({ kind: "multi", selected: ["Unit"] });
		expect(String(answers[0].notes)).toContain("auto-selected after 0.25 minutes timeout");
	});

	it("action \"decline\" returns the canonical decline so the model decides itself", async () => {
		writeConfig({ timeout: { minutes: 0.25, action: "decline" } });
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const tool = register();
		const customThatNeverAnswersMock = customThatNeverAnswers();
		const ctx = createMockCtx({ hasUI: true, ui: { custom: customThatNeverAnswersMock } as never });

		const pending = tool.execute?.("tc", PARAMS as never, undefined as never, undefined as never, ctx as never);
		await fireTimeout(customThatNeverAnswersMock);
		const r = await pending;

		expect(r?.content[0].text).toContain("AUTO-ADVANCED");
		expect(r?.content[0].text).toContain("User declined to answer questions");
		expect(r?.content[0].text).toContain("Decide and proceed on your own");
		expect(r?.details).toMatchObject({ answers: [], cancelled: true });
	});

	it("timeout: 0 disables auto-advance — the tool keeps blocking like upstream", async () => {
		writeConfig({ timeout: { minutes: 0 } });
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const tool = register();
		const custom = customThatNeverAnswers();
		const ctx = createMockCtx({ hasUI: true, ui: { custom } as never });

		const pending = tool.execute?.("tc", PARAMS as never, undefined as never, undefined as never, ctx as never);
		await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
		let settled = false;
		void pending?.then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).toBe(false); // still waiting for a human
	});

	it("a human answer before the timeout wins unchanged", async () => {
		writeConfig({ timeout: { minutes: 0.25 } });
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const tool = register();
		const custom = vi.fn(
			async (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (r: QuestionnaireResult) => void) => unknown) =>
				new Promise<QuestionnaireResult>((resolve) => {
					factory(makeTui(), makeTheme(), keybindings, resolve);
					// The human answers immediately — well before the 15s timeout.
					void Promise.resolve().then(() =>
						resolve({
							cancelled: false,
							answers: [{ questionIndex: 0, question: "Which cache?", kind: "option", answer: "Redis" }],
						}),
					);
				}),
		) as unknown as CustomFn;
		const ctx = createMockCtx({ hasUI: true, ui: { custom } as never });

		const r = await tool.execute?.("tc", PARAMS as never, undefined as never, undefined as never, ctx as never);

		expect(r?.content[0].text).toContain("User has answered your questions");
		expect(r?.content[0].text).toContain('"Which cache?"="Redis"');
		expect(r?.content[0].text).not.toContain("AUTO-ADVANCED");
	});
});
