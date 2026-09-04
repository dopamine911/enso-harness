import type { WebSource } from "./vocabulary.ts";

/**
 * Source hygiene for provider results (#63): URL normalization, junk filtering, and
 * order-preserving dedupe. Providers surface raw URLs from wire payloads; this module is
 * what keeps the rendered `Sources` list clean and stable.
 *
 * Adapted from pi-web-search 1.4.0 (github.com/ttttmr/pi-web-search), © ttttmr, MIT
 * (declared in its package.json; the repo ships no LICENSE file).
 */

/**
 * Append a source unless an identical (url, title) pair is already present. Returns the
 * source's index either way — the citation appliers use it as the `[n]` marker number.
 */
export function pushUniqueSource(sources: WebSource[], candidate: { title?: string | undefined; url: string }): number {
	const title = candidate.title !== undefined && candidate.title.length > 0 ? candidate.title : "Unknown";
	const existingIndex = sources.findIndex((source) => source.url === candidate.url && source.title === title);
	if (existingIndex >= 0) return existingIndex;
	sources.push({ title, url: candidate.url });
	return sources.length - 1;
}

/** Tracking params stripped from result URLs (never from YouTube, whose params are content). */
const REMOVABLE_QUERY_PARAMS = ["ref", "referral_type", "openLinerExtension", "_clear", "lang", "api-mode"];

/** Strip fragments and tracking params so the same page dedupes to one source. */
export function normalizeSearchUrl(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.hash = "";
		const isYouTube = /(^|\.)youtube\.com$/i.test(parsed.hostname) || /(^|\.)youtu\.be$/i.test(parsed.hostname);
		if (!isYouTube) {
			for (const paramName of REMOVABLE_QUERY_PARAMS) parsed.searchParams.delete(paramName);
			for (const paramName of [...parsed.searchParams.keys()]) {
				if (paramName.toLowerCase().startsWith("utm_")) parsed.searchParams.delete(paramName);
			}
		}
		const query = parsed.searchParams.toString();
		parsed.search = query.length > 0 ? `?${query}` : "";
		return parsed.toString();
	} catch {
		return url;
	}
}

/** A display title for a bare URL: its last path segment, else its hostname. */
export function titleFromUrl(url: string): string {
	try {
		const parsed = new URL(url);
		const lastSegment = parsed.pathname
			.split("/")
			.filter((segment) => segment.length > 0)
			.pop();
		if (lastSegment !== undefined && lastSegment.length > 0) return lastSegment;
		return parsed.hostname.length > 0 ? parsed.hostname : url;
	} catch {
		return url;
	}
}

/** File types a search result should never point at — crawler debris, not pages. */
const JUNK_URL_SUFFIXES = [
	".gz",
	".zip",
	".tgz",
	".tar",
	".woff",
	".woff2",
	".ttf",
	".otf",
	".eot",
	".webm",
	".mp4",
	".mp3",
	".wav",
	".eps",
	".sql",
	".csv",
	".xls",
	".xlsx",
	".ppt",
	".pptx",
];

/** True for URLs that are noise in a source list (binary assets, template residue). */
export function isLikelyJunkSearchUrl(url: string | undefined): boolean {
	if (url === undefined || url.length === 0) return true;
	try {
		const parsed = new URL(url);
		const decodedPath = decodeURIComponent(parsed.pathname).toLowerCase();
		if (JUNK_URL_SUFFIXES.some((suffix) => decodedPath.endsWith(suffix))) return true;
		if (decodedPath === "/%" || decodedPath.endsWith("/%")) return true;
		return false;
	} catch {
		return false;
	}
}

/** Normalize, junk-filter, and dedupe a source list; order preserved. */
export function cleanSources(candidates: ReadonlyArray<{ title?: string | undefined; url: string }>): WebSource[] {
	const cleaned: WebSource[] = [];
	for (const candidate of candidates) {
		const normalizedUrl = normalizeSearchUrl(candidate.url);
		if (isLikelyJunkSearchUrl(normalizedUrl)) continue;
		const title =
			candidate.title !== undefined && candidate.title.length > 0 ? candidate.title : titleFromUrl(normalizedUrl);
		pushUniqueSource(cleaned, { title, url: normalizedUrl });
	}
	return cleaned;
}
