const UP_ONE_DOWN_TWO = new Set([
	"Ardeer", "Deer Park", "Tarneit", "Wyndham Vale", "Little River", "Lara", "Corio", "North Shore",
	"North Geelong", "Bacchus Marsh", "Melton", "Cobblebank", "Rockbank", "Caroline Springs", "Donnybrook",
	"Wallan", "Heathcote Junction", "Wandong", "Kilmore East", "Broadford", "Tallarook", "Avenel", "Euroa",
	"Violet Town", "Springhurst", "Chiltern", "Clayton", "Berwick", "Pakenham", "Nar Nar Goon", "Tynong",
	"Garfield", "Drouin", "Warragul", "Yarragon",
]);
const SINGLE = new Set([
	"South Geelong", "Marshall", "Waurn Ponds", "Winchelsea", "Birregurra", "Colac", "Camperdown", "Terang",
	"Sherwood Park", "Warrnambool", "Beaufort", "Creswick", "Clunes", "Talbot", "Maryborough", "Malmsbury",
	"Eaglehawk", "Raywood", "Dingee", "Pyramid", "Kerang", "Swan Hill", "Epsom", "Huntly", "Goornong",
	"Elmore", "Rochester", "Echuca", "Nagambie", "Murchison East", "Mooroopna", "Shepparton", "Wangaratta",
	"Wodonga", "Bunyip", "Longwarry", "Trafalgar", "Moe", "Morwell", "Traralgon", "Rosedale", "Sale",
	"Stratford", "Bairnsdale", "Stawell", "Horsham", "Dimboola", "Nhill", "Bordertown", "Murray Bridge",
]);

/** Conservative last-resort platform guess. Callers must label this inferred. */
export function inferVLinePlatform(stationName: string, directionId: number | null): string | null {
	const name = stationName.replace(/\s+(Railway\s+)?Station.*$/i, "").trim();
	const up = directionId === 1;
	if (SINGLE.has(name)) return "1";
	if (UP_ONE_DOWN_TWO.has(name)) return up ? "1" : "2";
	if (name === "Footscray" || name === "Sunshine") return up ? "3" : "4";
	if (name === "Geelong") return up ? "3" : "1";
	return null;
}

