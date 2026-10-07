# TRAX - GTFS API eXtended

TRAX is a high-level TypeScript/Node.js API designed to interact with various GTFS feeds. It seamlessly integrates static GTFS schedules with GTFS-Realtime feeds (Trip Updates, Vehicle Positions, and Alerts) to provide a rich, unified view of the network.

## Queensland Rail weekly MTP services

The SEQ and Australian rail networks include the bundled `qr-mtp` operational
feed. Weekly variants retain run numbers, passing points, holds, weekday patterns,
source PDF fingerprints and extraction review notes. Sections join across regions
and midnight only when their overlapping station times give a unique continuation
and their source editions share a validity period. Reused numbers and ambiguous
continuations remain separate variants.

These are review templates. They have no realtime positions and grant no passenger
boarding or alighting rights. Passenger departure lists continue to use passenger
feeds. Unknown coordinates remain null. Independently confirmed adjacent chart
rows add physical graph edges; partial trip patterns cannot create express-skip
edges. Exact station-name matches link shared SEQ locations.

The snapshot contains all 140 train-plan PDFs from the 5 October 2026 source
manifest, using each plan's newest successful extraction. It excludes the PDF
calendars and does not model public-holiday exceptions. Dated instances end at the
next source edition or one year beyond the manifest snapshot, whichever comes
first. Refresh the manifest and regenerate the snapshot before extending coverage.

Regenerate `data/region-specific/seq/mtp/weekly-services.{json,zip}` with the
sibling MTP converter's `test/weekly_services.py`. The JSON is bound to the ZIP by
SHA-256. `node test/mtp.js` loads every variant through the native parser and
checks its dated calls, holds and graph contributions.
