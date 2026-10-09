import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ExternalEditorTui {
	stop(): void;
	start(): void;
	requestRender(force?: boolean): void;
}

/**
 * Quote-aware tokenizer for win32 command lines (fork addition): upstream's
 * `command.split(" ")` mangles executables whose path contains spaces, e.g.
 * `C:\Program Files\nodejs\node.exe`.
 */
function splitCommandLine(command: string): string[] {
	const tokens: string[] = [];
	let cur = "";
	let inQuotes = false;
	for (const ch of command) {
		if (ch === '"') {
			inQuotes = !inQuotes;
			continue;
		}
		if (!inQuotes && (ch === " " || ch === "\t")) {
			if (cur.length > 0) {
				tokens.push(cur);
				cur = "";
			}
			continue;
		}
		cur += ch;
	}
	if (cur.length > 0) tokens.push(cur);
	return tokens;
}

function runEditor(command: string, file: string): Promise<void> {
	let editor: string;
	let args: string[];
	if (process.platform === "win32") {
		// FORK FIX (win32 only): resolve the executable across spaces before
		// spawning — cmd.exe does not progressive-match `C:\Program` to
		// `C:\Program Files\...`, so upstream's space-split plus shell-join ran the
		// wrong command. Bare command names (`code`, `nvim`) stay unmerged so PATH
		// resolution keeps working. The result runs through the shell as one quoted
		// line so .cmd/.bat editors keep working too. POSIX keeps Pi's grammar below.
		const tokens = splitCommandLine(command);
		if (tokens.length === 0) return Promise.reject(new Error("External editor command is empty"));
		editor = tokens[0];
		let i = 1;
		const looksBare = /^[A-Za-z0-9_.-]+$/.test(editor);
		while (!looksBare && !existsSync(editor) && i < tokens.length) {
			editor = `${editor} ${tokens[i]}`;
			i++;
		}
		args = [...tokens.slice(i), file];
		const line = [editor, ...args].map((tok) => (/\s/.test(tok) ? `"${tok}"` : tok)).join(" ");
		return new Promise((resolve, reject) => {
			const child = spawn(line, { stdio: "inherit", shell: true });
			child.once("error", reject);
			child.once("close", (code, signal) => {
				if (code === 0) {
					resolve();
					return;
				}
				const reason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
				reject(new Error(`External editor exited with ${reason}`));
			});
		});
	}
	// Keep the command grammar identical to Pi's built-in external-editor flow. A
	// separate shell or argv parser here would make Ctrl+G behave differently.
	const [first, ...rest] = command.split(" ");
	if (!first) return Promise.reject(new Error("External editor command is empty"));
	editor = first;
	args = [...rest, file];

	return new Promise((resolve, reject) => {
		const child = spawn(editor, args, {
			stdio: "inherit",
			shell: false,
		});
		child.once("error", reject);
		child.once("close", (code, signal) => {
			if (code === 0) {
				resolve();
				return;
			}
			const reason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
			reject(new Error(`External editor exited with ${reason}`));
		});
	});
}

/**
 * Edit a custom answer with Pi's configured external-editor command. The TUI lifecycle
 * and one-trailing-newline normalization intentionally match Pi's main editor flow.
 */
export async function editWithExternalEditor(tui: ExternalEditorTui, command: string, value: string): Promise<string> {
	const tempDir = mkdtempSync(join(tmpdir(), "rpiv-ask-user-question-"));
	const tempFile = join(tempDir, "answer.md");
	let tuiStopped = false;

	try {
		writeFileSync(tempFile, value, "utf8");
		tui.stop();
		tuiStopped = true;
		process.stdout.write(`Launching external editor: ${command}\nPi will resume when the editor exits.\n`);
		await runEditor(command, tempFile);
		return readFileSync(tempFile, "utf8").replace(/\r?\n$/, "");
	} finally {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Temp cleanup is best effort; never leave the TUI stopped because it failed.
		}
		if (tuiStopped) {
			tui.start();
			tui.requestRender(true);
		}
	}
}
