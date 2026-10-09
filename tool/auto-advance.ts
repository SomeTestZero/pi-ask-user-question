/**
 * auto-advance — unattended-timeout policy for ask_user_question (fork addition).
 *
 * When the questionnaire has been awaiting user input longer than the configured
 * timeout (default 5 minutes), the run is presumed unattended and the tool stops
 * blocking: an answer is selected automatically (or the questionnaire is treated
 * as declined) so the agent can continue the task without a human.
 *
 * Policy shapes:
 * - "recommended": pick the option whose label carries a "(Recommended)" marker,
 *   falling back to the first option.
 * - "first": always the first option.
 * - "decline": return the canonical DECLINE_MESSAGE so the model decides itself.
 *
 * Everything here is pure of (params, resolved config) so it stays unit-testable
 * without a TUI. The timeout wiring lives in ask-user-question.ts.
 */

import type { TimeoutAction, TimeoutConfig } from "../config.js";
import { buildAnswerSegment, buildToolResult, DECLINE_MESSAGE } from "./response-envelope.js";
import type { OptionData, QuestionAnswer, QuestionData, QuestionnaireResult, QuestionParams } from "./types.js";

export const DEFAULT_TIMEOUT_MINUTES = 5;
export const MIN_TIMEOUT_MINUTES = 0.25;
export const MAX_TIMEOUT_MINUTES = 240;

/** Marker appended to every auto-selected answer's `notes` so replay consumers can tell automation from human input. */
export function autoNotes(minutes: number): string {
	return `auto-selected after ${formatMinutes(minutes)} timeout (unattended run)`;
}

export interface ResolvedTimeout {
	/** False when the user disabled the feature (`minutes: 0` or negative). */
	enabled: boolean;
	/** Effective timeout in milliseconds (meaningful only when enabled). */
	ms: number;
	/** Effective timeout in minutes, clamped to [0.25, 240]. */
	minutes: number;
	action: TimeoutAction;
}

const ACTIONS: readonly TimeoutAction[] = ["recommended", "first", "decline"];

/**
 * Resolve the `timeout` config block. Missing config keeps the fork default
 * (5 minutes, "recommended"); `minutes: 0` (or any non-positive value) disables
 * auto-advance entirely and restores upstream blocking behavior. Unknown actions
 * and out-of-range minutes fall back to their defaults rather than erroring —
 * a bad config value must never take the questionnaire down.
 */
export function resolveTimeoutConfig(config: { timeout?: TimeoutConfig }): ResolvedTimeout {
	const raw = config?.timeout;
	const minutesRaw = typeof raw?.minutes === "number" && Number.isFinite(raw.minutes) ? raw.minutes : DEFAULT_TIMEOUT_MINUTES;
	const action: TimeoutAction = raw && ACTIONS.includes(raw.action as TimeoutAction) ? (raw.action as TimeoutAction) : "recommended";
	if (minutesRaw <= 0) {
		return { enabled: false, ms: 0, minutes: 0, action };
	}
	const minutes = Math.min(MAX_TIMEOUT_MINUTES, Math.max(MIN_TIMEOUT_MINUTES, minutesRaw));
	return { enabled: true, ms: Math.round(minutes * 60_000), minutes, action };
}

/**
 * Pick the option auto-advance would choose for one question.
 * "recommended" honors a "(Recommended)" label suffix (the tool description
 * tells the model to mark its recommendation that way), else the first option.
 * Returns undefined only for a malformed zero-option question, which validation
 * normally rejects before we ever get here.
 */
export function pickAutoOption(question: QuestionData, action: TimeoutAction): OptionData | undefined {
	if (!question.options || question.options.length === 0) return undefined;
	if (action === "first") return question.options[0];
	const recommended = question.options.find((o) => /\(\s*recommended\s*\)/i.test(o.label));
	return recommended ?? question.options[0];
}

/**
 * Build the synthetic QuestionnaireResult a timeout resolves the dialog with.
 * Single-select questions answer with the picked label (`kind: "option"`),
 * multi-select questions commit the picked label as a one-item selection
 * (`kind: "multi"`). Every answer carries the auto-notes marker.
 */
export function buildAutoResult(params: QuestionParams, timeout: ResolvedTimeout): QuestionnaireResult {
	const answers: QuestionAnswer[] = [];
	for (let i = 0; i < params.questions.length; i++) {
		const q = params.questions[i];
		const pick = pickAutoOption(q, timeout.action === "decline" ? "first" : timeout.action);
		if (!pick) continue;
		const notes = autoNotes(timeout.minutes);
		if (q.multiSelect) {
			answers.push({ questionIndex: i, question: q.question, kind: "multi", answer: null, selected: [pick.label], notes });
		} else {
			answers.push({
				questionIndex: i,
				question: q.question,
				kind: "option",
				answer: pick.label,
				...(pick.preview && pick.preview.length > 0 ? { preview: pick.preview } : {}),
				notes,
			});
		}
	}
	return { answers, cancelled: false };
}

/**
 * Build the LLM-facing tool result for a fired timeout. Distinct from a normal
 * response on purpose: the text must never read as if a human answered (or
 * actively declined), because the model should weigh these choices as defaults
 * it may adjust — not as user ground truth. Empty auto-answer sets collapse to
 * the decline wording so the model decides for itself.
 */
export function buildTimeoutResponse(params: QuestionParams, timeout: ResolvedTimeout): ReturnType<typeof buildToolResult> {
	if (timeout.action === "decline") {
		return buildToolResult(timeoutDeclineText(timeout.minutes), { answers: [], cancelled: true });
	}
	const result = buildAutoResult(params, timeout);
	if (result.answers.length === 0) {
		return buildToolResult(timeoutDeclineText(timeout.minutes), { answers: [], cancelled: true });
	}
	const segments = result.answers.map(buildAnswerSegment).join(" ");
	const text =
		`AUTO-ADVANCED: no user input within ${formatMinutes(timeout.minutes)} — this run is unattended, so ` +
		`the answers were auto-selected by the "${timeout.action}" policy: ${segments} ` +
		`Treat them as defaults, proceed with the task, and surface the automatic choices where relevant.`;
	return buildToolResult(text, result);
}

function timeoutDeclineText(minutes: number): string {
	return (
		`AUTO-ADVANCED: no user input within ${formatMinutes(minutes)} — this run is unattended. ` +
		`${DECLINE_MESSAGE}. Decide and proceed on your own.`
	);
}

function formatMinutes(minutes: number): string {
	return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
