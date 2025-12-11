# TRAX - TransLink Rail (GTFS) API eXtended

TRAX is a high-level TypeScript/Node.js API designed to interact with TransLink's Queensland Rail services data. It seamlessly integrates static GTFS schedules with GTFS-Realtime feeds (Trip Updates, Vehicle Positions, and Alerts) to provide a rich, unified view of the network.

Features include robust data augmentation, intelligent caching, express/passing stop calculations, and automatic realtime synchronization.

## Features

*   **Unified Data Model:** Treats static schedules and realtime updates as a single cohesive dataset. Access "Augmented" trips and stops that automatically reflect live delays, cancellations, and platform changes.
*   **Realtime Synchronization:** Built-in polling handles GTFS-Realtime feeds (Alerts, Trip Updates, Vehicle Positions) automatically, emitting events when data changes.
*   **Express & Passing Logic:** Algorithms to detect express segments and generate human-readable descriptions of stopping patterns (e.g., "Express between A and B").
*   **Data Augmentation:**
    *   **AugmentedTrips:** Combines static trip info with live updates.
    *   **AugmentedStops:** Live departure boards with real-time arrival estimates.
    *   **Run Series:** Groups related trips to track vehicle blocks and consistency.
*   **Optimized Caching:** In-memory caching with atomic swaps ensures high performance and data consistency during updates.
*   **Type-Safe:** Fully typed with TypeScript for reliable development.

## Installation

Install directly from the GitHub repository:

```bash
npm install https://github.com/SysPoe/TRAX
```

**Note:** TRAX depends on the [QDF-GTFS](https://github.com/SysPoe/QDF-GTFS) library for low-level GTFS parsing and database management. Ensure your environment is configured to support this dependency.

## Usage

### Basic Setup

Import TRAX and initialize the data loader. You can configure it to automatically refresh data in the background.

```typescript
import TRAX from "translink-rail-api";

async function start() {
    // Load static GTFS and fetch initial realtime data
    // Arguments: autoRefresh (bool), forceReload (bool), realtimeInterval (ms), staticInterval (ms)
    await TRAX.loadGTFS(true);

    console.log("TRAX is ready!");
}

start();
```

### Accessing Data

TRAX exposes "Augmented" objects which are the primary way to interact with the data.

```typescript
// Get a specific stop by ID (e.g., Central Station)
const stops = TRAX.getAugmentedStops("place_censta");
if (stops.length > 0) {
    const central = stops[0];

    // Get departures for the current day
    const departures = central.getDepartures(TRAX.today());

    departures.forEach(dep => {
        console.log(`Trip to ${dep.trip.headsign}: ${dep.arrival?.time} (${dep.realtimeState})`);
    });
}

// Get a specific trip
const tripId = "..."; // GTFS Trip ID
const trip = TRAX.getAugmentedTrips(tripId);
if (trip) {
    console.log(`Trip ${trip.tripId} is currently ${trip.delay} seconds late.`);
}
```

### API Reference

For a detailed explanation of all functions and types, please see the [API Reference](REFERENCE.md).

### Events

Listen for update events to trigger UI refreshes or other logic.

```typescript
TRAX.on("realtime-update-end", () => {
    console.log("Realtime data has been refreshed.");
});
```

## References & Related Projects

*   **GTFS Specification:** [https://gtfs.org/documentation/schedule/reference/](https://gtfs.org/documentation/schedule/reference/)
    *   The standard for public transportation schedules and geographic information.
*   **QDF-GTFS:** [https://github.com/SysPoe/QDF-GTFS](https://github.com/SysPoe/QDF-GTFS)
    *   The underlying library used by TRAX for GTFS parsing and SQL interactions.
*   **TRAX-GUI:** [https://github.com/SysPoe/TRAX-GUI](https://github.com/SysPoe/TRAX-GUI)
    *   An example web application implementing the TRAX API to display live train information.
