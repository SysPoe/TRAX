
# TRAX - TransLink Rail (GTFS) API eXtended

TRAX is a high-level TypeScript/Node.js API for accessing and working with TransLink's Queensland Rail services data, including both static GTFS and realtime updates. It provides powerful data augmentation, caching, and express/passing stop calculations for advanced timetable and live train information.
TRAX is a high-level TypeScript/Node.js API for accessing and working with TransLink's Queensland Rail services data, including both static GTFS and realtime updates. It provides powerful data augmentation, caching, and express/passing stop calculations for advanced timetable and live train information.


## Features

- **GTFS Data Loading**: Load and cache static GTFS data from TransLink's public API.
- **Realtime Updates**: Fetch and apply realtime updates for trip delays, cancellations, and vehicle positions.
- **Augmented Data Models**: Use enhanced models for `Stop`, `Trip`, and `StopTime` with extra info and lazy-loading.
- **Express and Passing Stop Calculation**: Automatically determine express segments and passing stops for any trip.
- **Service Date Calculation**: Find all dates a trip is active using the GTFS calendar.
- **Sectional Running Times**: Built-in QR sectional running time matrix for accurate timing between stations.


## Limitations

- For the Redcliffe and Springfield lines (from Petrie and from Darra respectively), as well as between Robina and Varsity Lakes, official sectional running times are not available and have been manually estimated using timetables, so passing stop times may not be entirely accurate.
- Not all GTFS data is implemented, so you may need to manually access GTFS by importing the `gtfs` module directly for some use cases. This project uses node-gtfs ([gh](https://github.com/blinktaginc/node-gtfs); [npm](https://www.npmjs.com/package/gtfs)) under the hood.


## Getting Started

### Prerequisites

- Node.js (v16+ recommended)
- npm

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/SysPoe/TRAX.git
   cd TRAX
   ```
2. Install dependencies:
   ```bash
   npm install
   ```

### Usage

The main entry point for the API is `index.ts`, which exports all main functions and modules as a single `TRAX` object.

To use the API, first load the GTFS data:

```typescript
import TRAX from './index.js';

async function main() {
  // Load static and realtime GTFS data
  await TRAX.loadGTFS();

  // Get an augmented trip by trip_id
  const trip = TRAX.getAugmentedTrips("33551352-QR 25_26-39954-D159")[0];
  console.log(trip);
}

main();
```

See `test.ts` for a more detailed example, including how to fetch and display departures for a station:

```bash
npm test
```



## API Overview

The `TRAX` object provides the following main functions and modules:

- `loadGTFS(refresh = false, forceReload = false)`: Loads static and realtime GTFS data. Call this before using other functions.
  ```typescript
  await TRAX.loadGTFS();
  
  // Refresh static GTFS data every 24 hours and realtime data every 60 seconds:
  await TRAX.loadGTFS(true, false);

  // Force reload static GTFS data even if db.sqlite exists
  await TRAX.loadGTFS(false, true);

  // Force reload static GTFS data and refresh by interval
  await TRAX.loadGTFS(true, true);
  ```

- `updateRealtime()`: Manually refreshes realtime GTFS data.
  ```typescript
  await TRAX.updateRealtime();
  ```

- `getAugmentedTrips(trip_id?)`: Returns an array of augmented trips, optionally filtered by `trip_id`.
  ```typescript
  const allTrips: Trax.AugmentedTrip[] = TRAX.getAugmentedTrips();
  const specificTrip: TRAX.AugmentedTrip? = TRAX.getAugmentedTrips("trip_id")[0];
  ```

- `getAugmentedStops(stop_id?)`: Returns an array of augmented stops, optionally filtered by `stop_id`.
  ```typescript
  const allStops: Trax.AugmentedStop[] = TRAX.getAugmentedStops();
  const station: Trax.AugmentedStop? = TRAX.getAugmentedStops("place_romsta")[0];
  ```

- `getStations()`: Returns a list of all train stations in SEQ.
  ```typescript
  const stationIds: TRAX.AugmentedStop[] = TRAX.getStations();
  ```

- `getRaw...()`: Access to cached raw GTFS information.
  ```typescript
  // import type * as gtfs from "gtfs"
  const trips: gtfs.Trip[] = TRAX.getRawTrips();
  const trip: gtfs.Trip? = TRAX.getRawTrips("trip_id")[0];

  const stops: gtfs.Stop[] = TRAX.getRawStops();
  const stop: gtfs.Stop? = TRAX.getRawStops("stop_id")[0];

  const stopTimes: gtfs.StopTime[] = TRAX.getRawStopTimes();
  const stopTime: gtfs.StopTime[] = TRAX.getRawStopTimes("trip_id");

  const stopTimeUpdates: gtfs.StoptimeUpdate[] = TRAX.getStopTimeUpdates();
  const vehiclePositions: gtfs.VehiclePosition[] = TRAX.getVehiclePositions();  
  ```

- `calendar`: Functions for working with service dates and calendar info.
  ```typescript
  // Example: check if a service is active on a date
  const serviceDates = TRAX.calendar.getServiceDatesByTrip("trip_id")
  ```

- `formatTimestamp(ts)`: Formats a timestamp in seconds since midnight as "HH:MM".
  ```typescript
  const formatted = TRAX.formatTimestamp(37800); // "10:30"
  ```

### Augmented Models

- **`AugmentedTrip`**: Represents a train trip with the following properties and methods:
  - `trip_id: string`, `route_id: string`, `service_id: string`, `direction_id: string`, `block_id: string`: Standard GTFS trip fields. See the [GTFS Documentation](https://gtfs.org/documentation/overview/).
  - `serviceDates: number[]`: Array of dates (YYYYMMDD) when this trip operates.
  - `stopTimes: AugmentedStopTime[]`: Array of `AugmentedStopTime` objects for this trip (lazy-loaded). It is important to note that this applies to all service dates and includes realtime data, so if the date you want the StopTimes for is not today, use the scheduled information instead of actual or realtime.
  - `expressSegments`: Array of segments where the train runs express (skips stops).
  - `getStopTimes()`: Loads and returns all stop times for this trip.
  - `getExpressSegments()`: Returns express/passing stop segments for this trip.
  - `realtimeStatus`: Object with current delay, cancellation, and vehicle position (if available).

- **`AugmentedStop`**: Represents a station or stop with the following properties and methods:
  - `stop_id`: The unique GTFS stop identifier.
  - `stop_name`, `stop_lat`, `stop_lon`: Standard GTFS stop fields.
  - `parent_station`: The parent station (if this is a platform or child stop).
  - `child_stops`: Array of child stops/platforms (if any).
  - `isStation`: Boolean, true if this stop is a main station.
  - `getDepartures(date, start_time, end_time)`: Returns departures from this stop for a given date and time window, as an array of `AugmentedStopTime` objects.
  - `getTrips()`: Returns all `AugmentedTrip` objects serving this stop.

- **`AugmentedStopTime`**: Represents a scheduled or realtime stop event with the following properties and methods:
  - `trip_id`, `stop_id`, `stop_sequence`: Standard GTFS stop time fields.
  - `arrival_time`, `departure_time`: Scheduled times (seconds since midnight).
  - `actual_arrival_time`, `actual_departure_time`: Realtime-adjusted times (if available).
  - `delay`: Current delay in seconds (if available).
  - `isPassing`: Boolean, true if the train passes this stop without stopping.
  - `isExpress`: Boolean, true if this stop is part of an express segment.
  - `serviceDate`: The date (YYYYMMDD) for this stop time.
  - `getTrip()`: Returns the parent `AugmentedTrip` object.
  - `getStop()`: Returns the parent `AugmentedStop` object.

### How it Works

- **Caching**: Static and realtime GTFS data is cached in memory for fast access. Use `refreshStaticCache()` and `refreshRealtimeCache()` to manually refresh if needed.
- **Caching**: Static and realtime GTFS data is cached in memory for fast access. Use `refreshStaticCache()` and `refreshRealtimeCache()` to manually refresh if needed.
- **Augmentation**: Raw GTFS objects are wrapped with extra info and methods for easier querying and analysis.
- **Express/Passing Stops**: The library automatically determines which stops are passed (not stopped at) and calculates their times using QR's sectional running times.