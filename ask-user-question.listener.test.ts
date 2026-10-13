import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAskUserQuestionTool } from "./ask-user-question.js";
import type { AskUserQuestionConfig } from "./config.js";

/**
 * Integration tests for the raw `ctx.ui.onTerminalInput` collapse listener.
 * The factory tests drive the component `handleInput` path (the fallback when
 * no raw listener is available); these drive the listener path that pi-tui
 * needs while the overlay is hidden, using the real QuestionnaireSession via
 * the `ctx.ui.custom` factory and a fake OverlayHandle.
 */

const identityTheme = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => s,
	strikethrough: (s: string) => s,
};

const CTRL_RBRACKET = "\x1d"; // GS byte — what legacy terminals send for Ctrl+]
const KITTY_CTRL_RBRACKET_PRESS = "\x1b[93;5u";
const KITTY_CTRL_RBRACKET_REPEAT = "\x1b[93;5:2u";
const KITTY_CTRL_RBRACKET_RELEASE = "\x1b[93;5:3u";
const ALT_O = "\x1bo"; // ESC-prefixed 'o' — legacy encoding for Alt+O

const params = {
	questions: [
		{
			question: "Pick one",
			header: "Choice",
			options: [{ label: "Alpha" }, { label: "Beta" }],
		},
	],
};

interface FakeHandle {
	hide(): void;
	setHidden(hidden: boolean): void;
	isHidden(): boolean;
	focus(): void;
	unfocus(): void;
	isFocused(): boolean;
}

function makeHandle(over: { isFocused?: () => boolean } = {}): FakeHandle {
	let hidden = false;
	return {
		hide: () => {},
		focus: () => {},
		unfocus: () => {},
		setHidden: (h: boolean) => {
			hidden = h;
		},
		isHidden: () => hidden,
		// Mirrors pi-tui: a visible questionnaire overlay normally has focus;
		// a hidden one never does. Overridable for the other-overlay-on-top case.
		isFocused: over.isFocused ?? (() => !hidden),
	};
}

type RawListener = (data: string) => { consume?: boolean } | undefined;
type SessionComponent = { render(width: number): string[]; handleInput(data: string): void };

interface FakeTui {
	requestRender: ReturnType<typeof vi.fn>;
	terminal: { columns: number; rows: number };
	scrollBy: ReturnType<typeof vi.fn>;
	scrollToTop: ReturnType<typeof vi.fn>;
	scrollToBottom: ReturnType<typeof vi.fn>;
	wheelScroll: { next: ReturnType<typeof vi.fn> };
}

function makeFakeTui(): FakeTui {
	return {
		requestRender: vi.fn(),
		terminal: { columns: 120, rows: 24 },
		scrollBy: vi.fn(),
		scrollToTop: vi.fn(),
		scrollToBottom: vi.fn(),
		// pi-tui's WheelScrollAccelerator seam — 1 line per notch keeps assertions exact.
		wheelScroll: { next: vi.fn(() => 1) },
	};
}

function register() {
	const { pi, captured } = createMockPi();
	registerAskUserQuestionTool(pi);
	return captured.tools.get("ask_user_question")!;
}

/**
 * Fake `ctx.ui` that mimics interactive-mode wiring: `onTerminalInput` captures
 * the raw listener, `custom` runs the real factory then hands out the overlay
 * handle via `onHandle`, and `script` drives the interaction before resolving.
 */
function driveWithListener(handle: FakeHandle, script: (done: (v: unknown) => void) => void) {
	const notify = vi.fn();
	const removeListener = vi.fn();
	// `current` keeps the legacy collapse-listener semantics (the collapse listener is
	// registered last); `listeners` exposes every registration in order — the wheel
	// forwarder is registered first.
	const listenerRef: { current: RawListener | undefined } = { current: undefined };
	const listeners: RawListener[] = [];
	const componentRef: { current: SessionComponent | undefined } = { current: undefined };
	const tui: FakeTui = makeFakeTui();
	const onTerminalInput = vi.fn((h: RawListener) => {
		listenerRef.current = h;
		listeners.push(h);
		return removeListener;
	});
	const custom = vi.fn(
		(
			factory: (tui: FakeTui, theme: typeof identityTheme, kb: undefined, done: (v: unknown) => void) => unknown,
			options?: { onHandle?: (handle: FakeHandle) => void },
		) => {
			return new Promise((resolve) => {
				componentRef.current = factory(tui, identityTheme, undefined, resolve) as SessionComponent;
				options?.onHandle?.(handle);
				script(resolve);
			});
		},
	);
	const ctx = { hasUI: true, ui: { custom, onTerminalInput, notify } } as never;
	return { ctx, notify, onTerminalInput, removeListener, listenerRef, listeners, tui, componentRef };
}

const home = process.env.HOME ?? "";
const configDir = join(home, ".config", "rpiv-ask-user-question");
const configPath = join(configDir, "config.json");

function writeCollapseKeyConfig(collapseKey: string): void {
	mkdirSync(configDir, { recursive: true });
	writeFileSync(configPath, JSON.stringify({ collapseKey } satisfies AskUserQuestionConfig));
}

afterEach(() => {
	if (existsSync(configPath)) rmSync(configPath);
});

describe("ask_user_question — raw terminal collapse listener", () => {
	it("hides via OverlayHandle.setHidden, notifies once, and unhides on the second press", async () => {
		const tool = register();
		const handle = makeHandle();
		const { ctx, notify, removeListener, listenerRef } = driveWithListener(handle, (done) => {
			// First press: hide + one-shot notification with the reopen key.
			expect(listenerRef.current?.(CTRL_RBRACKET)).toEqual({ consume: true });
			expect(handle.isHidden()).toBe(true);
			expect(notify).toHaveBeenCalledTimes(1);
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("press Ctrl+] to reopen"), "info");
			// Second press: unhide, and the notification stays one-shot.
			expect(listenerRef.current?.(CTRL_RBRACKET)).toEqual({ consume: true });
			expect(handle.isHidden()).toBe(false);
			// Third round-trip re-hides without a second announcement.
			expect(listenerRef.current?.(CTRL_RBRACKET)).toEqual({ consume: true });
			expect(handle.isHidden()).toBe(true);
			expect(notify).toHaveBeenCalledTimes(1);
			done({ answers: [], cancelled: true });
		});
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
		// execute's finally must tear every raw listener down once the tool resolves —
		// both the wheel forwarder and the collapse listener.
		expect(removeListener).toHaveBeenCalledTimes(2);
	});

	it("toggles once for Kitty keyboard press, repeat, and release events", async () => {
		const tool = register();
		const handle = makeHandle();
		const { ctx, listenerRef } = driveWithListener(handle, (done) => {
			expect(listenerRef.current?.(KITTY_CTRL_RBRACKET_PRESS)).toEqual({ consume: true });
			expect(handle.isHidden()).toBe(true);

			// Repeat and release still belong to the collapse binding, so consume them
			// without toggling or leaking them into the newly focused chat editor.
			expect(listenerRef.current?.(KITTY_CTRL_RBRACKET_REPEAT)).toEqual({ consume: true });
			expect(handle.isHidden()).toBe(true);
			expect(listenerRef.current?.(KITTY_CTRL_RBRACKET_RELEASE)).toEqual({ consume: true });
			expect(handle.isHidden()).toBe(true);

			expect(listenerRef.current?.(KITTY_CTRL_RBRACKET_PRESS)).toEqual({ consume: true });
			expect(handle.isHidden()).toBe(false);
			done({ answers: [], cancelled: true });
		});
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
	});

	it("ignores non-matching keys", async () => {
		const tool = register();
		const handle = makeHandle();
		const { ctx, notify, listenerRef } = driveWithListener(handle, (done) => {
			expect(listenerRef.current?.("x")).toBeUndefined();
			expect(listenerRef.current?.(ALT_O)).toBeUndefined();
			expect(handle.isHidden()).toBe(false);
			expect(notify).not.toHaveBeenCalled();
			done({ answers: [], cancelled: true });
		});
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
	});

	it("leaves the key to another focused overlay (visible but unfocused questionnaire)", async () => {
		const tool = register();
		// e.g. `/btw` opened on top: the questionnaire is visible underneath but
		// not focused — the listener must not toggle it from under the top overlay.
		const handle = makeHandle({ isFocused: () => false });
		const { ctx, listenerRef } = driveWithListener(handle, (done) => {
			expect(listenerRef.current?.(CTRL_RBRACKET)).toBeUndefined();
			expect(handle.isHidden()).toBe(false);
			done({ answers: [], cancelled: true });
		});
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
	});

	it("host with an overlay handle but no raw input keeps the overlay visible on collapse (fallback row, no trap)", async () => {
		// A host that delivers onHandle but not onTerminalInput has exactly one input
		// path: the component's handleInput — which pi-tui does not deliver to a hidden
		// overlay. If collapsing hid the overlay here, nothing could ever reopen it, so
		// the session must suppress setHidden and rely on the one-line collapsed row.
		const tool = register();
		const handle = makeHandle();
		const componentRef: { current: SessionComponent | undefined } = { current: undefined };
		const custom = vi.fn(
			(
				factory: (
					tui: { requestRender: () => void; terminal: { columns: number; rows: number } },
					theme: typeof identityTheme,
					kb: undefined,
					done: (v: unknown) => void,
				) => unknown,
				options?: { onHandle?: (handle: FakeHandle) => void },
			) => {
				return new Promise((resolve) => {
					componentRef.current = factory(
						{ requestRender: vi.fn(), terminal: { columns: 120, rows: 24 } },
						identityTheme,
						undefined,
						resolve,
					) as SessionComponent;
					options?.onHandle?.(handle);
					componentRef.current.handleInput(CTRL_RBRACKET);
					expect(handle.isHidden()).toBe(false);
					const collapsed = componentRef.current.render(120);
					expect(collapsed).toHaveLength(1);
					expect(collapsed[0]).toContain("Ctrl+] to expand");
					// The visible row still routes input, so the same key expands it again.
					componentRef.current.handleInput(CTRL_RBRACKET);
					expect(componentRef.current.render(120).length).toBeGreaterThan(1);
					resolve({ answers: [], cancelled: true });
				});
			},
		);
		const ctx = { hasUI: true, ui: { custom } } as never;
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
	});

	it("honours a configured collapseKey (alt+o toggles, ctrl+] does not)", async () => {
		writeCollapseKeyConfig("alt+o");
		const tool = register();
		const handle = makeHandle();
		const { ctx, listenerRef } = driveWithListener(handle, (done) => {
			expect(listenerRef.current?.(CTRL_RBRACKET)).toBeUndefined();
			expect(handle.isHidden()).toBe(false);
			expect(listenerRef.current?.(ALT_O)).toEqual({ consume: true });
			expect(handle.isHidden()).toBe(true);
			done({ answers: [], cancelled: true });
		});
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
	});

	it("footer hint and collapsed row name the configured collapseKey (#176)", async () => {
		writeCollapseKeyConfig("alt+o");
		const tool = register();
		const handle = makeHandle();
		const { ctx, componentRef } = driveWithListener(handle, (done) => {
			const expanded = componentRef.current!.render(120).join("\n");
			expect(expanded).toContain("Alt+O to collapse");
			expect(expanded).not.toContain("Ctrl+]");
			// Collapse via the component input path — the one-line footer must name
			// the same key the router actually honours.
			componentRef.current!.handleInput(ALT_O);
			const collapsed = componentRef.current!.render(120);
			expect(collapsed).toHaveLength(1);
			expect(collapsed[0]).toContain("Alt+O to expand");
			done({ answers: [], cancelled: true });
		});
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
	});

	it("does not register a collapse listener when collapseKey is 'off'", async () => {
		writeCollapseKeyConfig("off");
		const tool = register();
		const handle = makeHandle();
		const { ctx, onTerminalInput, listenerRef, componentRef } = driveWithListener(handle, (done) => {
			// The footer must not advertise a collapse shortcut that cannot fire (#176).
			const rendered = componentRef.current!.render(120).join("\n");
			expect(rendered).not.toContain("to collapse");
			expect(rendered).toContain("Esc to cancel");
			// The one registered listener is the unconditional wheel forwarder; no
			// listener may answer the collapse key.
			expect(listenerRef.current?.(CTRL_RBRACKET)).toBeUndefined();
			done({ answers: [], cancelled: true });
		});
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
		expect(onTerminalInput).toHaveBeenCalledTimes(1);
	});
});

describe("ask_user_question — raw terminal wheel forwarder", () => {
	const WHEEL_UP = "\x1b[<64;10;5M";
	const WHEEL_DOWN = "\x1b[<65;10;5M";
	const WHEEL_DOWN_ALT = "\x1b[<73;10;5M"; // button 65 | Alt (bit 8)
	const MOUSE_PRESS = "\x1b[<0;10;5M";

	it("forwards wheel notches to the transcript while the dialog is focused", async () => {
		const tool = register();
		const handle = makeHandle();
		const { ctx, listeners, tui } = driveWithListener(handle, (done) => {
			expect(listeners).toHaveLength(2); // [wheel forwarder, collapse listener]
			expect(listeners[0]?.(WHEEL_UP)).toEqual({ consume: true });
			expect(tui.scrollBy).toHaveBeenLastCalledWith(-1);
			expect(listeners[0]?.(WHEEL_DOWN)).toEqual({ consume: true });
			expect(tui.scrollBy).toHaveBeenLastCalledWith(1);
			done({ answers: [], cancelled: true });
		});
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
	});

	it("Alt+wheel uses pi's fast-scroll multiplier", async () => {
		const tool = register();
		const handle = makeHandle();
		const { ctx, listeners, tui } = driveWithListener(handle, (done) => {
			expect(listeners[0]?.(WHEEL_DOWN_ALT)).toEqual({ consume: true });
			expect(tui.scrollBy).toHaveBeenLastCalledWith(5);
			done({ answers: [], cancelled: true });
		});
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
	});

	it("declines wheel input while the overlay is hidden (collapsed) — native scrolling owns the wheel then", async () => {
		const tool = register();
		const handle = makeHandle();
		const { ctx, listeners, tui } = driveWithListener(handle, (done) => {
			handle.setHidden(true);
			expect(listeners[0]?.(WHEEL_DOWN)).toBeUndefined();
			expect(tui.scrollBy).not.toHaveBeenCalled();
			done({ answers: [], cancelled: true });
		});
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
	});

	it("declines wheel input when another overlay has focus", async () => {
		const tool = register();
		const handle = makeHandle({ isFocused: () => false });
		const { ctx, listeners, tui } = driveWithListener(handle, (done) => {
			expect(listeners[0]?.(WHEEL_DOWN)).toBeUndefined();
			expect(tui.scrollBy).not.toHaveBeenCalled();
			done({ answers: [], cancelled: true });
		});
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
	});

	it("ignores non-wheel mouse sequences", async () => {
		const tool = register();
		const handle = makeHandle();
		const { ctx, listeners, tui } = driveWithListener(handle, (done) => {
			expect(listeners[0]?.(MOUSE_PRESS)).toBeUndefined();
			expect(tui.scrollBy).not.toHaveBeenCalled();
			done({ answers: [], cancelled: true });
		});
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
	});
});
