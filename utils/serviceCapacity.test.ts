import { _test } from "./serviceCapacity.js";
import { AugmentedTrip } from "./augmentedTrip.js";
import { AugmentedStopTime } from "./augmentedStopTime.js";
import assert from "assert";

const { getDayType, formatTimeBucket, getTripDirection } = _test;

function testGetDayType() {
    console.log("Testing getDayType...");
    assert.strictEqual(getDayType("20231023"), "Monday"); // Oct 23 2023 is Monday
    assert.strictEqual(getDayType("20231028"), "Saturday");
    assert.strictEqual(getDayType("20231029"), "Sunday/Public Holiday");
    console.log("PASS");
}

function testFormatTimeBucket() {
    console.log("Testing formatTimeBucket...");
    // 5:00 AM = 5 * 60 * 60 = 18000 seconds
    assert.strictEqual(formatTimeBucket(18000), "5:00 AM");
    // 5:07 AM = 18420 -> rounds to 5:00 or 5:15?
    // 7 mins is < 8, so down to 0.
    assert.strictEqual(formatTimeBucket(18000 + 7 * 60), "5:00 AM");
    // 5:08 AM -> rounds up to 5:15
    assert.strictEqual(formatTimeBucket(18000 + 8 * 60), "5:15 AM");
    // 13:00 = 1:00 PM
    assert.strictEqual(formatTimeBucket(13 * 3600), "1:00 PM");
    console.log("PASS");
}

function testGetTripDirection() {
    console.log("Testing getTripDirection...");
    
    // Mock StopTimes
    const stopTimes = [
        { 
            stop_sequence: 1, 
            scheduled_parent_station: { stop_id: "place_airport" } 
        },
        { 
            stop_sequence: 5, 
            scheduled_parent_station: { stop_id: "place_censta" } // Central
        },
        { 
            stop_sequence: 10, 
            scheduled_parent_station: { stop_id: "place_gc" } 
        }
    ] as any as AugmentedStopTime[];

    const trip = {
        _trip: { direction_id: 0 },
        stopTimes: stopTimes
    } as any as AugmentedTrip;

    // Before Central -> Inbound
    assert.strictEqual(getTripDirection(trip, 1), "Inbound");
    // At Central -> Outbound
    assert.strictEqual(getTripDirection(trip, 5), "Outbound");
    // After Central -> Outbound
    assert.strictEqual(getTripDirection(trip, 10), "Outbound");

    console.log("PASS");
}

async function run() {
    try {
        testGetDayType();
        testFormatTimeBucket();
        testGetTripDirection();
        console.log("All tests passed.");
    } catch (e) {
        console.error("Test Failed:", e);
        process.exit(1);
    }
}

run();
