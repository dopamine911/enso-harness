import { join } from "node:path";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { WebFetchConfig } from "./web-fetch.ts";

/**
 * zen-harness's ONE committed config file (#59): `zen.config.json` at the repository
 * root. Daniel's scope, 2026-09-04: "just a config file for zen-harness only, separate
 * from pi" — nothing here rides pi's settings or agent-dir surfaces.
 *
 * ⚠ THE CONFIG BELONGS TO THE ZEN-HARNESS INSTALL, NOT THE SESSION. It is located from
 * the harness's own file tree (`findRepoRoot` on a module inside this repo), NEVER from
 * the session cwd — zen can run against a foreign checkout (`bun run dev /some/path`),
 * and a foreign repo's `zen.config.json` must not become this session's allowlist.
 *
 * ⚠ STRICT ON UNKNOWN KEYS, deliberately. This is a policy file: a typo
 * (`"allowedHost"`) must refuse loudly, not silently configure nothing. The cost is
 * forward-incompatibility — an older harness reading a newer config refuses everything —
 * and for a security file that direction of failure is the wanted one.
 *
 * The loading contract every consumer follows: parse fails CLOSED (`unreadable` is never
 * "no policy"), and policy-bearing sections are read ONCE per session at extension load,
 * so an in-session edit is inert until a restart has put the diff in front of a human.
 */

/** The committed config file's basename. Lives at the repository root. */
export const ZEN_CONFIG_FILENAME = "zen.config.json";

/** The example a refusal message shows a human who needs to change the config. */
export const ZEN_CONFIG_EXAMPLE = `{ "webFetch": { "allowedHosts": ["docs.example.com"] } }`;

/** The whole config file. One section per consumer; every section's schema lives with its owner. */
export const ZenConfig = Type.Object(
	{
		webFetch: WebFetchConfig,
	},
	{ additionalProperties: false },
);
export type ZenConfig = Static<typeof ZenConfig>;

const zenConfigValidator = Compile(ZenConfig);

export type ZenConfigParseResult = { kind: "ok"; config: ZenConfig } | { kind: "unreadable"; reason: string };

/**
 * Parse the config file's text. Any failure comes back as `unreadable`, and the caller
 * must fail CLOSED on it — "could not read the policy" must never render as "no policy".
 */
export function parseZenConfig(fileText: string): ZenConfigParseResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fileText);
	} catch (error) {
		return { kind: "unreadable", reason: `${ZEN_CONFIG_FILENAME} is not valid JSON (${String(error)})` };
	}
	if (!zenConfigValidator.Check(parsed)) {
		return {
			kind: "unreadable",
			reason:
				`${ZEN_CONFIG_FILENAME} does not match the expected shape ${ZEN_CONFIG_EXAMPLE} ` +
				`(unknown keys are refused — a typo must fail loudly, not configure nothing)`,
		};
	}
	return { kind: "ok", config: parsed };
}

/** The config file's path under a repository root (see `findRepoRoot` in paths.ts). */
export function zenConfigPath(repoRoot: string): string {
	return join(repoRoot, ZEN_CONFIG_FILENAME);
}
