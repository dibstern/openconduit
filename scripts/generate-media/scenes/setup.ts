// ─── Setup Scene ─────────────────────────────────────────────────────────────
// Generates GENERATE-SETUP.gif — Animated walkthrough of the setup wizard,
// clicking through each step to the "All set" screen.

import {
	waitForFonts,
	waitForIcons,
} from "../../../test/e2e/helpers/visual-helpers.js";
import { setupInfo } from "../fixtures/media-state.js";
import type { SceneDefinition } from "../scene-runner.js";

export const setupScene: SceneDefinition = {
	config: {
		name: "setup",
		outputFile: "GENERATE-SETUP.gif",
		viewport: { width: 393, height: 852 },
		animated: true,
		isMobile: true,
		hasTouch: true,
	},

	async run({ page, previewUrl, phase, assert, hold }) {
		await phase("setup-routes", async () => {
			await page.route("**/api/setup-info", (route) =>
				route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify(setupInfo),
				}),
			);
		});

		await phase("navigate", async () => {
			await page.goto(`${previewUrl}/setup`);
			await page.evaluate(() => {
				localStorage.removeItem("setup-done");
				localStorage.removeItem("setup-pending");
			});
			await page.reload();
			await waitForFonts(page);
			await waitForIcons(page);
		});

		await assert("wizard-loaded", async () => {
			await page
				.getByText("Conduit")
				.first()
				.waitFor({ state: "visible", timeout: 5000 });
		});

		await hold(2000, "first-step");

		await phase("walk-wizard", async () => {
			for (let i = 0; i < 5; i++) {
				// Capture current heading text before clicking
				const heading = page.locator("h2, h3").first();
				const headingText = await heading.textContent().catch(() => null);

				// Try "Skip" / "Finish anyway" first, then "Next" / "Open Conduit"
				const skipBtn = page
					.locator("button")
					.filter({ hasText: /skip|finish anyway/i });
				const nextBtn = page
					.locator("button")
					.filter({ hasText: /next|open conduit/i });

				if ((await skipBtn.count()) > 0) {
					await skipBtn.first().click();
				} else if ((await nextBtn.count()) > 0) {
					await nextBtn.first().click();
				} else {
					break;
				}

				// Wait for step transition (heading text changes)
				try {
					await page.waitForFunction(
						(prevText) => {
							const el = document.querySelector("h2, h3");
							return el && el.textContent !== prevText;
						},
						headingText,
						{ timeout: 5000 },
					);
				} catch {
					// Last step may not change heading — that's fine
				}

				await hold(1800, `step-${i + 1}`);
			}
		});

		await assert("wizard-complete", async () => {
			await page
				.getByText("All set")
				.first()
				.waitFor({ state: "visible", timeout: 5000 });
		});

		await hold(1500, "done-screen");
	},
};
