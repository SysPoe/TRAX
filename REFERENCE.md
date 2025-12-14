# TRAX API Reference

This document provides a detailed reference for the functions and types available in the TRAX API.

## Core Functions (Default Export)

The `TRAX` default export acts as the main entry point, aggregating core functionality, data accessors, and utility modules.

### Initialization & Configuration

#### `TRAX.loadGTFS(autoRefresh, forceReload, realtimeIntervalMs, staticIntervalMs)`

Initializes the library by loading static GTFS data and fetching the first batch of realtime data.

- **Parameters:**
    - `autoRefresh` (boolean, default: `false`): If true, sets up intervals to automatically refresh realtime and static data.
    - `forceReload` (boolean, default: `false`): (Internal use) Forces a reload of data.
    - `realtimeIntervalMs` (number, default: `60000`): Interval in milliseconds for refreshing realtime feeds (Trip Updates, Vehicle Positions, Alerts).
    - `staticIntervalMs` (number, default: `86400000`): Interval in milliseconds for refreshing static GTFS data (daily).
- **Returns:** `Promise<void>`
- **Example:**
    ```typescript
    await TRAX.loadGTFS(true, false, 30000); // Auto-refresh every 30 seconds
    ```

#### `TRAX.updateRealtime()`

Manually triggers a fetch and update of the realtime data feeds.

- **Returns:** `Promise<void>`

#### `TRAX.clearIntervals()`

Stops the automatic background refresh intervals started by `loadGTFS`. Useful for clean shutdown.

- **Returns:** `void`

### Data Accessors

All data accessors return "Augmented" objects which combine static schedule information with live realtime updates.

#### `TRAX.getAugmentedStops(stop_id?)`

Retrieves stops with added realtime capabilities (departure boards, parent/child relationships).

- **Parameters:**
    - `stop_id` (string, optional): The GTFS stop ID. If omitted, returns all stops.
- **Returns:** `AugmentedStop[]` (Array containing 0 or 1 item if ID is provided)

#### `TRAX.getAugmentedTrips(trip_id?)`

Retrieves trips with fused static and realtime data (delays, actual arrival times).

- **Parameters:**
    - `trip_id` (string, optional): The GTFS trip ID. If omitted, returns all trips.
- **Returns:** `AugmentedTrip[]`

#### `TRAX.getAugmentedStopTimes(trip_id?)`

Retrieves stop times (schedule + realtime) for a specific trip or all trips.

- **Parameters:**
    - `trip_id` (string, optional): The trip ID to fetch stop times for.
- **Returns:** `AugmentedStopTime[]`

#### `TRAX.getRunSeries(date, runSeries, calcIfNotFound?)`

Retrieves or calculates a "Run Series" (a sequence of trips performed by a single physical train/consist) for a given date and run number.

- **Parameters:**
    - `date` (string): YYYYMMDD date string.
    - `runSeries` (string): The 4-digit run number (e.g., "1001").
    - `calcIfNotFound` (boolean, default: `true`): Whether to attempt calculating the series if not cached.
- **Returns:** `RunSeries`

#### `TRAX.getStations()`

Returns a list of all rail stations defined in the system.

- **Returns:** `AugmentedStop[]`

#### `TRAX.getRawTrips(trip_id?)`, `TRAX.getRawStops(stop_id?)`, `TRAX.getRawRoutes(route_id?)`

Access the underlying raw GTFS objects without augmentation.

- **Returns:** `Trip[]`, `Stop[]`, or `Route[]`

#### `TRAX.getStopTimeUpdates(trip_id)`

Get raw GTFS-Realtime stop time updates for a specific trip.

- **Returns:** `RealtimeStopTimeUpdate[]`

#### `TRAX.getVehiclePositions(trip_id?)`

Get raw GTFS-Realtime vehicle positions.

- **Returns:** `RealtimeVehiclePosition[]`

### Utilities

#### `TRAX.formatTimestamp(ts)`

Formats a GTFS timestamp (seconds from midnight) into `HH:MM`.

- **Parameters:** `ts` (number)
- **Returns:** `string` (e.g., "14:30")

#### `TRAX.today()`

Returns the current date in TransLink/GTFS compatible format (YYYYMMDD), adjusting for timezone offset (approx UTC+10).

- **Returns:** `string` (e.g., "20231027")

### Events

TRAX emits events to notify listeners of data updates.

- `realtime-update-start`: Triggered when a realtime refresh begins.
- `realtime-update-end`: Triggered when a realtime refresh completes.
- `static-update-start`: Triggered when a static data reload begins.
- `static-update-end`: Triggered when a static data reload completes.

**Usage:**

```typescript
TRAX.on("realtime-update-end", () => console.log("Data updated!"));
```

---

## Type Definitions

### `AugmentedStop`

Represents a station or stop, enriched with methods to query live departures.

- **Properties:**
    - ...Standard GTFS Stop properties (`stop_id`, `stop_name`, `stop_lat`, etc.)
    - `parent`: `AugmentedStop | null` - The parent station object.
    - `children`: `AugmentedStop[]` - List of child stops (e.g., platforms).
    - `qrt_Place`: `boolean` - Whether this stop matches a Queensland Rail Travel place.
- **Methods:**
    - `getDepartures(date, start_time, end_time)`: Returns a list of departures between two times.
        - `date`: "YYYYMMDD"
        - `start_time`: "HH:MM:SS"
        - `end_time`: "HH:MM:SS"
        - **Returns:** `(AugmentedStopTime & { express_string: string })[]`

### `AugmentedTrip`

Represents a transit trip with live status.

- **Properties:**
    - `stopTimes`: `AugmentedStopTime[]` - The sequence of stops for this trip, including live times.
    - `expressInfo`: `ExpressInfo[]` - Calculated express segments (where the train skips stops).
    - `runSeries`: `RunSeries` - Information about the sequence of trips this train performs.
    - `actualTripDates`: `string[]` - List of dates (YYYYMMDD) this trip actually runs (accounting for cancellations/additions).
    - `run`: `string` - The 4-character run ID (e.g., "1098").
    - `scheduleRelationship`: Enum (Scheduled, Added, Unsched, Canceled).

### `AugmentedStopTime`

Represents a specific stop on a trip, merging schedule and realtime data.

- **Properties:**
    - `stop_id`, `stop_sequence`: GTFS identifiers.
    - `actual_arrival_time`: `number` (seconds from midnight) - The best estimate or actual time of arrival.
    - `actual_departure_time`: `number` - The best estimate or actual time of departure.
    - `scheduled_arrival_time`: `number` - The original timetable time.
    - `scheduled_departure_time`: `number` - The original timetable time.
    - `actual_platform_code`: `string` - The live platform assignment.
    - `realtime`: `boolean` - `true` if live data is affecting this stop.
    - `realtime_info`: Object containing delay details:
        - `delay_secs`: `number` - Delay in seconds (positive = late, negative = early).
        - `delay_string`: `string` - Human readable (e.g., "5m late").
        - `delay_class`: `"on-time" | "late" | "early" | ...` - CSS-friendly class name.
    - `passing`: `boolean` - `true` if the train passes this stop without stopping (interpolated stop).

### `ExpressInfo`

Describes a segment of a trip where stops might be skipped.

- **Properties:**
    - `type`: `"express" | "local" | "unknown_segment"`
    - `from`: `string` (Stop ID)
    - `to`: `string` (Stop ID)
    - `skipping`: `string[]` - List of Stop IDs skipped in this segment.

### `RunSeries`

Represents a block of trips operated by the same physical vehicle.

- **Properties:**
    - `series`: `string` - The identifier for the series.
    - `date`: `string` - The service date.
    - `trips`: Array of objects:
        - `trip_id`: `string`
        - `trip_start_time`: `number`
        - `run`: `string`

## Namespaces

TRAX exports several namespaces for specific functionalities:

- `TRAX.stations`: Utilities for listing and filtering stations.
- `TRAX.calendar`: Helpers for interpreting GTFS calendars and service dates.
- `TRAX.express`: Algorithms for determining express stopping patterns.
- `TRAX.qrTravel`: Interface for Queensland Rail Travel specific data types.
- `TRAX.utils.time`: Helpers for time difference calculations (`timeDiff`, `secTimeDiff`).
