import type { Preview } from "@storybook/svelte-vite";
import "../src/lib/frontend/style.css";

const preview: Preview = {
	parameters: {
		backgrounds: {
			options: {
				app: { name: "app", value: "#18181B" },
				light: { name: "light", value: "#FDFCFC" },
				surface: { name: "surface", value: "#27272A" },
			},
		},
		layout: "fullscreen",
	},

	initialGlobals: {
		backgrounds: {
			value: "app",
		},
	},
};

export default preview;
