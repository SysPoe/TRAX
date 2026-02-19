import { isRegion, TraxConfig } from "../../../../config.js";

export default function ensureQRTEnabled(config: TraxConfig) {
	if (!isRegion(config.region, "AU/SEQ"))
		throw new Error("QRT Travel functions are only available in the SEQ region configuration.");
}
