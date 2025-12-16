import { TRAX_CONFIG } from "../../../config.js";
export default function ensureQRTEnabled() {
    if (TRAX_CONFIG.region !== "SEQ") throw new Error("QRT Travel functions are only available in the SEQ region configuration.");
}