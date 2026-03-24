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
			let stepNum = 0;
			for (let i = 0; i < 8; i++) {
				// Check if we've reached the done screen
				const doneVisible = await page
					.getByText("All set")
					.first()
					.isVisible()
					.catch(() => false);
				if (doneVisible) break;

				// Priority: skip/finish > next > enable (push — fails in headless,
				// but surfaces "Finish anyway" after failure)
				const skipBtn = page
					.locator("button")
					.filter({ hasText: /skip|finish anyway/i });
				const nextBtn = page.locator("button").filter({ hasText: /^next$/i });
				const enableBtn = page
					.locator("button")
					.filter({ hasText: /enable push/i });

				if ((await skipBtn.count()) > 0) {
					await skipBtn.first().click();
				} else if ((await nextBtn.count()) > 0) {
					await nextBtn.first().click();
				} else if ((await enableBtn.count()) > 0) {
					// Click Enable — it fails in headless, surfacing "Finish anyway"
					await enableBtn.first().click();
					await page.waitForTimeout(2000);
					// Don't count as a visible step — loop again to find "Finish anyway"
					continue;
				} else {
					break;
				}

				stepNum++;
				await page.waitForTimeout(500); // Let transition settle
				await hold(1800, `step-${stepNum}`);
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
