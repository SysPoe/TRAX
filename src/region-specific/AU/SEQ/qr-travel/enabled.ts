import { hasPlugin, type TraxConfig } from "../../../../config.js";

export default function ensureQRTEnabled(config: TraxConfig) {
	if (!hasPlugin(config, "au-seq"))
		throw new Error("QRT Travel functions are only available in the SEQ region configuration.");
}
