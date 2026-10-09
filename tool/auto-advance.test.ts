import { describe, expect, it } from "vitest";
import {
	autoNotes,
	buildAutoResult,
	buildTimeoutResponse,
	DEFAULT_TIMEOUT_MINUTES,
	MAX_TIMEOUT_MINUTES,
	MIN_TIMEOUT_MINUTES,
	pickAutoOption,
	resolveTimeoutConfig,
} from "./auto-advance.js";
import type { QuestionParams } from "./types.js";

const params: QuestionParams = {
	questions: [
		{
			question: "Which cache strategy?",
			header: "Caching",
			options: [
				{ label: "In-memory (Recommended)", description: "fast, per-process" },
				{ label: "Redis", description: "shared, needs a server" },
			],
		},
		{
			question: "Which tests?",
			header: "Testing",
			multiSelect: true,
			options: [
				{ label: "Unit", description: "fast" },
				{ label: "Integration", description: "slower" },
			],
		},
	],
};

describe("resolveTimeoutConfig", () => {
	it("defaults to 5 minutes, recommended policy", () => {
		const t = resolveTimeoutConfig({});
		expect(t.enabled).toBe(true);
		expect(t.minutes).toBe(DEFAULT_TIMEOUT_MINUTES);
		expect(t.ms).toBe(5 * 60_000);
		expect(t.action).toBe("recommended");
	});

	it("disables on non-positive minutes", () => {
		expect(resolveTimeoutConfig({ timeout: { minutes: 0 } }).enabled).toBe(false);
		expect(resolveTimeoutConfig({ timeout: { minutes: -3 } }).enabled).toBe(false);
	});

	it("clamps out-of-range minutes", () => {
		expect(resolveTimeoutConfig({ timeout: { minutes: 0.01 } }).minutes).toBe(MIN_TIMEOUT_MINUTES);
		expect(resolveTimeoutConfig({ timeout: { minutes: 9999 } }).minutes).toBe(MAX_TIMEOUT_MINUTES);
	});

	it("falls back to defaults for invalid values", () => {
		const t = resolveTimeoutConfig({ timeout: { minutes: Number.NaN, action: "yolo" as never } });
		expect(t.minutes).toBe(DEFAULT_TIMEOUT_MINUTES);
		expect(t.action).toBe("recommended");
	});
});

describe("pickAutoOption", () => {
	it("prefers the (Recommended) option", () => {
		const q = {
			question: "q",
			header: "H",
			options: [
				{ label: "A", description: "a" },
				{ label: "B (recommended)", description: "b" },
			],
		};
		expect(pickAutoOption(q, "recommended")?.label).toBe("B (recommended)");
	});

	it("falls back to the first option", () => {
		const q = params.questions[0];
		expect(pickAutoOption(q, "first")?.label).toBe("In-memory (Recommended)");
		const plain = { question: "q", header: "H", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] };
		expect(pickAutoOption(plain, "recommended")?.label).toBe("A");
	});
});

describe("buildAutoResult", () => {
	it("answers single-select as option and multi-select as multi", () => {
		const result = buildAutoResult(params, resolveTimeoutConfig({}));
		expect(result.cancelled).toBe(false);
		expect(result.answers).toHaveLength(2);
		expect(result.answers[0]).toMatchObject({ questionIndex: 0, kind: "option", answer: "In-memory (Recommended)" });
		expect(result.answers[1]).toMatchObject({ questionIndex: 1, kind: "multi", selected: ["Unit"] });
		expect(result.answers[0].notes).toBe(autoNotes(5));
	});

	it("carries the preview of the picked option", () => {
		const withPreview: QuestionParams = {
			questions: [
				{
					question: "q",
					header: "H",
					options: [
						{ label: "A", description: "a", preview: "ascii" },
						{ label: "B", description: "b" },
					],
				},
			],
		};
		expect(buildAutoResult(withPreview, resolveTimeoutConfig({})).answers[0].preview).toBe("ascii");
	});
});

describe("buildTimeoutResponse", () => {
	it("labels the envelope as automatic and not human ground truth", () => {
		const r = buildTimeoutResponse(params, resolveTimeoutConfig({}));
		expect(r.content[0].text).toContain("AUTO-ADVANCED");
		expect(r.content[0].text).toContain("no user input within 5 minutes");
		expect(r.content[0].text).toContain('"Which cache strategy?"="In-memory (Recommended)"');
		expect(r.content[0].text).toContain("Treat them as defaults");
		expect(r.details.cancelled).toBe(false);
	});

	it("decline policy returns the canonical decline text", () => {
		const r = buildTimeoutResponse(params, resolveTimeoutConfig({ timeout: { action: "decline" } }));
		expect(r.content[0].text).toContain("User declined to answer questions");
		expect(r.content[0].text).toContain("Decide and proceed on your own");
		expect(r.details.cancelled).toBe(true);
		expect(r.details.answers).toEqual([]);
	});
});
