export const SOURCE_C_LOOKAHEAD_SECS = 7200;
export const SOURCE_D_LOOKAHEAD_SECS = 600;

export const SOURCE_E_REFERRER = "https://www.gotracker.ca/gotracker/web/";
export const SOURCE_E_EXCLUDED_STOPS = new Set(["PA", "UN"]);

export const SOURCE_C_IDS = ["UN", "PA", "BL", "MD", "WE"];

export const SOURCE_E_STOP_CONVERSION: Record<string, string[]> = {
	UN: ["BR", "GT", "LE", "LW", "ST"],
	DW: ["BR"],
	RU: ["BR"],
	MP: ["BR"],
	KC: ["BR"],
	AU: ["BR"],
	NE: ["BR"],
	EA: ["BR"],
	BD: ["BR"],
	BA: ["BR"],
	AD: ["BR"],
	BL: ["GT"],
	MD: ["GT"],
	WE: ["GT"],
	MA: ["GT"],
	BE: ["GT"],
	BR: ["GT"],
	MO: ["GT"],
	GE: ["GT"],
	AC: ["GT"],
	GL: ["GT"],
	KI: ["GT"],
	DA: ["LE"],
	SC: ["LE"],
	EG: ["LE"],
	GU: ["LE"],
	RO: ["LE"],
	PIN: ["LE"],
	AJ: ["LE"],
	WH: ["LE"],
	OS: ["LE"],
	EX: ["LW"],
	MI: ["LW"],
	LO: ["LW"],
	PO: ["LW"],
	CL: ["LW"],
	OA: ["LW"],
	BO: ["LW"],
	AP: ["LW"],
	BU: ["LW"],
	AL: ["LW"],
	WR: ["LW"],
	CF: ["LW"],
	SCTH: ["LW"],
	NI: ["LW"],
	KE: ["ST"],
	AG: ["ST"],
	MK: ["ST"],
	UI: ["ST"],
	CE: ["ST"],
	MR: ["ST"],
	MJ: ["ST"],
	ST: ["ST"],
	LI: ["ST"],
};

export const SOURCE_A_URL = "https://www.gotracker.ca/gotracker/mobile/proxy/web/AVL/InService/Trip2/All";
export const SOURCE_B_URL = "https://www.gotracker.ca/gotracker/mobile/proxy/web/Schedule/Today/All";
export const SOURCE_C_URL_TEMPLATE = (stop_id: string) =>
	`https://api.metrolinx.com/external/upe/tdp/up/departures/${stop_id}`;
export const SOURCE_D_URL_TEMPLATE = (stop_id: string) =>
	`https://api.metrolinx.com/external/go/departures/stops/${stop_id}/departures?page=1&pageLimit=10`;
export const SOURCE_E_URL_TEMPLATE = (code: string, stop_id: string) =>
	`https://www.gotracker.ca/gotracker/mobile/proxy/web/Messages/Signage/Rail/${code}/${stop_id}`;
export const SOURCE_F_URL = "https://www.transsee.ca/fleetfind?a=gotrain";

const MINUTES = 60 * 1000;
export const SOURCE_A_THROTTLE_MS = 1 * MINUTES;
export const SOURCE_B_THROTTLE_MS = 15 * MINUTES;
export const SOURCE_CD_THROTTLE_MS = 1 * MINUTES;
export const SOURCE_E_THROTTLE_MS = 2 * MINUTES;
export const SOURCE_F_THROTTLE_MS = 5 * MINUTES;

export const SOURCE_PRIORITIES: Record<string, number> = {
	"Source D": 4,
	"Source E": 3,
	"Source C": 2,
	"Source A": 1,
	"Source B": 0,
	Propagation: 0,
	prevs: 0,
};

export const ROUTE_GROUP_EAST = ["ST", "RH", "LE"];
export const ROUTE_GROUP_WEST = ["MI", "LW", "KI", "BR"];
