/**
 * Standalone-test stub for the soft-optional peer `@juicesharp/rpiv-i18n`
 * (aliased in vitest.config.ts for the bare specifier and every subpath).
 *
 * The production modules `await import()` it inside try/catch and fall back to
 * English literals when it is absent. Vite's SSR transform can hoist literal
 * dynamic imports out of the try block, so an evaluating stub must not throw —
 * this minimal i18n implementation keeps every call site harmless: `scope()`
 * echoes the fallback unless a string was registered for the active locale,
 * `registerLocalesFromDir()` does nothing, and `__resetState()` mirrors the
 * monorepo SDK's per-test reset hook (called from test/setup.ts).
 */

type ScopeFn = (key: string, fallback: string) => string;
type LocaleTable = Record<string, Record<string, string>>;

const registry = new Map<string, LocaleTable>();
let currentLocale = "en";

export const scope: (namespace: string) => ScopeFn = (namespace) => (key, fallback) =>
	registry.get(namespace)?.[currentLocale]?.[key] ?? fallback;

/** Register localized strings: `{ "<locale>": { "<key>": "<text>" } }` per namespace. */
export function registerStrings(namespace: string, locales: LocaleTable): void {
	const table = registry.get(namespace) ?? {};
	for (const [locale, entries] of Object.entries(locales)) {
		table[locale] = { ...(table[locale] ?? {}), ...entries };
	}
	registry.set(namespace, table);
}

/** Switch the active locale for all `scope()` closures. */
export function applyLocale(locale: string): void {
	currentLocale = locale;
}

/** No-op: standalone tests register nothing at module-init time. */
export function registerLocalesFromDir(): void {
	// no-op
}

/** Mirrors the monorepo SDK's test-only reset hook. */
export function __resetState(): void {
	registry.clear();
	currentLocale = "en";
}
