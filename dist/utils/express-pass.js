// Hardcoded SRT data from metro-srt-travel-train.csv
// Map of (from, to) => travel time in minutes
const SRT = {
    "Roma Street": { "Normanby": 2, "Central": 2, "Milton": 1, "South Brisbane": 4 },
    "Brisbane - Roma Street": { "Normanby": 2, "Central": 2, "Milton": 1, "South Brisbane": 4 },
    "Normanby": { "Exhibition": 1 },
    "Exhibition": { "Campbell Street": 1 },
    "Campbell Street": { "Mayne Junction": 1 },
    "Mayne Junction": { "Mayne": 1 },
    "Bowen Hills": { "Campbell Street": 1, "Electric Depot Junction": 2, "Mayne": 1 },
    "Central": { "Brunswick Street": 2 },
    "Brunswick Street": { "Bowen Hills": 2 },
    "Mayne": { "Albion": 2 },
    "Albion": { "Wooloowin": 1 },
    "Wooloowin": { "Eagle Junction": 1 },
    "Eagle Junction": { "Airport Junction": 1, "Clayfield": 1 },
    "Airport Junction": { "Toombul": 1, "International Terminal": 3 },
    "Toombul": { "Nundah": 1 },
    "Nundah": { "Northgate": 1 },
    "Northgate": { "Virginia": 2, "Bindha": 1 },
    "Virginia": { "Sunshine": 1 },
    "Sunshine": { "Geebung": 1 },
    "Geebung": { "Zillmere": 2 },
    "Zillmere": { "Carseldine": 2 },
    "Carseldine": { "Bald Hills": 3 },
    "Bald Hills": { "Strathpine": 2 },
    "Strathpine": { "Bray Park": 1 },
    "Bray Park": { "Lawnton": 2 },
    "Lawnton": { "Petrie": 2 },
    "Petrie": { "Dakabin": 4, "Kallangur": 2 },
    "Dakabin": { "Narangba": 4 },
    "Narangba": { "Burpengary": 4 },
    "Burpengary": { "Morayfield": 5 },
    "Morayfield": { "Caboolture": 4 },
    "Caboolture": { "Elimbah": 7 },
    "Elimbah": { "Beerburrum": 5 },
    "Beerburrum": { "Glasshouse Mountains": 8 },
    "Glasshouse Mountains": { "Beerwah": 5 },
    "Beerwah": { "Landsborough": 5 },
    "Landsborough": { "Mooloolah": 6 },
    "Mooloolah": { "Eudlo": 7 },
    "Eudlo": { "Palmwoods": 4 },
    "Palmwoods": { "Woombye": 4 },
    "Woombye": { "Nambour": 2 },
    "Bindha": { "Banyo": 1 },
    "Banyo": { "Nudgee": 1 },
    "Nudgee": { "Boondall": 2 },
    "Boondall": { "North Boondall": 1 },
    "North Boondall": { "Deagon": 1 },
    "Deagon": { "Sandgate": 1 },
    "Sandgate": { "Shorncliffe": 2 },
    "International Terminal": { "Domestic Terminal": 3 },
    "Clayfield": { "Hendra": 1 },
    "Hendra": { "Ascot": 1 },
    "Ascot": { "Doomben": 2 },
    "Electric Depot Junction": { "Windsor": 1 },
    "Windsor": { "Wilston": 1 },
    "Wilston": { "Newmarket": 1 },
    "Newmarket": { "Alderley": 1 },
    "Alderley": { "Enoggera": 1 },
    "Enoggera": { "Gaythorne": 1 },
    "Gaythorne": { "Mitchelton": 1 },
    "Mitchelton": { "Oxford Park": 1 },
    "Oxford Park": { "Grovely": 1 },
    "Grovely": { "Keperra": 1 },
    "Keperra": { "Ferny Grove": 3 },
    "Milton": { "Auchenflower": 1 },
    "Auchenflower": { "Toowong": 1 },
    "Toowong": { "Taringa": 1 },
    "Taringa": { "Indooroopilly": 1 },
    "Indooroopilly": { "Chelmer": 2 },
    "Chelmer": { "Graceville": 1 },
    "Graceville": { "Sherwood": 1 },
    "Sherwood": { "Corinda": 1 },
    "Corinda": { "Oxley": 2, "Moolabin": 1 },
    "Oxley": { "Darra": 2 },
    "Darra": { "Wacol": 2, "Richlands": 3 },
    "Wacol": { "Gailes": 2 },
    "Gailes": { "Goodna": 1 },
    "Goodna": { "Redbank": 4 },
    "Redbank": { "Riverview": 2 },
    "Riverview": { "Dinmore": 1 },
    "Dinmore": { "Ebbw Vale": 2 },
    "Ebbw Vale": { "Bundamba": 2 },
    "Bundamba": { "Booval": 1 },
    "Booval": { "East Ipswich": 1 },
    "East Ipswich": { "Ipswich": 2 },
    "Ipswich": { "Thomas Street": 2 },
    "Thomas Street": { "Wulkuraka": 2 },
    "Wulkuraka": { "Karrabin": 2 },
    "Karrabin": { "Walloon": 3 },
    "Walloon": { "Thagoona": 3 },
    "Thagoona": { "Yarrowlea": 3 },
    "Yarrowlea": { "Rosewood": 1 },
    "Yeerongpilly": { "Tennyson Yard": 2, "Moorooka": 1 },
    "Clapham": { "Yeerongpilly": 1 },
    "Tennyson Yard": { "Moolabin": 2 },
    "Salisbury": { "Acacia Ridge": 5, "Coopers Plains": 2 },
    "South Brisbane": { "South Bank": 1 },
    "South Bank": { "Park Road": 1 },
    "Park Road": { "Dutton Park": 2, "Buranda": 2 },
    "Dutton Park": { "Fairfield": 1 },
    "Fairfield": { "Yeronga": 2 },
    "Yeronga": { "Yeerongpilly": 1 },
    "Moorooka": { "Rocklea": 2 },
    "Rocklea": { "Salisbury": 1 },
    "Coopers Plains": { "Banoon": 1 },
    "Banoon": { "Sunnybank": 1 },
    "Sunnybank": { "Altandi": 1 },
    "Altandi": { "Runcorn": 1 },
    "Runcorn": { "Fruitgrove": 2 },
    "Fruitgrove": { "Kuraby": 1 },
    "Kuraby": { "Trinder Park": 3 },
    "Trinder Park": { "Woodridge": 1 },
    "Woodridge": { "Kingston": 2 },
    "Kingston": { "Loganlea": 1 },
    "Loganlea": { "Bethania": 2 },
    "Bethania": { "Eden's Landing": 1 },
    "Eden's Landing": { "Holmview": 1 },
    "Holmview": { "Beenleigh": 2 },
    "Beenleigh": { "Ormeau": 7 },
    "Ormeau": { "Coomera": 5 },
    "Coomera": { "Helensvale": 5 },
    "Helensvale": { "Nerang": 5 },
    "Nerang": { "Robina": 5 },
    "Robina": { "Varsity Lakes": 4 },
    "Buranda": { "Coorparoo": 1 },
    "Coorparoo": { "Norman Park": 1 },
    "Norman Park": { "Morningside": 2 },
    "Morningside": { "Cannon Hill": 1 },
    "Cannon Hill": { "Murarrie": 1 },
    "Murarrie": { "Hemmant": 2 },
    "Hemmant": { "Lindum": 2 },
    "Lindum": { "Lytton Junction": 1 },
    "Lytton Junction": { "Wynnum North": 1, "Fisherman Islands": 10 },
    "Wynnum North": { "Wynnum": 2 },
    "Wynnum": { "Wynnum Central": 2 },
    "Wynnum Central": { "Manly": 2 },
    "Manly": { "Lota": 1 },
    "Lota": { "Thorneside": 1 },
    "Thorneside": { "Birkdale": 2 },
    "Birkdale": { "Wellington Point": 2 },
    "Wellington Point": { "Ormiston": 1 },
    "Ormiston": { "Cleveland": 2 },
    "Nambour": { "Yandina": 9 },
    "Yandina": { "North Arm": 6, "Eumundi": 10 },
    "North Arm": { "Eumundi": 4 },
    "Eumundi": { "Sunrise": 2, "Cooroy": 8 },
    "Sunrise": { "Cooroy": 6 },
    "Cooroy": { "Pomona": 9 },
    "Pomona": { "Cooran": 7 },
    "Cooran": { "Traveston": 6 },
    "Traveston": { "Woondum": 7, "Gympie North": 19 },
    "Woondum": { "Glanmire": 8 },
    "Glanmire": { "Gympie North": 4 },
    "Kallangur": { "Murrumba Downs": 1 },
    "Murrumba Downs": { "Mango Hill station": 2 },
    "Mango Hill station": { "Mango Hill East": 2 },
    "Mango Hill East": { "Rothwell": 2 },
    "Rothwell": { "Kippa-Ring": 4 },
    "Richlands": { "Springfield station": 5 },
    "Springfield station": { "Springfield Central": 3 },
};
/**
 * Given a sequence of TrainMovementDTOs, return an array of all stops (including passing stops) with times.
 * Passing stops are those between two consecutive stopping stations, as per SRT, that are not in the movement list.
 * For passing stops, estimate the pass time by interpolating between the two known stops using SRT times.
 */
export function getExpressPassingStops(movements) {
    const result = [];
    if (movements.length === 0)
        return result;
    // Helper to get time as Date or null
    function parseTime(s) {
        if (!s || s === "0001-01-01T00:00:00")
            return null;
        return new Date(s);
    }
    // For each pair of consecutive stopping stations
    for (let i = 0; i < movements.length - 1; ++i) {
        const from = movements[i];
        const to = movements[i + 1];
        const fromName = from.PlaceName;
        const toName = to.PlaceName;
        // Add the 'from' stop (always a stopping station)
        result.push({
            placeCode: from.PlaceCode,
            placeName: from.PlaceName,
            isPassing: false,
            plannedArrival: from.PlannedArrival,
            plannedDeparture: from.PlannedDeparture,
            passTime: null,
        });
        // Find all passing stops between from and to
        const srtRow = SRT[fromName];
        const travelMins = srtRow && srtRow[toName];
        if (!travelMins)
            continue; // No SRT data, skip
        // Find all possible passing stops between from and to
        // We'll do a BFS to find the shortest path (by number of stops) between from and to
        function bfsStops(start, end) {
            if (start === end)
                return [start];
            const queue = [{ stop: start, path: [start] }];
            const visited = new Set([start]);
            while (queue.length > 0) {
                const { stop, path } = queue.shift();
                if (stop === end)
                    return path;
                const nexts = SRT[stop] ? Object.keys(SRT[stop]) : [];
                for (const n of nexts) {
                    if (!visited.has(n)) {
                        visited.add(n);
                        queue.push({ stop: n, path: [...path, n] });
                    }
                }
            }
            return null;
        }
        const path = bfsStops(fromName, toName);
        if (!path || path.length < 2)
            continue;
        // Remove endpoints, keep only passing stops
        const passingStops = path.slice(1, -1);
        if (passingStops.length === 0)
            continue;
        // Calculate total SRT time for the path
        let totalMins = 0;
        for (let j = 0; j < path.length - 1; ++j) {
            const mins = SRT[path[j]] && SRT[path[j]][path[j + 1]];
            if (!mins) {
                totalMins = 0;
                break;
            }
            totalMins += mins;
        }
        if (!totalMins)
            continue;
        // Get from/to times
        const fromTime = parseTime(from.PlannedDeparture) || parseTime(from.PlannedArrival);
        const toTime = parseTime(to.PlannedArrival) || parseTime(to.PlannedDeparture);
        if (!fromTime || !toTime)
            continue;
        // Interpolate pass times for each passing stop
        let elapsed = 0;
        for (let j = 0; j < passingStops.length; ++j) {
            const stop = passingStops[j];
            // Find SRT from previous stop
            const prev = j === 0 ? fromName : passingStops[j - 1];
            const mins = SRT[prev] && SRT[prev][stop];
            if (!mins)
                continue;
            elapsed += mins;
            // Interpolated time
            const passTime = new Date(fromTime.getTime() + (elapsed * 60 * 1000));
            result.push({
                placeCode: stop,
                placeName: stop,
                isPassing: true,
                plannedArrival: null,
                plannedDeparture: null,
                passTime: passTime.toISOString(),
            });
        }
    }
    // Add the last stop
    const last = movements[movements.length - 1];
    result.push({
        placeCode: last.PlaceCode,
        placeName: last.PlaceName,
        isPassing: false,
        plannedArrival: last.PlannedArrival,
        plannedDeparture: last.PlannedDeparture,
        passTime: null,
    });
    return result;
}
