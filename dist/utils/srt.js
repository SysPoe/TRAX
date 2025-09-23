// Sectional Running Times data for QR's rail network
import { getStations } from "../stations.js";
import logger from "./logger.js";
let rawSRT = `From,To,EMU
Roma Street,Exhibition,5
Exhibition,Fortitude Valley,3
Roma Street,Central,2
Central,Fortitude Valley,2
Fortitude Valley,Bowen Hills,1
Bowen Hills,Albion,3
Albion,Wooloowin,1
Wooloowin,Eagle Junction,1
Eagle Junction,International Airport,8
Eagle Junction,Toombul,2
Toombul,Nundah,1
Nundah,Northgate,1
Northgate,Virginia,2
Virginia,Sunshine,1
Sunshine,Geebung,1
Geebung,Zillmere,1
Zillmere,Carseldine,1
Carseldine,Bald Hills,2
Bald Hills,Strathpine,2
Strathpine,Bray Park,1
Bray Park,Lawnton,1
Lawnton,Petrie,2
Petrie,Dakabin,3
Dakabin,Narangba,3
Narangba,Burpengary,3
Burpengary,Morayfield,3
Morayfield,Caboolture,3
Caboolture,Elimbah,6
Elimbah,Beerburrum,4
Beerburrum,Glass House Mountains,6
Glass House Mountains,Beerwah,3
Beerwah,Landsborough,5
Landsborough,Mooloolah,5
Mooloolah,Eudlo,6
Eudlo,Palmwoods,3
Palmwoods,Woombye,3
Woombye,Nambour,4
Northgate,Bindha,1
Bindha,Banyo,1
Banyo,Nudgee,1
Nudgee,Boondall,2
Boondall,North Boondall,1
North Boondall,Deagon,1
Deagon,Sandgate,1
Sandgate,Shorncliffe,2
International Airport,Domestic Airport,7
Eagle Junction,Clayfield,1
Clayfield,Hendra,1
Hendra,Ascot,1
Ascot,Doomben,2
Bowen Hills,Windsor,3
Windsor,Wilston,1
Wilston,Newmarket,1
Newmarket,Alderley,1
Alderley,Enoggera,1
Enoggera,Gaythorne,1
Gaythorne,Mitchelton,1
Mitchelton,Oxford Park,1
Oxford Park,Grovely,1
Grovely,Keperra,1
Keperra,Ferny Grove,3
Roma Street,Milton,1
Milton,Auchenflower,1
Auchenflower,Toowong,1
Toowong,Taringa,1
Taringa,Indooroopilly,1
Indooroopilly,Chelmer,2
Chelmer,Graceville,1
Graceville,Sherwood,1
Sherwood,Corinda,1
Corinda,Oxley,2
Oxley,Darra,2
Darra,Wacol,2
Wacol,Gailes,2
Gailes,Goodna,1
Goodna,Redbank,2
Redbank,Riverview,2
Riverview,Dinmore,1
Dinmore,Ebbw Vale,1
Ebbw Vale,Bundamba,1
Bundamba,Booval,1
Booval,East Ipswich,1
East Ipswich,Ipswich,2
Ipswich,Thomas Street,2
Thomas Street,Wulkuraka,2
Wulkuraka,Karrabin,2
Karrabin,Walloon,3
Walloon,Thagoona,3
Thagoona,Rosewood,4
Roma Street,South Brisbane,4
South Brisbane,South Bank,1
South Bank,Boggo,1
South Bank,Park Road,1
Boggo,Dutton Park,2
Park Road,Dutton Park,2
Dutton Park,Fairfield,1
Fairfield,Yeronga,2
Yeronga,Yeerongpilly,1
Yeerongpilly,Moorooka,1
Moorooka,Rocklea,2
Rocklea,Salisbury,1
Salisbury,Coopers Plains,2
Rocklea,Coopers Plains,3
Coopers Plains,Banoon,1
Banoon,Sunnybank,1
Sunnybank,Altandi,1
Altandi,Runcorn,1
Runcorn,Fruitgrove,2
Fruitgrove,Kuraby,1
Kuraby,Trinder Park,3
Trinder Park,Woodridge,1
Woodridge,Kingston,2
Kingston,Loganlea,1
Loganlea,Bethania,2
Bethania,Edens Landing,1
Edens Landing,Holmview,1
Holmview,Beenleigh,2
Beenleigh,Ormeau,7
Ormeau,Coomera,5
Coomera,Helensvale,5
Helensvale,Nerang,5
Nerang,Robina,5
Robina,Varsity Lakes,4
Varsity Lakes,Robina,4
Boggo,Buranda,2
Park Road,Buranda,2
Buranda,Coorparoo,1
Coorparoo,Norman Park,1
Norman Park,Morningside,2
Morningside,Cannon Hill,1
Cannon Hill,Murarrie,1
Murarrie,Hemmant,2
Hemmant,Lindum,2
Lindum,Wynnum North,2
Wynnum North,Wynnum station,2
Wynnum station,Wynnum Central,2
Wynnum Central,Manly,2
Manly,Lota,1
Lota,Thorneside,1
Thorneside,Birkdale,2
Birkdale,Wellington Point,2
Wellington Point,Ormiston,1
Ormiston,Cleveland,2
Nambour,Yandina,9
Yandina,Eumundi,10
Eumundi,Cooroy,8
Cooroy,Pomona,9
Pomona,Cooran,7
Cooran,Traveston,6
Traveston,Gympie North,19
Petrie,Kallangur,2
Kallangur,Murrumba Downs,1
Murrumba Downs,Mango Hill station,2
Mango Hill station,Mango Hill East,2
Mango Hill East,Rothwell,2
Rothwell,Kippa-Ring,4
Darra,Richlands,3
Richlands,Springfield station,5
Springfield station,Springfield Central,3
`;
function parseSRTtoMatrix(srtString) {
    const stations = getStations();
    const lines = srtString.trim().split("\n");
    const startIdx = lines[0].startsWith("From,To,EMU") ? 1 : 0;
    const matrix = {};
    for (let i = startIdx; i < lines.length; i++) {
        let [from, to, emu] = lines[i].split(",");
        if (from === "Exhibition")
            from = "place_exhsta";
        else
            from = stations.find((v) => v.stop_name?.toLowerCase().startsWith(from.toLowerCase()))?.stop_id ?? "";
        if (to === "Exhibition")
            to = "place_exhsta";
        else
            to = stations.find((v) => v.stop_name?.toLowerCase().startsWith(to.toLowerCase()))?.stop_id ?? "";
        if (!from) {
            logger.error(`Invalid SRT from: ${lines[i]}`, {
                module: "srt",
                function: "parseSRTtoMatrix",
            });
            continue;
        }
        if (!to) {
            logger.error(`Invalid SRT to: ${lines[i]}`, {
                module: "srt",
                function: "parseSRTtoMatrix",
            });
            continue;
        }
        if (!matrix[from])
            matrix[from] = {};
        matrix[from][to] = Number(emu);
    }
    return matrix;
}
let _matrix;
function getSRTMatrix() {
    if (!_matrix) {
        _matrix = parseSRTtoMatrix(rawSRT);
    }
    return _matrix;
}
export function getSRT(from, to) {
    let matrix = getSRTMatrix();
    if (from == "place_exhsta" && to == "place_bowsta" || from == "place_bowsta" && to == "place_exhsta")
        return 3; // Exhibition to Bowen Hills is 3 minutes, but not in the SRT data
    return matrix[from]?.[to] || matrix[to]?.[from];
}
