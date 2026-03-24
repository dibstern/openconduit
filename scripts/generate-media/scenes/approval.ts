// ─── Approval Scene ──────────────────────────────────────────────────────────
// Generates GENERATE-APPROVAL.png — iPhone showing a permission request card
// for a Bash command that needs user approval.

import {
	freezeAnimations,
	waitForFonts,
	waitForIcons,
} from "../../../test/e2e/helpers/visual-helpers.js";
import { mockRelayWebSocket } from "../../../test/e2e/helpers/ws-mock.js";
import { approvalInit, approvalPermission } from "../fixtures/media-state.js";
import type { SceneDefinition } from "../scene-runner.js";

export const approvalScene: SceneDefinition = {
	config: {
		name: "approval",
		outputFile: "GENERATE-APPROVAL.png",
		viewport: { width: 393, height: 852 },
		isMobile: true,
		hasTouch: true,
		animated: false,
	},

	async run({ page, previewUrl, phase, assert }) {
		let wsMock: Awaited<ReturnType<typeof mockRelayWebSocket>>;

		await phase("setup-ws-mock", async () => {
			wsMock = await mockRelayWebSocket(page, {
				initMessages: approvalInit,
				responses: new Map(),
			});
		});

		await phase("navigate", async () => {
			await page.goto(`${previewUrl}/p/myapp/`);
			await waitForFonts(page);
			await waitForIcons(page);
		});

		await assert("chat-ready", async () => {
			await page
				.locator("textarea")
				.waitFor({ state: "visible", timeout: 5000 });
		});

		await phase("inject-permission", async () => {
			// biome-ignore lint/style/noNonNullAssertion: wsMock is assigned in the prior sequential phase
			wsMock!.sendMessage(approvalPermission);
		});

		await assert("permission-card-visible", async () => {
			await page
				.locator("[data-request-id]")
				.first()
				.waitFor({ state: "visible", timeout: 5000 });
			await page
				.locator("text=Bash")
				.first()
				.waitFor({ state: "visible", timeout: 5000 });
		});

		await phase("freeze-animations", async () => {
			await freezeAnimations(page);
			await page.waitForTimeout(200);
		});
	},
};
