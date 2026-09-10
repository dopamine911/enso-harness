/**
 * Manual web smoke (#71): drive the real chat surface and leave screenshots behind.
 *
 * Two tiers, split by cost:
 *   - default: model-free. `/mode` is an extension command that raises a select dialog and
 *     completes without a model turn, so it exercises composer → server → pi → dialog park
 *     (#27) → answer → quick-close end to end for free.
 *   - `@model`: one real model turn. Costs tokens and needs a working provider identity
 *     (`.zen/pi-agent`); excluded unless you pass `--grep @model` (see README.md).
 *
 * Screenshots are the deliverable — they go to OUTPUT_DIRECTORY/screenshots under fixed
 * names (README.md). Assertions are deliberately few: this is a smoke with receipts, not a
 * regression suite. Regression lives in `bun test`.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { OUTPUT_DIRECTORY } from "./playwright.config.ts";

const SCREENSHOT_DIRECTORY = join(OUTPUT_DIRECTORY, "screenshots");

/** Composer markup from src/chat-screen.tsx — the accessible names ARE the contract. */
const COMPOSER_PLACEHOLDER = "ask pi something";
const SEND_BUTTON_NAME = "send message";
const STOP_BUTTON_NAME = "stop the current response";

/**
 * `/mode` is picc's select dialog; this label is one of its options.
 *
 * ⚠ Side-effect check (2026-09-05, picc-permission-modes in node_modules): the chosen mode
 * is persisted with `pi.appendEntry("modes", …)` into the RUN'S OWN pi session file
 * (`destination: "session"`), never into `settings.json`. Every web run is a fresh session,
 * so answering "Accept edits" here cannot flip the TUI's mode. It does leave one session
 * JSONL per run under `.zen/pi-agent/sessions/`, like any other run.
 */
const MODE_COMMAND = "/mode";
const MODE_OPTION_LABEL = /accept edits/i;
/** The status line picc emits once the mode is switched — the observable that the answer landed. */
const MODE_ANSWERED_STATUS = /Mode: acceptEdits/;

/** A real 1×1 PNG (signature, IHDR, IDAT, IEND) — the smallest file a decoder accepts; what the paste test puts on the clipboard. */
const ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Same prompt the TUI receipt uses — cheap, and the answer shape is checkable by eye. */
const MODEL_PROMPT = "Reply with exactly three words.";

/**
 * A run is "settled" when the composer offers send again. While a run is in flight the
 * same slot shows the stop button, so waiting on send-visible is the completion signal for
 * both a model turn and an extension-command quick-close.
 */
async function waitForRunToSettle(page: Page): Promise<void> {
	await expect(page.getByRole("button", { name: SEND_BUTTON_NAME })).toBeVisible();
}

async function typeAndSend(page: Page, message: string): Promise<void> {
	const composer = page.getByPlaceholder(COMPOSER_PLACEHOLDER);
	await composer.fill(message);
	await composer.press("Enter");
}

/**
 * Full-page PNG under a stable name (README.md lists them), also attached to the test so a
 * trace or HTML report links it. No console echo: biome's `noConsole` applies here and the
 * names are fixed, so a reader knows the path without a log line.
 */
async function captureScreenshot(page: Page, fileName: string): Promise<void> {
	mkdirSync(SCREENSHOT_DIRECTORY, { recursive: true });
	const screenshotPath = join(SCREENSHOT_DIRECTORY, `${fileName}.png`);
	await page.screenshot({ path: screenshotPath, fullPage: true });
	await test.info().attach(fileName, { path: screenshotPath, contentType: "image/png" });
}

test.describe("chat surface", () => {
	test("empty state, /mode dialog, answer, settle (model-free)", async ({ page }) => {
		await page.goto("/");
		await expect(page.getByPlaceholder(COMPOSER_PLACEHOLDER)).toBeVisible();
		await captureScreenshot(page, "01-empty-state");

		await typeAndSend(page, MODE_COMMAND);
		// The dialog parks the run (#27): the composer flips to stop, then the select options
		// render as buttons. Either order is fine; the option button is what we need.
		const modeOption = page.getByRole("button", { name: MODE_OPTION_LABEL });
		await expect(modeOption).toBeVisible();
		await captureScreenshot(page, "02-mode-dialog");

		await modeOption.click();
		await waitForRunToSettle(page);
		// The answer's receipt is picc's `zen.entry` status line, not assistant text — an
		// extension command produces no model turn, so the assistant container stays empty
		// (and Playwright reads an empty block as hidden; receipt: first run of this spec).
		await expect(page.getByText(MODE_ANSWERED_STATUS)).toBeVisible();
		await captureScreenshot(page, "03-mode-answered");
	});

	test("paste an image: thumbnail, send enabled, the bytes on the wire as ZenPromptImage (model-free)", async ({
		page,
	}) => {
		// The prompt route is answered here, not by pi: this pins the browser's half of #68 — paste
		// → attachment → `data:` URL → `images: [{mimeType, data}]` on the POST — without a model turn.
		const posted: Array<{ message: string; images?: Array<{ mimeType: string; data: string }> }> = [];
		await page.route("**/api/threads/*/prompt", async (route) => {
			posted.push(route.request().postDataJSON());
			await route.fulfill({
				status: 202,
				contentType: "application/json",
				body: JSON.stringify({ threadId: "t", messageId: "m1", generation: 1, queued: false }),
			});
		});
		await page.goto("/");
		await expect(page.getByPlaceholder(COMPOSER_PLACEHOLDER)).toBeVisible();
		await expect(page.getByRole("button", { name: SEND_BUTTON_NAME })).toBeDisabled();

		// Ctrl+V with a PNG on the clipboard, as the browser delivers it: a `paste` whose data is a file.
		await page.getByPlaceholder(COMPOSER_PLACEHOLDER).focus();
		await page.evaluate((base64) => {
			const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
			const transfer = new DataTransfer();
			transfer.items.add(new File([bytes], "pixel.png", { type: "image/png" }));
			document
				.querySelector("textarea")
				?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
		}, ONE_PIXEL_PNG);
		const strip = page.getByLabel("attached images");
		await expect(strip.getByRole("img")).toHaveCount(1);
		// An image with no words is a prompt: send is offered on the attachment alone.
		await expect(page.getByRole("button", { name: SEND_BUTTON_NAME })).toBeEnabled();
		await captureScreenshot(page, "06-image-attached");

		await typeAndSend(page, "what does this say?");
		await expect(strip).toHaveCount(0);
		await expect.poll(() => posted.length).toBe(1);
		expect(posted[0]?.message).toBe("what does this say?");
		expect(posted[0]?.images).toEqual([{ mimeType: "image/png", data: ONE_PIXEL_PNG }]);
		// The user's own image is in the transcript, as inline bytes.
		await expect(page.locator('img[alt="attached by the user"]')).toHaveCount(1);
		await captureScreenshot(page, "07-image-sent");
	});

	test("one real model turn @model", async ({ page }) => {
		await page.goto("/");
		await typeAndSend(page, MODEL_PROMPT);
		// The stop affordance proves the request reached the server and a run is in flight.
		await expect(page.getByRole("button", { name: STOP_BUTTON_NAME })).toBeVisible();
		await captureScreenshot(page, "04-model-streaming");

		await waitForRunToSettle(page);
		const assistantMessage = page.locator('[data-role="assistant"]').last();
		await expect(assistantMessage).toBeVisible();
		await expect(assistantMessage).not.toBeEmpty();
		await captureScreenshot(page, "05-model-settled");
	});
});
