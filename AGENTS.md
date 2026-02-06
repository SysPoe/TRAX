# AGENTS.md

This file contains guidelines for agentic coding agents working on the TRAX codebase.

## Build, Lint, and Test Commands

```bash
# Build entire project (AssemblyScript + TypeScript)
npm run build

# Build AssemblyScript only
npm run asbuild           # Both debug and release
npm run asbuild:debug     # Debug build only
npm run asbuild:release   # Release build only

# Format code
npm run format            # Runs Prettier with .prettierrc config

# Run tests
npm run test              # Executes node tests

# Start development server
npm run start             # Serves the project directory
```

**Running Single Tests:**
Tests are plain JavaScript files in the `test/` directory. Run a single test file directly:

```bash
node test/translink.js
node test/gtha.js
```

**No dedicated lint command exists** - TypeScript compilation with `strict: true` acts as the linter.

## Code Style Guidelines

### Formatting (Prettier)

- **Tabs, not spaces** (tabWidth: 4)
- **Semicolons: required**
- **Quotes: double quotes only**
- **Trailing commas: all**
- **Print width: 120**
- Run `npm run format` before committing

### TypeScript Configuration

- Target: ESNext
- Module: NodeNext (requires `.js` extensions in imports)
- Strict mode enabled
- Always use type imports: `import type { SomeType } from "..."`
- Export types for all public APIs

### Import Style

```typescript
// Named imports (preferred)
import * as cache from "./cache.js";
import { AugmentedTrip } from "./utils/augmentedTrip.js";

// Type imports
import type { CacheContext, AugmentedStop } from "./cache.js";

// Default imports for single exports
import logger from "./utils/logger.js";
import TRAX from "./index.js";
```

### Naming Conventions

- **Classes:** PascalCase (`TRAX`, `LRUCache`, `Logger`)
- **Functions/Variables:** camelCase (`getAugmentedTrips`, `augmentTrip`)
- **Types/Interfaces:** PascalCase (`AugmentedTrip`, `CacheContext`, `TraxConfig`)
- **Constants:** UPPER_SNAKE_CASE (`PRESETS`, `VIA_MERGE_STOPS`)
- **Private members:** camelCase (private properties, no underscore prefix required)
- **Files:** kebab-case for folders (optional), camelCase for TS files

### Function Naming Patterns

- `get...` - Retrieve data from cache or GTFS (`getAugmentedTrips`, `getRawStops`)
- `create...` - Create new objects/instances (`createEmptyRawCache`, `createInstance`)
- `augment...` - Transform raw data into augmented form (`augmentTrip`, `augmentStop`)
- `refresh...` - Reload data from source (`refreshStaticCache`, `refreshRealtime`)
- `register...` / `unregister...` - Update index structures

### Type Definitions

```typescript
// Type exports alongside implementation
export type AugmentedTrip = qdf.Trip & {
	instances: AugmentedTripInstance[];
};

// Context types pass config and caches
export type CacheContext = {
	raw: RawCache;
	augmented: AugmentedCache;
	config: TraxConfig;
	gtfs?: GTFS;
};
```

### Error Handling

```typescript
try {
	await someAsyncOperation();
} catch (error: any) {
	logger.error("Error description: " + (error.message ?? error), {
		module: "filename",
		function: "functionName",
	});
}
```

### Logging

- Import logger from `./utils/logger.js`
- Always include context with module and function names
- Log levels: ERROR, WARN, INFO, DEBUG, TIMING

```typescript
logger.debug("Message", { module: "cache", function: "refreshStaticCache" });
logger.info("Operation completed", { module: "index", function: "loadGTFS" });
```

### Comments

- Use JSDoc comments for public API methods
- No comments in code unless asked
- Keep comments concise and purposeful

### Project Architecture

- **GTFS Interface Layer** - `gtfsInterfaceLayer.ts` - Manages GTFS feed loading
- **Cache System** - `cache.ts` - Central data augmentation and storage (LRU cache, Maps)
- **Utils** - Helper modules in `utils/` directory (augmentation, time, stations, etc.)
- **Region-Specific** - Code in `region-specific/{region}/` for AU/SEQ, CA, CA/GTHA
- **AssemblyScript** - `assembly/` for WASM performance-critical code

### Cache Patterns

- Use `Map<string, T>` for O(1) lookups (`tripsRec`, `stopsRec`)
- Use `LRUCache<K, V>` for size-limited caches (`expressInfoCache`, `passingStopsCache`)
- Cache keys use patterns like `${stopId}|${serviceDate}`
- Raw stop times are cached per-trip in `rawStopTimesCache`

### Timing and Performance

- Use `ctx.augmented.timer.start/stop` for performance tracking
- Progress reporting via `logger.progress()` for long operations
- Chunk processing (default 250) with `setImmediate` for async yielding
- **Performance Tip:** Set `disableTimers: true` in config for production to eliminate timing overhead (~5% speedup)

### Config Resolution

- Use `resolveConfig()` to merge user options with defaults
- Region presets in `PRESETS` object
- Config passed through `CacheContext` to all augmentation functions
- Performance config option: `disableTimers` (default: false)

### Test Files

- Located in `test/` directory (plain JavaScript)
- Import built code from `dist/` directory
- Example test: `node test/translink.js`
