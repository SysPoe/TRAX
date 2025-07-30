// Hard-coded metro SRT data for travel trains from metro-srt-travel-train.csv
const METRO_SRT_TRAVEL_TRAIN_DATA = `From,To,Travel Train
Roma Street,Normanby,2
Brisbane - Roma Street,Normanby,2
Normanby,Exhibition,1
Exhibition,Campbell Street,1
Campbell Street,Mayne Junction,1
Mayne Junction,Mayne,1
Bowen Hills,Campbell Street,1
Roma Street,Central,2
Brisbane - Roma Street,Central,2
Central,Brunswick Street,2
Brunswick Street,Bowen Hills,2
Bowen Hills,Mayne,1
Mayne,Albion,2
Albion,Wooloowin,1
Wooloowin,Eagle Junction,1
Eagle Junction,Airport Junction,1
Airport Junction,Toombul,1
Toombul,Nundah,1
Nundah,Northgate,1
Northgate,Virginia,2
Virginia,Sunshine,1
Sunshine,Geebung,1
Geebung,Zillmere,2
Zillmere,Carseldine,2
Carseldine,Bald Hills,3
Bald Hills,Strathpine,2
Strathpine,Bray Park,1
Bray Park,Lawnton,2
Lawnton,Petrie,2
Petrie,Dakabin,4
Dakabin,Narangba,4
Narangba,Burpengary,4
Burpengary,Morayfield,5
Morayfield,Caboolture,4
Caboolture,Elimbah,7
Elimbah,Beerburrum,5
Beerburrum,Glasshouse Mountains,8
Glasshouse Mountains,Beerwah,5
Beerwah,Landsborough,5
Landsborough,Mooloolah,6
Mooloolah,Eudlo,7
Eudlo,Palmwoods,4
Palmwoods,Woombye,4
Woombye,Nambour,2
Northgate,Bindha,1
Bindha,Banyo,1
Banyo,Nudgee,1
Nudgee,Boondall,2
Boondall,North Boondall,1
North Boondall,Deagon,1
Deagon,Sandgate,1
Sandgate,Shorncliffe,2
Airport Junction,International Terminal,3
International Terminal,Domestic Terminal,3
Eagle Junction,Clayfield,1
Clayfield,Hendra,1
Hendra,Ascot,1
Ascot,Doomben,2
Eagle Farm,Bunour,1
Bunour,Meeandah,1
Meeandah,Pinkenba,2
Bowen Hills,Electric Depot Junction,2
Electric Depot Junction,Windsor,1
Windsor,Wilston,1
Wilston,Newmarket,1
Newmarket,Alderley,1
Alderley,Enoggera,1
Enoggera,Gaythorne,1
Gaythorne,Mitchelton,1
Mitchelton,Oxford Park,1
Oxford Park,Grovely,1
Grovely,Keperra,1
Keperra,Ferny Grove,3
Roma Street,Milton,1
Brisbane - Roma Street,Milton,1
Milton,Auchenflower,1
Auchenflower,Toowong,1
Toowong,Taringa,1
Taringa,Indooroopilly,1
Indooroopilly,Chelmer,2
Chelmer,Graceville,1
Graceville,Sherwood,1
Sherwood,Corinda,1
Corinda,Oxley,2
Oxley,Darra,2
Darra,Wacol,2
Wacol,Gailes,2
Gailes,Goodna,1
Goodna,Redbank,4
Redbank,Riverview,2
Riverview,Dinmore,1
Dinmore,Ebbw Vale,2
Ebbw Vale,Bundamba,2
Bundamba,Booval,1
Booval,East Ipswich,1
East Ipswich,Ipswich,2
Ipswich,Thomas Street,2
Thomas Street,Wulkuraka,2
Wulkuraka,Karrabin,2
Karrabin,Walloon,3
Walloon,Thagoona,3
Thagoona,Yarrowlea,3
Yarrowlea,Rosewood,1
Corinda,Moolabin,1
Yeerongpilly,Tennyson Yard,2
Clapham,Yeerongpilly,1
Tennyson Yard,Moolabin,2
Salisbury,Acacia Ridge,5
Roma Street,South Brisbane,4
Brisbane - Roma Street,South Brisbane,4
South Brisbane,South Bank,1
South Bank,Park Road,1
Park Road,Dutton Park,2
Dutton Park,Fairfield,1
Fairfield,Yeronga,2
Yeronga,Yeerongpilly,1
Yeerongpilly,Moorooka,1
Moorooka,Rocklea,2
Rocklea,Salisbury,1
Salisbury,Coopers Plains,2
Coopers Plains,Banoon,1
Banoon,Sunnybank,1
Sunnybank,Altandi,1
Altandi,Runcorn,1
Runcorn,Fruitgrove,2
Fruitgrove,Kuraby,1
Kuraby,Trinder Park,3
Trinder Park,Woodridge,1
Woodridge,Kingston,2
Kingston,Loganlea,1
Loganlea,Bethania,2
Bethania,Eden's Landing,1
Eden's Landing,Holmview,1
Holmview,Beenleigh,2
Beenleigh,Ormeau,7
Ormeau,Coomera,5
Coomera,Helensvale,5
Helensvale,Nerang,5
Nerang,Robina,5
Robina,Varsity Lakes,4
Park Road,Buranda,2
Buranda,Coorparoo,1
Coorparoo,Norman Park,1
Norman Park,Morningside,2
Morningside,Cannon Hill,1
Cannon Hill,Murarrie,1
Murarrie,Hemmant,2
Hemmant,Lindum,2
Lindum,Lytton Junction,1
Lytton Junction,Wynnum North,1
Wynnum North,Wynnum,2
Wynnum,Wynnum Central,2
Wynnum Central,Manly,2
Manly,Lota,1
Lota,Thorneside,1
Thorneside,Birkdale,2
Birkdale,Wellington Point,2
Wellington Point,Ormiston,1
Ormiston,Cleveland,2
Lytton Junction,Fisherman Islands,10
Ormiston,Cleveland,2
Nambour,Yandina,9
Yandina,North Arm,6
North Arm,Eumundi,4
Eumundi,Sunrise,2
Sunrise,Cooroy,6
Cooroy,Pomona,9
Pomona,Cooran,7
Cooran,Traveston,6
Traveston,Woondum,7
Woondum,Glanmire,8
Glanmire,Gympie North,4
Nambour,Yandina,9
Yandina,Eumundi,10
Eumundi,Cooroy,8
Cooroy,Pomona,9
Pomona,Cooran,7
Cooran,Traveston,6
Traveston,Gympie North,19
Petrie,Kallangur,2
Kallangur,Murrumba Downs,1
Murrumba Downs,Mango Hill station,2
Mango Hill station,Mango Hill East,2
Mango Hill East,Rothwell,2
Rothwell,Kippa-Ring,4
Darra,Richlands,3
Richlands,Springfield station,5
Springfield station,Springfield Central,3`;
// Parse the SRT data into a lookup structure
function parseSRTData() {
    const lines = METRO_SRT_TRAVEL_TRAIN_DATA.trim().split('\n');
    const srtMap = new Map();
    // Skip header line
    for (let i = 1; i < lines.length; i++) {
        const [from, to, timeStr] = lines[i].split(',');
        const time = parseInt(timeStr);
        // Create bidirectional mapping
        if (!srtMap.has(from)) {
            srtMap.set(from, new Map());
        }
        if (!srtMap.has(to)) {
            srtMap.set(to, new Map());
        }
        srtMap.get(from).set(to, time);
        srtMap.get(to).set(from, time);
    }
    return srtMap;
}
const SRT_MAP = parseSRTData();
/**
 * Normalize place names to match SRT data format
 */
function normalizePlaceName(placeName) {
    // Handle common variations and mappings
    const normalized = placeName
        .replace('Brisbane - ', '')
        .replace(' station', '')
        .replace(' Station', '')
        .replace('Townsville - Charters Towers Road', 'Townsville')
        .trim();
    // Handle specific mappings for QR Travel vs SRT data mismatches
    const mappings = {
        'Brisbane - Roma Street': 'Roma Street',
        'Roma Street': 'Roma Street',
        'Townsville': 'Townsville',
        'Eden\'s Landing': 'Eden\'s Landing'
    };
    return mappings[normalized] || normalized;
}
/**
 * Get sectional running time between two places
 */
function getSRT(from, to) {
    const normalizedFrom = normalizePlaceName(from);
    const normalizedTo = normalizePlaceName(to);
    return SRT_MAP.get(normalizedFrom)?.get(normalizedTo) || null;
}
/**
 * Build station sequences for different QR Travel routes
 */
function getRouteStations(fromStation, toStation) {
    const fromNorm = normalizePlaceName(fromStation);
    const toNorm = normalizePlaceName(toStation);
    // Define the main QR Travel routes in order
    const mainLineNorth = [
        'Roma Street', 'Central', 'Fortitude Valley', 'Bowen Hills', 'Albion', 'Wooloowin', 'Eagle Junction',
        'Toombul', 'Nundah', 'Northgate', 'Virginia', 'Sunshine', 'Geebung', 'Zillmere', 'Carseldine',
        'Bald Hills', 'Strathpine', 'Bray Park', 'Lawnton', 'Petrie', 'Dakabin', 'Narangba', 'Burpengary',
        'Morayfield', 'Caboolture', 'Elimbah', 'Beerburrum', 'Glasshouse Mountains', 'Beerwah',
        'Landsborough', 'Mooloolah', 'Eudlo', 'Palmwoods', 'Woombye', 'Nambour', 'Yandina', 'Eumundi',
        'Cooroy', 'Pomona', 'Cooran', 'Traveston', 'Gympie North'
    ];
    // For long-distance QR Travel trains, only use SRT data for SEQ portion
    const seqBoundary = 'Gympie North';
    // Find stations in the route
    const fromIndex = mainLineNorth.findIndex(station => normalizePlaceName(station) === fromNorm);
    const toIndex = mainLineNorth.findIndex(station => normalizePlaceName(station) === toNorm);
    if (fromIndex !== -1 && toIndex !== -1) {
        const start = Math.min(fromIndex, toIndex);
        const end = Math.max(fromIndex, toIndex);
        return mainLineNorth.slice(start, end + 1);
    }
    // Check if we're dealing with a route that goes beyond SEQ
    const seqIndex = mainLineNorth.indexOf(seqBoundary);
    if (fromIndex !== -1 && fromIndex <= seqIndex) {
        // From station is in SEQ, return stations up to SEQ boundary
        return mainLineNorth.slice(fromIndex, seqIndex + 1);
    }
    // If no route found, return empty array
    return [];
}
/**
 * Calculate passing stops and their estimated times for QR Travel trains
 */
export function calculateQRTravelExpressStops(movements) {
    const result = [];
    // Convert movements to enhanced format first
    const stoppingStations = movements.map(movement => ({
        placeCode: movement.PlaceCode,
        placeName: movement.PlaceName,
        kStation: movement.KStation,
        status: movement.Status,
        trainPosition: movement.TrainPosition,
        plannedArrival: movement.PlannedArrival,
        plannedDeparture: movement.PlannedDeparture,
        actualArrival: movement.ActualArrival,
        actualDeparture: movement.ActualDeparture,
        arrivalDelaySeconds: null,
        departureDelaySeconds: null,
        delayString: "scheduled",
        delayClass: "scheduled",
        passing: false
    }));
    // Process each consecutive pair of stopping stations
    for (let i = 0; i < stoppingStations.length - 1; i++) {
        const currentStop = stoppingStations[i];
        const nextStop = stoppingStations[i + 1];
        // Add the current stopping station
        result.push({
            ...currentStop,
            expressInfo: {
                type: "stopping",
                from: currentStop.placeName,
                to: currentStop.placeName,
                srtAvailable: getSRT(currentStop.placeName, currentStop.placeName) !== null
            }
        });
        // Find intermediate stations between current and next stop
        const intermediateStations = findIntermediateStations(currentStop.placeName, nextStop.placeName, STATION_SEQUENCE);
        if (intermediateStations.length > 0) {
            // Calculate express segment timing
            const totalSRT = getSRT(currentStop.placeName, nextStop.placeName);
            const srtAvailable = totalSRT !== null;
            if (srtAvailable && totalSRT) {
                // Calculate estimated passing times
                let accumulatedTime = 0;
                const departureTime = parseTime(currentStop.actualDeparture !== "0001-01-01T00:00:00"
                    ? currentStop.actualDeparture
                    : currentStop.plannedDeparture);
                for (const station of intermediateStations) {
                    const segmentSRT = getSRT(currentStop.placeName, station);
                    if (segmentSRT) {
                        accumulatedTime += segmentSRT;
                        const passingTime = addMinutesToTime(departureTime, accumulatedTime);
                        result.push({
                            placeCode: "",
                            placeName: station,
                            kStation: false,
                            status: "Passing",
                            trainPosition: "NotArrived",
                            plannedArrival: "0001-01-01T00:00:00",
                            plannedDeparture: "0001-01-01T00:00:00",
                            actualArrival: "0001-01-01T00:00:00",
                            actualDeparture: "0001-01-01T00:00:00",
                            arrivalDelaySeconds: null,
                            departureDelaySeconds: null,
                            delayString: "passing",
                            delayClass: "scheduled",
                            passing: true,
                            calculatedArrival: passingTime,
                            calculatedDeparture: passingTime,
                            expressInfo: {
                                type: "express",
                                from: currentStop.placeName,
                                to: nextStop.placeName,
                                passingStops: intermediateStations,
                                message: `Express from ${currentStop.placeName} to ${nextStop.placeName}`,
                                srtAvailable: true
                            }
                        });
                    }
                }
            }
            else {
                // Add passing stops without timing if SRT data is not available
                for (const station of intermediateStations) {
                    result.push({
                        placeCode: "",
                        placeName: station,
                        kStation: false,
                        status: "Passing",
                        trainPosition: "NotArrived",
                        plannedArrival: "0001-01-01T00:00:00",
                        plannedDeparture: "0001-01-01T00:00:00",
                        actualArrival: "0001-01-01T00:00:00",
                        actualDeparture: "0001-01-01T00:00:00",
                        arrivalDelaySeconds: null,
                        departureDelaySeconds: null,
                        delayString: "passing",
                        delayClass: "scheduled",
                        passing: true,
                        expressInfo: {
                            type: "express",
                            from: currentStop.placeName,
                            to: nextStop.placeName,
                            passingStops: intermediateStations,
                            message: `Express from ${currentStop.placeName} to ${nextStop.placeName} (timing unavailable)`,
                            srtAvailable: false
                        }
                    });
                }
            }
        }
    }
    // Add the final stopping station
    if (stoppingStations.length > 0) {
        const lastStop = stoppingStations[stoppingStations.length - 1];
        result.push({
            ...lastStop,
            expressInfo: {
                type: "stopping",
                from: lastStop.placeName,
                to: lastStop.placeName,
                srtAvailable: getSRT(lastStop.placeName, lastStop.placeName) !== null
            }
        });
    }
    return result;
}
/**
 * Parse time string to minutes since midnight
 */
function parseTime(timeString) {
    if (!timeString || timeString === "0001-01-01T00:00:00")
        return 0;
    try {
        const date = new Date(timeString);
        return date.getHours() * 60 + date.getMinutes();
    }
    catch {
        return 0;
    }
}
/**
 * Add minutes to a time and return formatted time string
 */
function addMinutesToTime(baseMinutes, additionalMinutes) {
    const totalMinutes = baseMinutes + additionalMinutes;
    const hours = Math.floor(totalMinutes / 60) % 24;
    const minutes = totalMinutes % 60;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}
/**
 * Format time for display
 */
export function formatTime(timeString) {
    if (!timeString || timeString === "0001-01-01T00:00:00")
        return "--:--";
    try {
        const date = new Date(timeString);
        return date.toTimeString().slice(0, 5);
    }
    catch {
        return "--:--";
    }
}
