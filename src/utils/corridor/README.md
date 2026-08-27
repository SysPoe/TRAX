# Corridor resolver

The corridor resolver chooses the physical path for one journey. It is shape-first, gap-local, conservative, declarative, and provider-agnostic.

`resolveJourneyCorridor(journey, ctx)` is the module interface. The caller supplies a qualified `JourneyContext` and receives one `CorridorResolution`. Adapters translate provider data into that context and consume the result.

## Invariants

1. An exact shape owns physical routing when it covers a gap with confidence.
2. A valid `shape_dist_traveled` value outranks coordinate projection only on the journey's exact qualified shape; it is not transferable to compatible or borrowed shapes.
3. The resolver handles each pair of consecutive anchors independently.
4. Fallback shapes and patterns stay scoped to feed, route, direction, and service date when those values exist.
5. The resolver borrows geometry only through `geometrySources` configuration.
6. Provider knowledge enters as an adapter or as generic manual network data.
7. SRT data supplies timing weights after the resolver chooses the path.
8. An ambiguous gap is `unresolved` and adds no synthetic station.
9. A synthetic station cannot move backwards, duplicate another synthetic station, or revisit another scheduled anchor.
10. Realtime stop updates overlay the resolved scheduled corridor.
11. Express information and passing rows come from the same resolution.
12. Indexes and resolution caches belong to `CacheContext.augmented`.
13. Shape, trip, route, station, manual-network, and resolver identities include their feed or source namespace.
14. A journey-wide validation pass rejects repeated synthetic stations after gap-local providers return their candidates.

## Evidence order

For each gap, the resolver tries the following evidence in order:

1. exact shape;
2. authoritative declarative corridor or topology;
3. compatible or explicitly borrowed shape consensus;
4. fallback declarative corridor or topology;
5. active route and direction pattern consensus with a unique longer ordered supersequence;
6. unresolved.

A weaker result never replaces a resolved stronger result for the same gap.

## Cache ownership

`buildCorridorIndex()` runs when the static cache is refreshed. It indexes station parent and platform coordinates, qualified shapes, projections, and route patterns. `corridorResolutionCache` keys the complete journey context, resolver version, geometry-source configuration, and manual-network versions.

## Timing

`timing.ts` hides manual operational waypoints from passenger rows but keeps their legs in the timing path. Timing uses configured manual edge values, observed SRT values, active-pattern durations, resolved geometric distances, and equal weights in that order. Timing records keep the visible node, interpolation weight, known minutes, and instant together so filtering cannot shift a time onto another station.
