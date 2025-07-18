# TRAX - TransLink Rail (GTFS) API eXtended

This project provides a high-level API for accessing and working with TransLink's rail services data, including static GTFS and realtime updates.

## Features

- **GTFS Data Loading**: Easily load and cache GTFS data from TransLink's public API.
- **Realtime Updates**: Fetch and apply realtime updates for trip delays, cancellations, and vehicle positions.
- **Augmented Data Models**: Provides augmented data models for `Stop`, `Trip`, and `StopTime` that include additional useful information and lazy-loading capabilities.
- **Express and Passing Stop Calculation**: Automatically calculates express segments and passing stops for a given trip.
- **Service Date Calculation**: Determines the dates a trip is active based on the GTFS calendar.

## Drawbacks

- For the Redcliffe and Springfield lines (from Petrie and from Darra respectively), official sectional running times are not available  and instead are estimated, and thus passing stop times may not be accurate.

## Getting Started

### Prerequisites

- Node.js
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

The main entry point for the API is `index.ts`, which exports all the necessary functions and modules.

To use the API, you first need to load the GTFS data:

```typescript
import TRAX from './index.js';

async function main() {
  // Load the GTFS data (static and realtime)
  await TRAX.loadGTFS();

  // Get an augmented trip
  const trip = TRAX.getAugmentedTrips("33551352-QR 25_26-39954-D159")[0];

  // Display the trip information
  console.log(trip);
}

main();
```

The `test.ts` file contains an example of how to use the API to fetch and display trip information. You can run it with:

```bash
npm test
```

## API Overview

The `TRAX` object provides the following main functions and modules:

- `loadGTFS()`: Loads the static and realtime GTFS data.
- `getAugmentedTrips(trip_id)`: Returns an array of augmented trips.
- `getAugmentedStops(stop_id)`: Returns an array of augmented stops.
- `getStations()`: Returns a list of all train stations.
- `cache`: Provides access to the raw and augmented data caches.
- `calendar`: Provides functions for working with service dates.

### Augmented Models

- **`AugmentedTrip`**: Represents a trip with additional information like service dates, lazy-loaded stoptimes, and express run information.
- **`AugmentedStop`**: Represents a stop with lazy-loaded parent and child stops.
- **`AugmentedStoptime`**: Represents a stop time with both scheduled and actual (realtime) arrival/departure times, and propagation of delays.