import { wsSend } from "../../stores/ws.svelte.js";
import { onFileBrowser } from "../../stores/ws-listeners.js";
import { formatFileSize } from "../../utils/format.js";

export function fetchFileContent(
	path: string,
): Promise<{ content: string; binary?: boolean }> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("timeout")), 5000);

		const unsub = onFileBrowser((msg) => {
			if (
				msg.type === "file_content" &&
				(msg as { path: string }).path === path
			) {
				clearTimeout(timeout);
				unsub();
				const result: { content: string; binary?: boolean } = {
					content: (msg as { content: string }).content,
				};
				const binaryVal = (msg as { binary?: boolean }).binary;
				if (binaryVal !== undefined) {
					result.binary = binaryVal;
				}
				resolve(result);
			}
		});

		wsSend({ type: "get_file_content", path });
	});
}

export function fetchDirectoryListing(path: string): Promise<string> {
	const requestPath = path.replace(/\/$/, "");
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("timeout")), 5000);

		const unsub = onFileBrowser((msg) => {
			if (
				msg.type === "file_list" &&
				(msg as { path: string }).path === requestPath
			) {
				clearTimeout(timeout);
				unsub();
				const entries = (
					msg as {
						entries: Array<{ name: string; type: string; size?: number }>;
					}
				).entries;
				const listing = entries
					.map((e) =>
						e.type === "directory"
							? `${e.name}/ (directory)`
							: `${e.name} (${formatFileSize(e.size ?? 0)}, file)`,
					)
					.join("\n");
				resolve(listing);
			}
		});

		wsSend({ type: "get_file_list", path: requestPath });
	});
}
