import { refreshRealtimeCache } from './cache.js';
import { loadGTFS } from './index.js';
function refresh(i) {
    if (i == 2)
        return;
    refreshRealtimeCache();
    refresh(i + 1);
}
loadGTFS().then(() => {
    refresh(0);
});
