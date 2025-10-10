import { parentPort } from "worker_threads";
import logger from "../utils/logger.js";
import { buildRealtimeCacheSnapshot } from "../cache.js";

type WorkerCommand = { type: "refresh" };

type WorkerResponse =
	| { type: "result"; snapshot: Awaited<ReturnType<typeof buildRealtimeCacheSnapshot>> }
	| { type: "error"; error: { message: string; stack?: string } };

const port = parentPort;

if (!port) throw new Error("No parent port available for realtime cache worker.");

port.on("message", async (message: WorkerCommand) => {
	if (message?.type !== "refresh") return;

	try {
		const snapshot = await buildRealtimeCacheSnapshot();
		const response: WorkerResponse = { type: "result", snapshot };
		port.postMessage(response);
		port.close();
	} catch (error: any) {
		logger.error("Realtime cache worker failed to build snapshot", {
			module: "realtimeCacheWorker",
			function: "message",
			error: error?.message ?? String(error),
		});
		const response: WorkerResponse = {
			type: "error",
			error: {
				message: error?.message ?? "Unknown worker error",
				stack: error?.stack,
			},
		};
		port.postMessage(response);
		port.close();
	}
});
