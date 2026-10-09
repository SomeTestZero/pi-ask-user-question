/**
 * Standalone replacement for the monorepo-internal `@juicesharp/rpiv-test-utils`
 * (not published to npm). Implements the five helpers this package's tests use:
 * `createMockPi`, `createMockCtx`, `makeTheme`, `makeTui`, `mockStdout`.
 *
 * Semantics inferred from upstream call sites:
 * - `createMockPi()` returns `{ pi, captured }`; `captured.tools` maps registered
 *   tools by name, `captured.events` maps lifecycle handlers registered via
 *   `pi.on`, `captured.eventsEmitted` records event-bus payloads by channel,
 *   `captured.activeTools` tracks `pi.setActiveTools` calls. An `events` override
 *   replaces the bus while recording still happens.
 * - `createMockCtx(overrides)` shallow-merges over defaults (an explicitly passed
 *   `undefined` wins), and `ui` merges the same way.
 */
import { vi } from "vitest";

type AnyFn = (...args: never[]) => unknown;

export interface MockPiCaptured {
	tools: Map<string, Record<string, unknown>>;
	events: Map<string, AnyFn[]>;
	eventsEmitted: Map<string, unknown[]>;
	activeTools: string[];
}

export function createMockPi(overrides?: { events?: { emit?: AnyFn; on?: AnyFn } }) {
	const captured: MockPiCaptured = {
		tools: new Map(),
		events: new Map(),
		eventsEmitted: new Map(),
		activeTools: [],
	};
	const record = (channel: string, payload: unknown) => {
		const list = captured.eventsEmitted.get(channel) ?? [];
		list.push(payload);
		captured.eventsEmitted.set(channel, list);
	};
	const bus = {
		emit: vi.fn((channel: string, payload?: unknown) => {
			record(channel, payload);
			return overrides?.events?.emit?.(channel as never, payload as never);
		}),
		on: overrides?.events?.on ?? vi.fn(() => () => {}),
	};
	const pi = {
		registerTool: vi.fn((tool: Record<string, unknown>) => {
			captured.tools.set(tool.name as string, tool);
			// Mirrors real Pi: a registered tool joins the active set.
			if (!captured.activeTools.includes(tool.name as string)) captured.activeTools.push(tool.name as string);
		}),
		on: vi.fn((event: string, handler: AnyFn) => {
			const list = captured.events.get(event) ?? [];
			list.push(handler);
			captured.events.set(event, list);
			return () => {
				const remaining = (captured.events.get(event) ?? []).filter((h) => h !== handler);
				captured.events.set(event, remaining);
			};
		}),
		getActiveTools: vi.fn(() => [...captured.activeTools]),
		setActiveTools: vi.fn((names: string[]) => {
			captured.activeTools = [...names];
		}),
		events: bus,
	};
	return { pi, captured };
}

export function createMockCtx(overrides?: Record<string, unknown>) {
	const defaults: Record<string, unknown> = {
		hasUI: true,
		mode: "tui",
		cwd: process.cwd(),
		isProjectTrusted: vi.fn(() => true),
		ui: {
			custom: vi.fn(async () => undefined),
			notify: vi.fn(),
			select: vi.fn(async () => undefined),
			input: vi.fn(async () => ""),
			confirm: vi.fn(async () => true),
			onTerminalInput: vi.fn(() => () => {}),
		},
	};
	const ctx = { ...defaults, ...overrides };
	const uiOverride = (overrides?.ui ?? undefined) as Record<string, unknown> | undefined;
	if (uiOverride) ctx.ui = { ...(defaults.ui as Record<string, unknown>), ...uiOverride };
	return ctx;
}

/**
 * Identity theme stub: style helpers echo the text unchanged so tests can assert
 * on plain substrings. Accepts both `(text)` and `(colorName, text)` call shapes.
 */
export function makeTheme() {
	const echo = (a?: string, b?: string) => b ?? a ?? "";
	return {
		fg: echo,
		bg: echo,
		bold: echo,
		dim: echo,
		italic: echo,
		underline: echo,
		selectedText: echo,
		scrollInfo: echo,
		description: echo,
	};
}

export function makeTui() {
	return {
		start: vi.fn(),
		stop: vi.fn(),
		requestRender: vi.fn(),
		terminal: { columns: 80, rows: 24 },
	};
}

/**
 * Spy on `process.stdout.write` and pin `isTTY` (a function is installed as a
 * throwing/value-returning getter — tests use it to simulate a failing TTY
 * lookup); call `.restore()` in `finally`.
 */
export function mockStdout(isTTY: boolean | (() => unknown)) {
	const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	const originalTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	Object.defineProperty(process.stdout, "isTTY", {
		configurable: true,
		get() {
			return typeof isTTY === "function" ? isTTY() : isTTY;
		},
	});
	return {
		stdoutWrite,
		restore() {
			stdoutWrite.mockRestore();
			if (originalTTY) Object.defineProperty(process.stdout, "isTTY", originalTTY);
			else delete (process.stdout as { isTTY?: boolean }).isTTY;
		},
	};
}
