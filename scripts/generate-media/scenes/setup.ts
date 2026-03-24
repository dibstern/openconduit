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

			// Mock push notification APIs so "Enable Push" succeeds cleanly
			await page.route("**/sw.js", (route) =>
				route.fulfill({
					status: 200,
					contentType: "application/javascript",
					body: "// mock service worker\nself.addEventListener('install', () => self.skipWaiting());\nself.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));",
				}),
			);

			await page.route("**/api/push/vapid-key", (route) =>
				route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({
						publicKey:
							"BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkOs-cF0LMNKU5dmPfV0lDh3SkWa3M8dyTcIx8Fk2s",
					}),
				}),
			);

			await page.route("**/api/push/subscribe", (route) =>
				route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ ok: true }),
				}),
			);
		});

		// Mock push APIs in the browser context before navigating
		await phase("mock-push-apis", async () => {
			await page.addInitScript(() => {
				// Mock Notification API so requestPermission succeeds
				const notifMock = {
					_perm: "default" as NotificationPermission,
				};
				Object.defineProperty(window, "Notification", {
					value: {
						get permission() {
							return notifMock._perm;
						},
						async requestPermission() {
							notifMock._perm = "granted";
							return "granted" as NotificationPermission;
						},
					},
					writable: true,
					configurable: true,
				});

				// Mock PushManager on service worker registrations
				const originalRegister = navigator.serviceWorker?.register?.bind(
					navigator.serviceWorker,
				);
				if (navigator.serviceWorker && originalRegister) {
					navigator.serviceWorker.register = async (
						...args: Parameters<ServiceWorkerContainer["register"]>
					) => {
						const reg = await originalRegister(...args);
						// Patch pushManager.subscribe to return a mock subscription
						const origSubscribe = reg.pushManager.subscribe.bind(
							reg.pushManager,
						);
						reg.pushManager.subscribe = async () => {
							try {
								return await origSubscribe({
									userVisibleOnly: true,
									applicationServerKey: new Uint8Array(65),
								});
							} catch {
								// If real subscribe fails, return a mock
								return {
									endpoint: "https://mock.push/endpoint",
									expirationTime: null,
									options: {
										userVisibleOnly: true,
										applicationServerKey: new ArrayBuffer(65),
									},
									getKey: () => new ArrayBuffer(0),
									unsubscribe: async () => true,
									toJSON: () => ({
										endpoint: "https://mock.push/endpoint",
										keys: { p256dh: "mock", auth: "mock" },
									}),
								} as unknown as PushSubscription;
							}
						};
						return reg;
					};
				}
			});
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

				// Try Next first, then Enable, then Skip/Finish anyway
				const nextBtn = page.locator("button").filter({ hasText: /^next$/i });
				const enableBtn = page
					.locator("button")
					.filter({ hasText: /enable push/i });
				const skipBtn = page
					.locator("button")
					.filter({ hasText: /skip|finish anyway/i });

				if ((await nextBtn.count()) > 0) {
					await nextBtn.first().click();
				} else if ((await enableBtn.count()) > 0) {
					await enableBtn.first().click();
					// Wait for the push flow to complete (mocked, should be fast)
					await page.waitForTimeout(1500);
					// Check if we auto-advanced to next step
					const stillOnPush = await enableBtn.count();
					if (stillOnPush > 0) {
						// Didn't auto-advance — look for finish anyway
						const finishBtn = page
							.locator("button")
							.filter({ hasText: /finish anyway/i });
						if ((await finishBtn.count()) > 0) {
							await finishBtn.first().click();
						}
					}
				} else if ((await skipBtn.count()) > 0) {
					await skipBtn.first().click();
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
