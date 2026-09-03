import { Type, type Static } from "typebox";

/**
 * The Tier 0 guard policy.
 *
 * ⚠ The regex constants at the bottom are not schemas, and they live here anyway. Splitting
 * the policy — schema in `@zen/core`, patterns beside the extension — would put half of one
 * decision in each of two packages, which is the duplication this package exists to prevent.
 * The policy is one thing; it is declared in one place.
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
