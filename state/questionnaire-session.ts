import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Editor, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { COLLAPSE_KEY_OFF, formatKeySpecForDisplay } from "../config.js";
import type { QuestionData, QuestionnaireResult, QuestionParams } from "../tool/types.js";
import type { WrappingSelectItem } from "../view/components/wrapping-select.js";
import { COLLAPSED_HINT_TEMPLATE, HINT_PART_CANCEL, KEY_PLACEHOLDER } from "../view/dialog-builder.js";
import type { QuestionnairePropsAdapter } from "../view/props-adapter.js";
import { buildQuestionnaire, type QuestionnaireBuilt } from "./build-questionnaire.js";
import { t } from "./i18n-bridge.js";
import { type QuestionnaireAction, routeKey } from "./key-router.js";
import type { QuestionnaireRuntime, QuestionnaireState } from "./state.js";
import { type ApplyContext, type Effect, reduce } from "./state-reducer.js";

/**
 * Transcript-scroll keybindings forwarded to pi's viewport while the dialog holds input
 * focus. pi's fullscreen TUI defers ALL viewport input to a focused overlay
 * (`shouldDeferViewportInputToOverlay` in `tui-alt-screen.js`) and the questionnaire
 * consumes none of it, so without this pass-through PageUp/PageDown and friends are
 * dead while the dialog is up. Page math mirrors the host's own (`PAGE_SCROLL_OVERLAP`).
 */
const PAGE_SCROLL_OVERLAP = 4;
/** pi's fast-scroll multiplier for Alt+wheel (`ALT_WHEEL_SCROLL_MULTIPLIER` in `tui-alt-screen.js`). */
const ALT_WHEEL_SCROLL_MULTIPLIER = 5;

const VIEWPORT_SCROLL_BINDINGS: ReadonlyArray<{ id: string; lines: (viewportHeight: number) => number }> = [
	{ id: "tui.altScreen.pageUp", lines: (h) => -Math.max(1, h - PAGE_SCROLL_OVERLAP) },
	{ id: "tui.altScreen.pageDown", lines: (h) => Math.max(1, h - PAGE_SCROLL_OVERLAP) },
	{ id: "tui.altScreen.halfPageUp", lines: (h) => -Math.max(1, Math.floor(h / 2)) },
	{ id: "tui.altScreen.halfPageDown", lines: (h) => Math.max(1, Math.floor(h / 2)) },
	{ id: "tui.altScreen.lineUp", lines: () => -1 },
	{ id: "tui.altScreen.lineDown", lines: () => 1 },
];

/**
 * The slice of the host TUI the pass-through scrolls. Every member is optional:
 * regular-mode hosts have no transcript viewport, and pi-tui may change internals.
 */
interface HostViewport {
	scrollBy?: (lines: number) => void;
	scrollToTop?: () => void;
	scrollToBottom?: () => void;
	requestRender?: (force?: boolean) => void;
	getPrimaryScrollView?: () => { viewportHeight?: number };
	terminal?: { rows?: number };
	/** pi-tui's `WheelScrollAccelerator` — reuse it so wheel speed matches scrolling outside the dialog. */
	wheelScroll?: { next?: (direction: number, now: number) => number };
}

export interface QuestionnaireSessionConfig {
	tui: TUI;
	theme: Theme;
	params: QuestionParams;
	itemsByTab: WrappingSelectItem[][];
	done: (result: QuestionnaireResult) => void;
	keybindings: QuestionnaireRuntime["keybindings"];
	/** Opens Pi's configured external editor. Resolve `undefined` on a reported launch failure. */
	editInput: (value: string) => Promise<string | undefined>;
	/** Key spec for the collapse/expand shortcut, e.g. `"ctrl+]"` or `"alt+o"`. */
	collapseKey: string;
	/**
	 * True iff `execute()` registered the raw `ctx.ui.onTerminalInput` listener — the only
	 * path that can reach a hidden overlay. Gates the `set_overlay_hidden` effect: a host
	 * that delivers an `OverlayHandle` but no raw terminal input must fall back to the
	 * visible one-line collapsed row (which keeps focus and input routing), or collapsing
	 * would hide the overlay into a state nothing can reopen.
	 */
	canReopenWhileHidden: boolean;
}

export interface QuestionnaireSessionComponent {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
}

function initialState(): QuestionnaireState {
	return {
		currentTab: 0,
		optionIndex: 0,
		inputMode: false,
		notesVisible: false,
		answers: new Map(),
		multiSelectChecked: new Set(),
		customDraftsByTab: new Map(),
		notesByTab: new Map(),
		submitChoiceIndex: 0,
		notesDraft: "",
		collapsed: false,
	};
}

/**
 * Slim runtime: owns the canonical state cell, the headless editor cells, the
 * notes-draft mirror, and the effect runner. State
 * transitions go through the pure `reduce` reducer; UI fan-out goes through
 * the `QuestionnairePropsAdapter` produced by `buildQuestionnaire`.
 */
export class QuestionnaireSession {
	private state: QuestionnaireState = initialState();

	private readonly questions: readonly QuestionData[];
	private readonly isMulti: boolean;
	private readonly itemsByTab: WrappingSelectItem[][];

	private readonly notesInput: Editor;
	private readonly inlineInput: Editor;
	private readonly viewAdapter: QuestionnairePropsAdapter;
	private readonly keybindings: QuestionnaireRuntime["keybindings"];
	private readonly editInput: QuestionnaireSessionConfig["editInput"];
	private readonly collapseKey: string;
	private readonly canReopenWhileHidden: boolean;
	private inputEditorOpen = false;

	/**
	 * Overlay handle captured by `ctx.ui.custom`'s `onHandle` callback. Lets the session
	 * call `setHidden(true/false)` so pi-tui's overlay stack reflects the collapsed state
	 * and overlay-aware consumers (e.g. `pi-station`) can resume normal behaviour.
	 */
	private overlayHandle: OverlayHandle | undefined;

	private readonly tui: QuestionnaireSessionConfig["tui"];
	private readonly done: QuestionnaireSessionConfig["done"];
	readonly component: QuestionnaireSessionComponent;

	constructor(config: QuestionnaireSessionConfig) {
		this.tui = config.tui;
		this.done = config.done;
		this.questions = config.params.questions;
		this.isMulti = this.questions.length > 1;
		this.itemsByTab = config.itemsByTab;
		this.keybindings = config.keybindings;
		this.editInput = config.editInput;
		this.collapseKey = config.collapseKey;
		this.canReopenWhileHidden = config.canReopenWhileHidden;

		const built = buildQuestionnaire({
			tui: this.tui,
			theme: config.theme,
			questions: this.questions,
			itemsByTab: this.itemsByTab,
			isMulti: this.isMulti,
			initialState: this.state,
			getCurrentTab: () => this.state.currentTab,
			collapseKey: this.collapseKey,
		});

		this.notesInput = built.notesInput;
		this.inlineInput = built.inlineInput;
		this.viewAdapter = built.adapter;

		this.component = this.assembleComponent(built, config.theme);
		this.viewAdapter.apply(this.state);
	}

	private assembleComponent(built: QuestionnaireBuilt, theme: Theme): QuestionnaireSessionComponent {
		const collapsedRender = this.buildCollapsedRender(theme);
		return {
			render: (width) => (this.state.collapsed ? collapsedRender(width) : built.render(width)),
			invalidate: built.invalidate,
			handleInput: (data) => this.dispatch(data),
		};
	}

	/**
	 * Collapsed render: a single dim row at the bottom of the overlay. pi-tui sizes
	 * the overlay to `min(lines.length, maxHeight)`, so returning one line shrinks
	 * the bottom-anchored overlay from full-height to one row and the transcript
	 * behind it becomes readable (#47). The overlay stays focused and in the
	 * stack, so the collapse key still routes here to expand. `t` stays inside the
	 * closure (live locale updates); the key display is static per session.
	 *
	 * With collapseKey "off" the router and raw listener never toggle `collapsed`,
	 * but `toggleCollapsedExternal()` is a public ungated entry — fall back to the
	 * cancel-only line rather than rendering a literal "Off to expand".
	 */
	private buildCollapsedRender(theme: Theme): (width: number) => string[] {
		const collapseKeyDisplay = formatKeySpecForDisplay(this.collapseKey);
		const collapsedHintLine = (): string =>
			this.collapseKey === COLLAPSE_KEY_OFF
				? t("hint.cancel", HINT_PART_CANCEL)
				: t("hint.expand_line", COLLAPSED_HINT_TEMPLATE).replace(KEY_PLACEHOLDER, collapseKeyDisplay);
		return (_width: number): string[] => [theme.fg("dim", ` ${collapsedHintLine()} `)];
	}

	dispatch(data: string): void {
		if (this.inputEditorOpen) return;
		const action = routeKey(data, this.state, this.runtime());
		if (action.kind === "ignore") {
			// While the inline draft editor owns the keyboard every keystroke belongs to it;
			// otherwise unhandled keys that name a transcript-scroll action pass through to
			// the viewport (see VIEWPORT_SCROLL_BINDINGS).
			if (!this.state.inputMode && this.tryViewportScroll(data)) return;
			this.handleIgnoreInline(data);
			return;
		}
		this.commit(action);
	}

	/**
	 * Viewport pass-through for keys the router ignored. pi drops transcript-scroll keys
	 * while a focused overlay is up and the dialog consumes none of them, so they are
	 * forwarded here instead. Text editors keep every keystroke — a draft or note in
	 * progress must never lose its editing keys to the transcript.
	 */
	private tryViewportScroll(data: string): boolean {
		const kb = this.keybindings;
		if (kb.matches(data, "tui.altScreen.top")) return this.scrollTranscriptTo("top");
		if (kb.matches(data, "tui.altScreen.bottom")) return this.scrollTranscriptTo("bottom");
		for (const binding of VIEWPORT_SCROLL_BINDINGS) {
			if (kb.matches(data, binding.id)) return this.scrollTranscriptBy(binding.lines(this.transcriptViewportHeight()));
		}
		return false;
	}

	/** Scroll the transcript behind the dialog. False when the host has no transcript viewport (regular mode). */
	scrollTranscriptBy(lines: number): boolean {
		const host = this.hostViewport();
		if (!host?.scrollBy) return false;
		host.scrollBy(lines);
		host.requestRender?.();
		return true;
	}

	/** Jump the transcript behind the dialog to its start or end. */
	scrollTranscriptTo(edge: "top" | "bottom"): boolean {
		const host = this.hostViewport();
		const scroll = edge === "top" ? host?.scrollToTop : host?.scrollToBottom;
		if (!scroll) return false;
		scroll.call(host);
		host?.requestRender?.();
		return true;
	}

	/**
	 * Raw-wheel entry point for the `ctx.ui.onTerminalInput` forwarder in `execute()`:
	 * mouse input never reaches `handleInput`, and pi's own wheel path drops events
	 * while a focused overlay is up, so wheel notches route here instead.
	 */
	scrollTranscriptByWheel(direction: -1 | 1, alt: boolean): boolean {
		return this.scrollTranscriptBy(direction * this.wheelLines(direction) * (alt ? ALT_WHEEL_SCROLL_MULTIPLIER : 1));
	}

	/** Host wheel step: reuse pi's accelerator when present (identical feel outside the dialog), else 3 lines per notch. */
	private wheelLines(direction: -1 | 1): number {
		const accelerator = this.hostViewport().wheelScroll;
		const lines = typeof accelerator?.next === "function" ? accelerator.next(direction, performance.now()) : 3;
		return Number.isFinite(lines) && lines > 0 ? Math.floor(lines) : 3;
	}

	private transcriptViewportHeight(): number {
		const host = this.hostViewport();
		const height = host?.getPrimaryScrollView?.().viewportHeight ?? (host?.terminal?.rows ?? 24) - 1;
		return Math.max(1, height);
	}

	private hostViewport(): HostViewport {
		return this.tui as unknown as HostViewport;
	}

	private commit(action: QuestionnaireAction): void {
		const result = reduce(this.state, action, this.applyContext());
		this.state = result.state;
		for (const effect of result.effects) this.runEffect(effect);
		this.state = this.mirrorNotesDraft(this.state);
		this.viewAdapter.apply(this.state);
	}

	private mirrorNotesDraft(s: QuestionnaireState): QuestionnaireState {
		// Drafts restore through Editor.setText, which clears the backing paste map —
		// read expanded so stored drafts never orphan a paste marker.
		const draft = this.notesInput.getExpandedText?.() ?? this.notesInput.getText();
		return s.notesDraft === draft ? s : { ...s, notesDraft: draft };
	}

	private runEffect(effect: Effect): void {
		switch (effect.kind) {
			case "set_input_buffer":
				this.inlineInput.setText(effect.value);
				return;
			case "clear_input_buffer":
				this.inlineInput.setText("");
				return;
			case "open_input_editor":
				this.openInputEditorAsync(effect.value);
				return;
			case "set_notes_value":
				this.notesInput.setText(effect.value);
				return;
			case "set_notes_focused":
				this.notesInput.focused = effect.focused;
				return;
			case "forward_notes_keystroke":
				this.notesInput.handleInput(effect.data);
				return;
			case "set_overlay_hidden":
				// No-op until `setOverlayHandle` has been called (the handle arrives via
				// `ctx.ui.custom`'s `onHandle` right after the overlay is shown), and
				// suppressed entirely when no raw terminal listener exists — hiding would
				// then be irreversible (pi-tui routes no input to a hidden overlay), so the
				// visible one-line collapsed row serves as the fallback rendering instead.
				if (this.canReopenWhileHidden) this.overlayHandle?.setHidden(effect.hidden);
				return;
			case "done":
				this.done(effect.result);
				return;
		}
	}

	/** Opens Pi's configured external editor; on success commits the replacement buffer, on reported failure retains the draft. */
	private openInputEditorAsync(value: string): void {
		if (this.inputEditorOpen) return;
		this.inputEditorOpen = true;
		void this.editInput(value).then(
			(edited) => {
				this.inputEditorOpen = false;
				if (edited !== undefined) this.commit({ kind: "input_replace", value: edited });
			},
			() => {
				// The host callback reports launch errors; retain the draft and restore input handling.
				this.inputEditorOpen = false;
			},
		);
	}

	/**
	 * Per-keystroke `ignore` fast path: delegates text editing to Pi's headless
	 * multiline `Editor`, including paste, undo, cursor movement, and configured
	 * `tui.input.newLine` handling. `viewAdapter.apply` then projects its public
	 * text/cursor state without a reducer round-trip.
	 */
	private handleIgnoreInline(data: string): void {
		if (!this.state.inputMode) return;
		this.inlineInput.handleInput(data);
		this.viewAdapter.apply(this.state);
	}

	private runtime(): QuestionnaireRuntime {
		const cursor = this.inlineInput.getCursor();
		const lastLine = this.inlineInput.getLines().length - 1;
		return {
			keybindings: this.keybindings,
			inputBuffer: this.inlineInput.getExpandedText?.() ?? this.inlineInput.getText(),
			canMoveInputUp: cursor.line > 0,
			canMoveInputDown: cursor.line < lastLine,
			questions: this.questions,
			isMulti: this.isMulti,
			currentItem: this.currentItem(),
			items: this.itemsByTab[this.state.currentTab] ?? [],
			collapseKey: this.collapseKey,
		};
	}

	private applyContext(): ApplyContext {
		return {
			questions: this.questions,
			itemsByTab: this.itemsByTab,
		};
	}

	private currentItem(): WrappingSelectItem | undefined {
		const arr = this.itemsByTab[this.state.currentTab] ?? [];
		return this.state.optionIndex < arr.length ? arr[this.state.optionIndex] : undefined;
	}

	/**
	 * Setter for the overlay handle, called by `ctx.ui.custom`'s `onHandle` callback once
	 * the TUI has created the overlay. Until this is called, `set_overlay_hidden` effects
	 * are no-ops — the session still tracks `state.collapsed` for the view layer.
	 */
	setOverlayHandle(handle: OverlayHandle): void {
		this.overlayHandle = handle;
	}

	/**
	 * Public toggle used by the raw terminal input listener registered in `execute()`.
	 * pi-tui does not route input to a hidden overlay's `component.handleInput`, so the
	 * raw listener (which fires for terminal data regardless of overlay visibility)
	 * reaches the session through this method instead of the dispatch path. Routed
	 * through `commit` so the transition stays in the reducer and the overlay hide
	 * happens via the `set_overlay_hidden` effect like every other side effect.
	 */
	toggleCollapsedExternal(): void {
		if (!this.inputEditorOpen) this.commit({ kind: "toggle_collapsed" });
	}
}
