// For SRT passing stop expansion
import { expandWithSRTPassingStops } from "../utils/SectionalRunningTimes/metroSRTTravelTrain.js";
import logger from "../utils/logger.js";
import { getGtfsStations } from "../utils/stations.js";
// Main function to fetch and parse the XML file
export async function trackTrain(serviceID, serviceDate) {
    const url = `https://www.queenslandrailtravel.com.au/SPWebApp/api/ServiceUpdates/GetService?serviceId=${serviceID}&serivceDate=${serviceDate}${serviceDate.includes("T") ? "" : "T00:00:00.000Z"}`;
    const response = await fetch(url);
    if (!response.ok) {
        const errorText = await response.text();
        logger.error(`Failed to fetch service data: ${response.status} ${response.statusText}`, {
            module: "qr-travel-tracker",
            function: "trackTrain",
            serviceID,
            url,
            status: response.status,
            statusText: response.statusText,
            errorText,
        });
        throw new Error(`Failed to fetch: ${response.status} ${response.statusText} ${url}. ${errorText}`);
    }
    const jsonObj = await response.json();
    return jsonObj;
}
export async function getPlaces() {
    let res = await fetch("https://www.queenslandrailtravel.com.au/SPWebApp/api/ContentQuery/GetItems", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            WebUrl: "https://www.queenslandrailtravel.com.au",
            ListName: "QRT Places",
            ViewFields: ["Title", "qrt_PlaceCode"],
            Filters: [],
            OrderByClauses: [{ Field: "Title", Direction: "Asc" }],
        }),
    });
    // This returns a string containing more json for some reason, so we parse it twice.
    let json = JSON.parse(await res.json());
    return json;
}
export async function getServiceLines() {
    let res = await fetch("https://www.queenslandrailtravel.com.au/SPWebApp/api/ServiceUpdates/AllServices");
    if (!res.ok) {
        logger.error(`Failed to fetch service lines: ${res.status} ${res.statusText}`, {
            module: "qr-travel-tracker",
            function: "getServiceLines",
            status: res.status,
            statusText: res.statusText,
        });
        throw new Error(`Failed to fetch: ${res.status} ${res.statusText}`);
    }
    let json = await res.json();
    return json.ServiceLines;
}
export async function getAllServices() {
    let res = await fetch("https://www.queenslandrailtravel.com.au/SPWebApp/api/ContentQuery/GetItems", {
        body: JSON.stringify({
            WebUrl: "https://www.queenslandrailtravel.com.au",
            ListName: "QRT Services",
            ViewFields: ["Title", "qrt_ServiceLine", "qrt_Direction", "qrt_Destination", "qrt_Origin"],
        }),
        headers: {
            "Content-Type": "application/json",
        },
        method: "POST",
    });
    // Return double-parsed JSON because the response is a string containing JSON.
    const responseText = await res.json();
    const json = JSON.parse(responseText);
    logger.debug(`Successfully fetched ${json.length} services`, {
        module: "qr-travel-tracker",
        function: "getAllServices",
        count: json.length,
    });
    return json;
}
export async function getServiceUpdates(startDate, endDate) {
    // Default startDate: first day of current month
    // Default endDate: one year after startDate
    const now = new Date();
    const defaultStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const defaultEnd = new Date(defaultStart);
    defaultEnd.setFullYear(defaultEnd.getFullYear() + 1);
    const start = startDate || defaultStart.toISOString().slice(0, 10);
    const end = endDate || defaultEnd.toISOString().slice(0, 10);
    let res = await fetch("https://www.queenslandrailtravel.com.au/SPWebApp/api/ContentQuery/GetItems", {
        body: JSON.stringify({
            WebUrl: "https://www.queenslandrailtravel.com.au/ServiceUpdates",
            ListName: "Pages",
            ViewFields: [
                "Title",
                "qrt_StartServiceDate",
                "qrt_EndServiceDate",
                "qrt_Status",
                "qrt_ServiceIds",
                "ContentType",
                "FileRef",
                "qrt_CoachReplacement",
                "qrt_SummaryMessage",
            ],
            Filters: [
                {
                    Field: "qrt_EndServiceDate",
                    Operand: "Geq",
                    FieldType: "DateTime",
                    IncludeTimeValue: false,
                    Values: [start + "T00:00:00+10:00"],
                    NextJoin: "And",
                },
                {
                    Field: "qrt_StartServiceDate",
                    Operand: "Leq",
                    FieldType: "DateTime",
                    IncludeTimeValue: false,
                    Values: [end + "T00:00:00+10:00"],
                    NextJoin: "And",
                },
            ],
            OrderByClauses: [{ Field: "qrt_Status", Direction: "Asc" }],
        }),
        method: "POST",
    });
    const responseText = await res.json();
    const json = JSON.parse(responseText);
    logger.debug(`Successfully fetched ${json.length} service updates`, {
        module: "qr-travel-tracker",
        function: "getServiceUpdates",
        count: json.length,
    });
    return json;
}
/**
 * Convert QR Travel service data to AugmentedTrip format
 */
function convertQRTServiceToTravelTrip(service, serviceResponse, direction, line) {
    // Find the Service object for more info
    const serviceMeta = serviceResponse;
    const gtfsStops = getGtfsStations();
    const stops = serviceResponse.TrainMovements.map((movement) => {
        // Calculate arrival and departure delays
        let arrivalDelaySeconds = null;
        let departureDelaySeconds = null;
        let delayString = "scheduled";
        let delayClass = "scheduled";
        if (movement.PlannedArrival &&
            movement.ActualArrival &&
            movement.PlannedArrival !== "0001-01-01T00:00:00" &&
            movement.ActualArrival !== "0001-01-01T00:00:00") {
            const plannedArr = new Date(movement.PlannedArrival).getTime();
            const actualArr = new Date(movement.ActualArrival).getTime();
            arrivalDelaySeconds = Math.round((actualArr - plannedArr) / 1000);
        }
        if (movement.PlannedDeparture &&
            movement.ActualDeparture &&
            movement.PlannedDeparture !== "0001-01-01T00:00:00" &&
            movement.ActualDeparture !== "0001-01-01T00:00:00") {
            const plannedDep = new Date(movement.PlannedDeparture).getTime();
            const actualDep = new Date(movement.ActualDeparture).getTime();
            departureDelaySeconds = Math.round((actualDep - plannedDep) / 1000);
            // Use departure delay for delayString/class
            const delaySecs = departureDelaySeconds;
            if (delaySecs !== null) {
                if (Math.abs(delaySecs) <= 60) {
                    delayString = "on time";
                    delayClass = "on-time";
                }
                else if (delaySecs > 0 && delaySecs <= 300) {
                    delayString = `${Math.round(delaySecs / 60)}m late`;
                    delayClass = "late";
                }
                else if (delaySecs > 300) {
                    delayString = `${Math.round(delaySecs / 60)}m late`;
                    delayClass = "very-late";
                }
                else {
                    delayString = `${Math.round(Math.abs(delaySecs) / 60)}m early`;
                    delayClass = "early";
                }
            }
        }
        let actualArrival = movement.ActualArrival == "0001-01-01T00:00:00" ? movement.PlannedArrival : movement.ActualArrival;
        let actualDeparture = movement.ActualDeparture == "0001-01-01T00:00:00" ? movement.PlannedDeparture : movement.ActualDeparture;
        let arrivalDelayInfo = getDelay(arrivalDelaySeconds, actualArrival === "0001-01-01T00:00:00" ? movement.PlannedArrival : actualArrival);
        let departureDelayInfo = getDelay(departureDelaySeconds, actualDeparture === "0001-01-01T00:00:00" ? movement.PlannedDeparture : actualDeparture);
        let gtfsStopId = null;
        let findRes = gtfsStops.find((v) => v.stop_name?.toLowerCase().replace("station", "").trim() ===
            movement.PlaceName.toLowerCase().replace("station", "").trim());
        if (findRes)
            gtfsStopId = findRes.stop_id;
        let toRet = {
            placeCode: movement.PlaceCode,
            placeName: movement.PlaceName,
            gtfsStopId,
            kStation: movement.KStation,
            status: movement.Status,
            trainPosition: movement.TrainPosition,
            plannedArrival: movement.PlannedArrival,
            plannedDeparture: movement.PlannedDeparture,
            actualArrival,
            actualDeparture,
            arrivalDelaySeconds,
            departureDelaySeconds,
            arrivalDelayClass: actualArrival === "0001-01-01T00:00:00" ? arrivalDelayInfo.delayClass : undefined,
            arrivalDelayString: actualArrival === "0001-01-01T00:00:00" ? arrivalDelayInfo.delayString : undefined,
            departureDelayClass: actualDeparture === "0001-01-01T00:00:00" ? departureDelayInfo.delayClass : undefined,
            departureDelayString: actualDeparture === "0001-01-01T00:00:00" ? departureDelayInfo.delayString : undefined,
        };
        return toRet;
    });
    const runChars = {
        Gulflander: "5",
    };
    return {
        run: service.Title.split(" ")[0].length == 4
            ? service.Title.split(" ")[0]
            : `${runChars[line] ?? "?"}${serviceMeta.ServiceId.slice(0, 3)}`,
        serviceId: serviceMeta.ServiceId,
        serviceName: service.Title,
        direction,
        line,
        status: serviceMeta.ServiceDisruption?.Status || "Scheduled",
        offersGoldClass: false, // Not available in QRTService, could be added if needed
        serviceDate: serviceMeta.Modified,
        departureDate: stops[0]?.plannedDeparture || "",
        stops,
        disruption: serviceMeta.ServiceDisruption,
    };
}
function getDelay(delaySecs = null, departureTime) {
    if (delaySecs === null || departureTime === null)
        return { delayString: "scheduled", delayClass: "scheduled" };
    let departsInSecs = Math.round(new Date(departureTime).getTime() - Date.now()) / 1000;
    departsInSecs = Math.round(departsInSecs / 60) * 60;
    const roundedDelay = delaySecs ? Math.round(delaySecs / 60) * 60 : null;
    const delayString = delaySecs != null && roundedDelay != null
        ? delaySecs == 0
            ? "on time"
            : `${Math.floor(roundedDelay / 3600)}h ${Math.floor((Math.abs(roundedDelay) % 3600) / 60)}m ${delaySecs > 0 ? "late" : "early"}`
                .replace(/^0h/, "")
                .trim()
        : "scheduled";
    const delayClass = delaySecs != null && roundedDelay != null
        ? roundedDelay > 0
            ? roundedDelay > 5 * 60
                ? "very-late"
                : "late"
            : roundedDelay < 0
                ? "early"
                : "on-time"
        : "scheduled";
    return { delayString, delayClass };
}
// Process each service line to get current services in parallel
async function processService(serviceLine, direction, service, services) {
    try {
        // Get detailed service information
        const serviceResponse = await trackTrain(service.ServiceId, service.ServiceDate);
        const gtfsStops = getGtfsStations();
        if (serviceResponse.Success) {
            // Find the corresponding QRT service for additional metadata
            const qrtService = services.find((s) => s.qrt_Direction == direction.DirectionName &&
                s.qrt_ServiceLine.endsWith(serviceLine.ServiceLineName));
            if (qrtService) {
                const travelTrip = convertQRTServiceToTravelTrip(qrtService, serviceResponse, direction.DirectionName, serviceLine.ServiceLineName);
                // Add SRT passing stops expansion
                // Map TravelStopTime[] to TrainMovementDTO[]
                const trainMovements = travelTrip.stops.map((s) => {
                    let gtfsStopId = null;
                    let findRes = gtfsStops.find((v) => v.stop_name?.toLowerCase().replace("station", "").trim() ===
                        s.placeName.toLowerCase().replace("station", "").trim());
                    if (findRes)
                        gtfsStopId = findRes.stop_id;
                    return {
                        PlaceCode: s.placeCode,
                        PlaceName: s.placeName,
                        gtfsStopId,
                        KStation: s.kStation,
                        Status: s.status,
                        TrainPosition: s.trainPosition,
                        PlannedArrival: s.plannedArrival,
                        PlannedDeparture: s.plannedDeparture,
                        ActualArrival: s.actualArrival,
                        ActualDeparture: s.actualDeparture,
                        ArrivalDelaySeconds: s.arrivalDelaySeconds || 0,
                        DepartureDelaySeconds: s.departureDelaySeconds || 0,
                    };
                });
                // Expand with SRT passing stops
                const expanded = expandWithSRTPassingStops(trainMovements);
                // Return the trip
                logger.debug(`Successfully processed service ${service.ServiceId}`, {
                    module: "qr-travel-tracker",
                    function: "getCurrentQRTravelTrains",
                });
                return {
                    ...travelTrip,
                    stopsWithPassing: expanded,
                };
            }
            else {
                logger.warn(`No matching QRT service found for service ${service.ServiceId}`, {
                    module: "qr-travel-tracker",
                    function: "getCurrentQRTravelTrains",
                });
                return null;
            }
        }
        else {
            logger.warn(`Service response not successful for service ${service.ServiceId}`, {
                module: "qr-travel-tracker",
                function: "getCurrentQRTravelTrains",
            });
            return null;
        }
    }
    catch (error) {
        logger.warn(`Failed to track service ${service.ServiceId}: ${error.message || error}`, {
            module: "qr-travel-tracker",
            function: "getCurrentQRTravelTrains",
        });
        return null;
    }
}
export async function getCurrentQRTravelTrains() {
    try {
        // Get all the required data
        const [services, serviceLines] = await Promise.all([getAllServices(), getServiceLines()]);
        const tasks = [];
        for (const serviceLine of serviceLines) {
            for (const direction of serviceLine.Directions) {
                for (const service of direction.Services) {
                    tasks.push(processService(serviceLine, direction, service, services));
                }
            }
        }
        const results = await Promise.all(tasks);
        const travelTrips = results.filter((trip) => trip !== null);
        return travelTrips;
    }
    catch (error) {
        logger.error(`Failed to get current QR Travel trains: ${error.message || error}`, {
            module: "qr-travel-tracker",
            function: "getCurrentQRTravelTrains",
            error: error.message || error,
        });
        throw error;
    }
}
