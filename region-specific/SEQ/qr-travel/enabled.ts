import { TraxConfig } from "../../../config.js";

export default function ensureQRTEnabled(config: TraxConfig) {
    if (config.region !== "SEQ") throw new Error("QRT Travel functions are only available in the SEQ region configuration.");
}