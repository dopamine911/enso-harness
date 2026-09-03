import { Type, type Static } from "typebox";

/**
 * Guard policy. TypeBox because it is the one schema language in this package:
 * pi's `registerTool` requires `TSchema`, and a TypeBox schema *is* a JSON Schema
 * object, which is the wire format when the web surface arrives.
 */
export const GuardPolicy = Type.Object({
	/** Absolute roots a mutating tool may write inside. Empty means "the session cwd only". */
	writeRoots: Type.Array(Type.String(), { default: [] }),
	/** Path fragments that deny a READ. Matched case-insensitively against the resolved path. */
	secretPathFragments: Type.Array(Type.String()),
	/** Path fragments that deny a WRITE, in addition to escaping `writeRoots`. */
	protectedWriteFragments: Type.Array(Type.String()),
	/** Seconds injected into a `bash` call that arrives without a timeout. */
	defaultBashTimeoutSeconds: Type.Number({ minimum: 1 }),
});

export type GuardPolicy = Static<typeof GuardPolicy>;

/**
 * Defaults. Deliberately conservative on reads of credential material and on
 * writes outside the workspace — the two cases from `docs/concepts/pi-immediate-needs.md`
 * Tier 0 where pi ships no confinement at all.
 */
export const DEFAULT_GUARD_POLICY: GuardPolicy = {
	writeRoots: [],
	secretPathFragments: [
		"/.ssh/",
		"/.aws/",
		"/.gnupg/",
		"/.docker/config.json",
		"/.npmrc",
		"/.netrc",
		"/.pgpass",
		"/.kube/config",
	],
	protectedWriteFragments: ["/.git/"],
	defaultBashTimeoutSeconds: 120,
};

/** Basenames that deny a read outright, regardless of directory. */
export const SECRET_BASENAME_PATTERNS: readonly RegExp[] = [
	/^\.env(\..+)?$/i,
	/^secrets?\.(json|ya?ml|toml|ini)$/i,
	/^credentials?(\.(json|ya?ml|toml|ini))?$/i,
	/^id_(rsa|dsa|ecdsa|ed25519)$/i,
	/\.pem$/i,
	/\.p12$/i,
	/\.pfx$/i,
];
