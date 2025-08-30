import TRAX from ".";
import * as gtfs from "gtfs";
import fs from "fs";

async function main() {
  await TRAX.loadGTFS(false, false);
  let runs = TRAX.getRawTrips().map(v => v.trip_id.slice(-4)).sort();
  console.log("-------- 1 --------\n", [...new Set(runs.map(v => v[0]))].sort().join(", "));
  console.log("-------- 2 --------\n", [...new Set(runs.map(v => v[1]))].sort().join(", "));
  console.log("-------- 3 --------\n", [...new Set(runs.map(v => v[2]))].sort().join(", "));
  console.log("-------- 4 --------\n", [...new Set(runs.map(v => v[3]))].sort().join(", "));

  console.log("-------------");
  
  for(const v of [...new Set(runs.map(v => v[1]))].sort()) {
    let destos: string[] = TRAX.getRawTrips().filter(h => h.trip_id.slice(-4)[1] == v).map(v => v.trip_headsign) as any as string[];
    let count: { [key: string]: number } = {};
    for(const dest of destos) {
      if(!count[dest]) count[dest] = 0;
      count[dest]++;
    }
    console.log(v, Object.entries(count).filter(v => v[1] > 10).sort((a, b) => b[1] - a[1]).map(v => `${v[0]} (${v[1]})`).join(", "));
  }
}
main();
