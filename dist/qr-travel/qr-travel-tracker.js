// For SRT passing stop expansion
import { expandWithSRTPassingStops } from "../utils/SectionalRunningTimes/metroSRTTravelTrain.js";
// Main function to fetch and parse the XML file
export async function trackTrain(serviceID, serviceDate) {
    const url = `https://www.queenslandrailtravel.com.au/SPWebApp/api/ServiceUpdates/GetService?serviceId=${serviceID}&serivceDate=${serviceDate}${serviceDate.includes("T") ? "" : "T00:00:00.000Z"}`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.status} ${response.statusText} ${url}. ${await response.text()}`);
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
            ViewFields: [
                "Title",
                "qrt_ServiceLine",
                "qrt_Direction",
                "qrt_Destination",
                "qrt_Origin",
            ],
        }),
        headers: {
            "Content-Type": "application/json",
        },
        method: "POST",
    });
    // Return double-parsed JSON because the response is a string containing JSON.
    return JSON.parse(await res.json());
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
    return JSON.parse(await res.json());
}
/**
 * Convert QR Travel service data to AugmentedTrip format
 */
function convertQRTServiceToTravelTrip(service, serviceResponse, direction, line) {
    // Find the Service object for more info
    const serviceMeta = serviceResponse;
    const stops = serviceResponse.TrainMovements.map((movement) => {
        // Calculate arrival and departure delays
        let arrivalDelaySeconds = null;
        let departureDelaySeconds = null;
        let delayString = "scheduled";
        let delayClass = "scheduled";
        if (movement.PlannedArrival && movement.ActualArrival && movement.PlannedArrival !== "0001-01-01T00:00:00" && movement.ActualArrival !== "0001-01-01T00:00:00") {
            const plannedArr = new Date(movement.PlannedArrival).getTime();
            const actualArr = new Date(movement.ActualArrival).getTime();
            arrivalDelaySeconds = Math.round((actualArr - plannedArr) / 1000);
        }
        if (movement.PlannedDeparture && movement.ActualDeparture && movement.PlannedDeparture !== "0001-01-01T00:00:00" && movement.ActualDeparture !== "0001-01-01T00:00:00") {
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
        return {
            placeCode: movement.PlaceCode,
            placeName: movement.PlaceName,
            kStation: movement.KStation,
            status: movement.Status,
            trainPosition: movement.TrainPosition,
            plannedArrival: movement.PlannedArrival,
            plannedDeparture: movement.PlannedDeparture,
            actualArrival: movement.ActualArrival == "0001-01-01T00:00:00" ? movement.PlannedArrival : movement.ActualArrival,
            actualDeparture: movement.ActualDeparture == "0001-01-01T00:00:00" ? movement.PlannedDeparture : movement.ActualDeparture,
            arrivalDelaySeconds,
            departureDelaySeconds,
            delayString,
            delayClass,
        };
    });
    return {
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
export async function getCurrentQRTravelTrains() {
    try {
        // Get all the required data
        const [services, serviceLines] = await Promise.all([
            getAllServices(),
            getServiceLines()
        ]);
        const travelTrips = [];
        const today = new Date().toISOString().slice(0, 10);
        // Process each service line to get current services
        for (const serviceLine of serviceLines) {
            for (const direction of serviceLine.Directions) {
                for (const service of direction.Services) {
                    // Only process services for today
                    if (service.ServiceDate.slice(0, 10) === today) {
                        try {
                            // Get detailed service information
                            const serviceResponse = await trackTrain(service.ServiceId, service.ServiceDate);
                            if (serviceResponse.Success) {
                                // Find the corresponding QRT service for additional metadata
                                const qrtService = services.find((s) => s.qrt_Direction == direction.DirectionName &&
                                    s.qrt_ServiceLine.endsWith(serviceLine.ServiceLineName));
                                if (qrtService) {
                                    const travelTrip = convertQRTServiceToTravelTrip(qrtService, serviceResponse, direction.DirectionName, serviceLine.ServiceLineName);
                                    // Add SRT passing stops expansion (SEQ region only)
                                    // Map TravelStopTime[] to TrainMovementDTO[]
                                    const trainMovements = travelTrip.stops.map(s => ({
                                        PlaceCode: s.placeCode,
                                        PlaceName: s.placeName,
                                        KStation: s.kStation,
                                        Status: s.status,
                                        TrainPosition: s.trainPosition,
                                        PlannedArrival: s.plannedArrival,
                                        PlannedDeparture: s.plannedDeparture,
                                        ActualArrival: s.actualArrival,
                                        ActualDeparture: s.actualDeparture,
                                    }));
                                    // Expand with SRT passing stops
                                    const expanded = expandWithSRTPassingStops(trainMovements);
                                    // Attach to the trip
                                    travelTrips.push({ ...travelTrip, stopsWithPassing: expanded });
                                }
                            }
                        }
                        catch (error) {
                            console.warn(`Failed to track service ${service.ServiceId}:`, error);
                            // Continue processing other services
                        }
                    }
                }
            }
        }
        return travelTrips;
    }
    catch (error) {
        console.error("Failed to get current QR Travel trains:", error);
        throw error;
    }
}
