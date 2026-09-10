import { existsSync, readFileSync } from "node:fs";
import { rootDotenvPath, zenSecretsPath } from "./paths.ts";

/**
 * Secrets stay OUT of the environment the model's tools inherit (#89).
 *
 * What happened: `.env` is read-gate-protected as a FILE (`guard.ts`, the secret-basename
 * rule), but bun auto-loads it into `process.env`, in-process pi inherits that, and every
 * `bash` child inherits it from there. A `bash env` printed `TAVILY_API_KEY` into a
 * transcript and a session file. Nothing was wrong with any gate; the secret was not
 * behind one. Redaction would be cosmetic — the model has already seen the value by the
 * time anything could scrub output — so the fix is at the source:
 *
 *   1. `quarantineSecrets` — at startup, before any session or child process exists,
 *      DELETE every secret-shaped variable and every name the secrets files define from
 *      `process.env`. bun's autoload into THIS process is thereby undone; the spawn spread
 *      in `zen.mjs` and the in-process host both start from an environment that carries
 *      none.
 *   2. The secrets file is `.zen/secrets.env`, NOT the root `.env` (`zenSecretsPath`).
 *      Scrubbing the parent is not enough: bun auto-loads `.env*` from the cwd into EVERY
 *      bun process, so a `bun -e` the model runs from the repo root re-reads a root `.env`
 *      itself — verified with `env -i`, the receipt in PR #98. `.zen/` is a path bun never
 *      loads from; a root `.env` that still defines a secret is reported as MISPLACED.
 *   3. `readSecret` — the extensions that need a key (web_search's Tavily and DeepSeek
 *      providers) read the gated file DIRECTLY, at call time. Extension code is trusted;
 *      the read gate is for the model's `read` tool. The file is the one source on both
 *      surfaces — the web host runs pi in-process, the TUI runs it as a child, and a
 *      private in-memory map could never serve the second.
 *
 * ⚠ Provider auth (`ANTHROPIC_API_KEY` and kin) is NOT served from the secrets file. It
 * lives in pi's own `auth.json` (`/login`, pi-multi-account — #7); an env-only provider
 * key would be scrubbed here and pi would say so. The file is for the harness extensions'
 * keys.
 *
 * ⚠ The name shape is the boundary, on purpose: `*_API_KEY`, `*_TOKEN`, `*_SECRET`,
 * `*_PASSWORD`, and their plurals (as whole underscore-delimited words, so `TOKENIZER_PATH`
 * is untouched).
 * A tool that needs a token in a `bash` child must get it another way — `gh` has its
 * keyring — because the environment is exactly the channel this closes.
 */

const SECRET_SHAPED_NAME = /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD)S?(?:$|_)/;

/** Whether an environment variable NAME looks like it carries a secret. Case-sensitive: env names are. */
export function isSecretShapedName(name: string): boolean {
	return SECRET_SHAPED_NAME.test(name);
}

/**
 * The subset of dotenv this harness needs: `NAME=value` and `export NAME=value` lines,
 * `#` comments, blank lines, single- or double-quoted values (quotes stripped, `\n` in
 * double quotes expanded), unquoted values trimmed. No interpolation, no multi-line
 * values — a secrets file is one key per line, and anything fancier is a smell.
 */
export function parseDotenv(text: string): Map<string, string> {
	const values = new Map<string, string>();
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith("#")) continue;
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
		if (match === null) continue;
		const name = match[1] ?? "";
		let value = match[2] ?? "";
		if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
			value = value.slice(1, -1).replace(/\\n/g, "\n");
		} else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
			value = value.slice(1, -1);
		} else {
			// An unquoted value ends at a ` #` comment, like a shell would read it.
			value = value.replace(/\s+#.*$/, "").trim();
		}
		values.set(name, value);
	}
	return values;
}

/** Every name/value in a dotenv-shaped file, or an empty map when there is no file. Read fresh each call. */
export function readDotenvFile(path: string): Map<string, string> {
	if (!existsSync(path)) return new Map();
	return parseDotenv(readFileSync(path, "utf8"));
}

/** One secret by name from `.zen/secrets.env` — the extensions' read path. Per call, so a rotation needs no restart. */
export function readSecret(repoRoot: string, name: string): string | undefined {
	return readDotenvFile(zenSecretsPath(repoRoot)).get(name);
}

/**
 * A value shorter than this is not treated as a secret to scan for. A two-character value in
 * the secrets file (a flag, a placeholder someone left) would otherwise redact half the log.
 */
const SHORTEST_SCANNABLE_SECRET = 8;

/**
 * The secret VALUES this harness knows, for the logger's value pass (#139). Redaction by
 * field name cannot see a token quoted inside a message, a guard's `reason`, or a `trace`
 * payload; this is the set those passes scan for.
 *
 * Two sources, both ours: `.zen/secrets.env` — everything in it is a secret by definition —
 * and the environment's own secret-shaped names, for a process configured before
 * `quarantineSecrets` has run. After quarantine the environment half is empty by design,
 * and the file half is what still matters: it is where the provider key a tool might echo
 * actually lives.
 *
 * ⚠ Known values only, never a shape heuristic. "Looks like a secret" over model output
 * redacts a user's own text on a guess; an exact value redacts exactly what leaked.
 */
export function knownSecretValues(
	repoRoot: string,
	environment: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] {
	const values = new Set<string>();
	for (const value of readDotenvFile(zenSecretsPath(repoRoot)).values()) {
		if (value.length >= SHORTEST_SCANNABLE_SECRET) values.add(value);
	}
	for (const [name, value] of Object.entries(environment)) {
		if (value !== undefined && value.length >= SHORTEST_SCANNABLE_SECRET && isSecretShapedName(name)) values.add(value);
	}
	return [...values];
}

export interface QuarantineReport {
	/** Names deleted from the environment, sorted. Never values — this is what a startup log line prints. */
	readonly removed: readonly string[];
	/** Secret-shaped names the ROOT `.env` defines: bun would autoload them into every bun child. Move them to `.zen/secrets.env`. */
	readonly misplaced: readonly string[];
}

/**
 * Remove from `environment` every secret-shaped name and every name `.zen/secrets.env`
 * defines (whatever its shape — everything in the secrets file is a secret by definition),
 * and report a root `.env` that still holds secret-shaped names.
 *
 * ⚠ The root `.env` is NOT ours, so it is judged by shape only (PR #98 review): a project
 * may keep `PORT` or `PUBLIC_URL` there, and deleting those from the process would break
 * the very config bun loaded them for. Its secret-shaped names are already scrubbed by the
 * shape rule; they are additionally reported as misplaced so the operator moves them.
 *
 * ⚠ Call it before the first session and before the first child process; both inherit the
 * environment as it is at that moment, and nothing removes a variable from a child after
 * the fact. Idempotent: a second call finds nothing to remove.
 */
export function quarantineSecrets(environment: Record<string, string | undefined>, repoRoot: string): QuarantineReport {
	const rootDotenv = readDotenvFile(rootDotenvPath(repoRoot));
	const doomed = new Set<string>(readDotenvFile(zenSecretsPath(repoRoot)).keys());
	for (const variableName of Object.keys(environment)) if (isSecretShapedName(variableName)) doomed.add(variableName);
	const removed: string[] = [];
	for (const doomedName of doomed) {
		if (!(doomedName in environment)) continue;
		delete environment[doomedName];
		removed.push(doomedName);
	}
	const misplaced = [...rootDotenv.keys()].filter((definedName) => isSecretShapedName(definedName)).sort();
	return { removed: removed.sort(), misplaced };
}
