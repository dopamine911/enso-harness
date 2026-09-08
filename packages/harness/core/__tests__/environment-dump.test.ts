import { expect, test } from "bun:test";
import { findEnvironmentDump } from "../environment-dump.ts";

/**
 * #89's depth layer: the bash environment-dump deny. The quarantine is the fix; this
 * exists so a regression there is refused with a reason instead of printing a key. Each
 * case names the via so the block reason is explainable.
 */

const denied = (command: string): string | undefined => findEnvironmentDump(command)?.via;

// ── listings at command position ─────────────────────────────────────────────

test("a bare env, printenv, set, export -p, declare -p is a listing", () => {
	expect(denied("env")).toBe("command-position");
	expect(denied("printenv")).toBe("command-position");
	expect(denied("set")).toBe("command-position");
	expect(denied("export")).toBe("command-position");
	expect(denied("export -p")).toBe("command-position");
	expect(denied("declare -p")).toBe("command-position");
	expect(denied("typeset -x")).toBe("command-position");
	expect(denied("/usr/bin/env")).toBe("command-position");
	expect(denied('"env"')).toBe("command-position");
	expect(denied("ENV")).toBe("command-position");
	expect(denied("env | sort")).toBe("command-position");
	expect(denied("ls && env")).toBe("command-position");
});

// ⚠ THE FALSE POSITIVES THAT MUST NOT HAPPEN: `env` as a wrapper, `set -e`, `export X=1`
// are everyday shell that RUNS or SETS; denying them would make the tool unusable.
test("env as a wrapper, set with options, export/declare with an assignment all pass", () => {
	expect(denied("env FOO=1 bun test")).toBeUndefined();
	expect(denied("env -i sh -c 'echo hi'")).toBeUndefined();
	expect(denied("set -e")).toBeUndefined();
	expect(denied("set -o pipefail")).toBeUndefined();
	expect(denied("export FOO=1")).toBeUndefined();
	expect(denied("declare -a items")).toBeUndefined();
	expect(denied("printenv PATH")).toBeUndefined();
	expect(denied("printenv HOME PATH")).toBeUndefined();
	expect(denied("echo env is a word")).toBeUndefined();
	expect(denied("grep -r environ src/")).toBeUndefined();
	expect(denied("cat .envrc.example")).toBeUndefined();
});

test("printenv of a secret-shaped name is a listing of exactly the thing the deny is for", () => {
	expect(findEnvironmentDump("printenv TAVILY_API_KEY")).toEqual({
		matched: "TAVILY_API_KEY",
		via: "secret-expansion",
	});
	expect(denied("printenv GH_TOKEN PATH")).toBe("secret-expansion");
});

test("a listing past a transparent wrapper is caught", () => {
	expect(denied("timeout 5 env")).toBe("wrapped-command");
	expect(denied("sudo printenv")).toBe("wrapped-command");
	expect(denied("nice -n 5 env | head")).toBe("wrapped-command");
	// The wrapper's OWN listing form: `env` wrapping nothing is the bare env above.
	expect(denied("timeout 5 env FOO=1 make")).toBeUndefined();
});

// ── the raw scans, parseable or not ──────────────────────────────────────────

test("/proc/<pid>/environ is the kernel's copy of the same list", () => {
	expect(denied("cat /proc/self/environ")).toBe("proc-environ");
	expect(denied("tr '\\0' '\\n' < /proc/1234/environ")).toBe("proc-environ");
	expect(denied("strings /proc/$$/environ")).toBe("proc-environ");
});

test("expanding a secret-shaped variable is denied; a non-secret one is not", () => {
	expect(findEnvironmentDump("echo $TAVILY_API_KEY")).toEqual({ matched: "$TAVILY_API_KEY", via: "secret-expansion" });
	expect(denied('echo "${GH_TOKEN}"')).toBe("secret-expansion");
	expect(denied('curl -H "Authorization: Bearer ${CLIENT_SECRET}" x')).toBe("secret-expansion");
	expect(denied("echo $HOME $PATH")).toBeUndefined();
	expect(denied("echo ${TOKENIZER_PATH}")).toBeUndefined();
});

test("an unparseable command takes the coarse scan; a parseable one does not", () => {
	// Command substitution: the segmenter returns [], so a bare word is enough.
	expect(denied("echo $(env)")).toBe("raw-scan");
	expect(denied("x=`printenv`")).toBe("raw-scan");
	// Parseable and innocent: the same words as arguments pass.
	expect(denied("echo printenv")).toBeUndefined();
});

test("the PowerShell path: $env:<secret> and the Env: drive listing, coarse", () => {
	const coarse = (command: string): string | undefined => findEnvironmentDump(command, { coarse: true })?.via;
	expect(coarse("Write-Output $env:TAVILY_API_KEY")).toBe("powershell");
	expect(coarse("Get-ChildItem Env:")).toBe("powershell");
	expect(coarse("gci env: | Sort-Object Name")).toBe("powershell");
	expect(coarse("Write-Output $env:PATH")).toBeUndefined();
});
