import TRAX from ".";
async function main() {
    try {
        console.log("Starting test...");
        console.log("Loading GTFS data...");
        await TRAX.loadGTFS();
        console.log("GTFS loaded successfully!");
        console.log("Fetching current QR Travel trains...");
        const qrTravelTrains = await TRAX.qrTravel.getCurrentQRTravelTrains();
        console.log(`Found ${qrTravelTrains.length} QR Travel trains`);
        if (qrTravelTrains.length === 0) {
            console.log("No QR Travel trains found currently running.");
            return;
        }
        // Get the first train for demonstration
        const firstTrain = qrTravelTrains[0];
        console.log(`\n=== ${firstTrain.serviceName} (${firstTrain.serviceId}) ===`);
        console.log(`Direction: ${firstTrain.direction}`);
        console.log(`Line: ${firstTrain.line}`);
        console.log(`Status: ${firstTrain.status}`);
        console.log(`Number of original stops: ${firstTrain.stops.length}`);
        // Now let's import and use the express function
        const { calculateQRTravelExpressStops, formatTime } = await import("./qr-travel/qr-travel-express.js");
        // Convert the train movements to enhanced format with passing stops
        const originalMovements = firstTrain.stops.map(stop => ({
            PlaceCode: stop.placeCode,
            PlaceName: stop.placeName,
            KStation: stop.kStation,
            Status: stop.status,
            TrainPosition: stop.trainPosition,
            PlannedArrival: stop.plannedArrival,
            PlannedDeparture: stop.plannedDeparture,
            ActualArrival: stop.actualArrival,
            ActualDeparture: stop.actualDeparture
        }));
        console.log("Calculating express stops...");
        const enhancedStops = calculateQRTravelExpressStops(originalMovements);
        console.log(`\n=== Enhanced Stopping Pattern (${enhancedStops.length} stops including passing) ===`);
        for (const stop of enhancedStops) {
            const arrTime = stop.calculatedArrival || formatTime(stop.actualArrival !== "0001-01-01T00:00:00" ? stop.actualArrival : stop.plannedArrival);
            const depTime = stop.calculatedDeparture || formatTime(stop.actualDeparture !== "0001-01-01T00:00:00" ? stop.actualDeparture : stop.plannedDeparture);
            const statusText = stop.passing ? "[PASSING]" : stop.kStation ? "[REQUEST STOP]" : "[STOPPING]";
            const timingText = stop.calculatedArrival ? "[CALCULATED]" : "[SCHEDULED/ACTUAL]";
            const srtText = stop.expressInfo?.srtAvailable ? "[SRT]" : "[NO-SRT]";
            console.log(`  ${stop.placeName.padEnd(25)} ${statusText.padEnd(15)} arr: ${arrTime} dep: ${depTime} ${timingText} ${srtText}`);
        }
        console.log(`\n=== Summary ===`);
        const stoppingCount = enhancedStops.filter(s => !s.passing).length;
        const passingCount = enhancedStops.filter(s => s.passing).length;
        const srtAvailableCount = enhancedStops.filter(s => s.expressInfo?.srtAvailable).length;
        console.log(`Total stops: ${enhancedStops.length}`);
        console.log(`Stopping stations: ${stoppingCount}`);
        console.log(`Passing stations: ${passingCount}`);
        console.log(`With SRT timing data: ${srtAvailableCount}`);
        console.log(`Without SRT timing data: ${enhancedStops.length - srtAvailableCount}`);
    }
    catch (error) {
        console.error("Error in test:", error);
    }
}
main().catch(console.error);
