// Hardcoded SRT data from metro-srt-travel-train.csv (modified slightly)
export type SRTEntry = { from: string; to: string; travelTrain: number };
export let SRT_DATA: SRTEntry[] = [
	// BSA
	{ from: "Roma Street", to: "Normanby", travelTrain: 2 },
	{ from: "Brisbane - Roma Street", to: "Normanby", travelTrain: 2 },
	{ from: "Normanby", to: "Exhibition", travelTrain: 1 },
	{ from: "Exhibition", to: "Campbell Street", travelTrain: 1 },
	{ from: "Campbell Street", to: "Mayne Junction", travelTrain: 1 },
	{ from: "Mayne Junction", to: "Mayne", travelTrain: 1 },
	{ from: "Bowen Hills", to: "Campbell Street", travelTrain: 1 },
	{ from: "Bowen Hills", to: "Mayne", travelTrain: 1 },
	{ from: "Mayne", to: "Albion", travelTrain: 2 },
	{ from: "Albion", to: "Wooloowin", travelTrain: 1 },
	{ from: "Wooloowin", to: "Eagle Junction", travelTrain: 1 },
	{ from: "Eagle Junction", to: "Airport Junction", travelTrain: 1 },
	{ from: "Airport Junction", to: "Toombul", travelTrain: 1 },
	{ from: "Toombul", to: "Nundah", travelTrain: 1 },
	{ from: "Nundah", to: "Northgate", travelTrain: 1 },
	{ from: "Northgate", to: "Virginia", travelTrain: 2 },
	{ from: "Virginia", to: "Sunshine", travelTrain: 1 },
	{ from: "Sunshine", to: "Geebung", travelTrain: 1 },
	{ from: "Geebung", to: "Zillmere", travelTrain: 2 },
	{ from: "Zillmere", to: "Carseldine", travelTrain: 2 },
	{ from: "Carseldine", to: "Bald Hills", travelTrain: 3 },
	{ from: "Bald Hills", to: "Strathpine", travelTrain: 2 },
	{ from: "Strathpine", to: "Bray Park", travelTrain: 1 },
	{ from: "Bray Park", to: "Lawnton", travelTrain: 2 },
	{ from: "Lawnton", to: "Petrie", travelTrain: 2 },
	{ from: "Petrie", to: "Dakabin", travelTrain: 4 },
	{ from: "Dakabin", to: "Narangba", travelTrain: 4 },
	{ from: "Narangba", to: "Burpengary", travelTrain: 4 },
	{ from: "Burpengary", to: "Morayfield", travelTrain: 5 },
	{ from: "Morayfield", to: "Caboolture", travelTrain: 4 },
	{ from: "Caboolture", to: "Elimbah", travelTrain: 7 },
	{ from: "Elimbah", to: "Beerburrum", travelTrain: 5 },
	{ from: "Beerburrum", to: "Glasshouse Mountains", travelTrain: 8 },
	{ from: "Glasshouse Mountains", to: "Beerwah", travelTrain: 5 },
	{ from: "Beerwah", to: "Landsborough", travelTrain: 5 },
	{ from: "Landsborough", to: "Mooloolah", travelTrain: 6 },
	{ from: "Mooloolah", to: "Eudlo", travelTrain: 7 },
	{ from: "Eudlo", to: "Palmwoods", travelTrain: 4 },
	{ from: "Palmwoods", to: "Woombye", travelTrain: 4 },
	{ from: "Woombye", to: "Nambour", travelTrain: 2 },
	{ from: "Northgate", to: "Bindha", travelTrain: 1 },
	{ from: "Bindha", to: "Banyo", travelTrain: 1 },
	{ from: "Banyo", to: "Nudgee", travelTrain: 1 },
	{ from: "Nudgee", to: "Boondall", travelTrain: 2 },
	{ from: "Boondall", to: "North Boondall", travelTrain: 1 },
	{ from: "North Boondall", to: "Deagon", travelTrain: 1 },
	{ from: "Deagon", to: "Sandgate", travelTrain: 1 },
	{ from: "Sandgate", to: "Shorncliffe", travelTrain: 2 },
	{ from: "Airport Junction", to: "International Terminal", travelTrain: 3 },
	{ from: "International Terminal", to: "Domestic Terminal", travelTrain: 3 },
	{ from: "Eagle Junction", to: "Clayfield", travelTrain: 1 },
	{ from: "Clayfield", to: "Hendra", travelTrain: 1 },
	{ from: "Hendra", to: "Ascot", travelTrain: 1 },
	{ from: "Ascot", to: "Doomben", travelTrain: 2 },
	{ from: "Eagle Farm", to: "Bunour", travelTrain: 1 },
	{ from: "Bunour", to: "Meeandah", travelTrain: 1 },
	{ from: "Meeandah", to: "Pinkenba", travelTrain: 2 },
	{ from: "Bowen Hills", to: "Electric Depot Junction", travelTrain: 2 },
	{ from: "Electric Depot Junction", to: "Windsor", travelTrain: 1 },
	{ from: "Windsor", to: "Wilston", travelTrain: 1 },
	{ from: "Wilston", to: "Newmarket", travelTrain: 1 },
	{ from: "Newmarket", to: "Alderley", travelTrain: 1 },
	{ from: "Alderley", to: "Enoggera", travelTrain: 1 },
	{ from: "Enoggera", to: "Gaythorne", travelTrain: 1 },
	{ from: "Gaythorne", to: "Mitchelton", travelTrain: 1 },
	{ from: "Mitchelton", to: "Oxford Park", travelTrain: 1 },
	{ from: "Oxford Park", to: "Grovely", travelTrain: 1 },
	{ from: "Grovely", to: "Keperra", travelTrain: 1 },
	{ from: "Keperra", to: "Ferny Grove", travelTrain: 3 },
	{ from: "Roma Street", to: "Milton", travelTrain: 1 },
	{ from: "Brisbane - Roma Street", to: "Milton", travelTrain: 1 },
	{ from: "Milton", to: "Auchenflower", travelTrain: 1 },
	{ from: "Auchenflower", to: "Toowong", travelTrain: 1 },
	{ from: "Toowong", to: "Taringa", travelTrain: 1 },
	{ from: "Taringa", to: "Indooroopilly", travelTrain: 1 },
	{ from: "Indooroopilly", to: "Chelmer", travelTrain: 2 },
	{ from: "Chelmer", to: "Graceville", travelTrain: 1 },
	{ from: "Graceville", to: "Sherwood", travelTrain: 1 },
	{ from: "Sherwood", to: "Corinda", travelTrain: 1 },
	{ from: "Corinda", to: "Oxley", travelTrain: 2 },
	{ from: "Oxley", to: "Darra", travelTrain: 2 },
	{ from: "Darra", to: "Wacol", travelTrain: 2 },
	{ from: "Wacol", to: "Gailes", travelTrain: 2 },
	{ from: "Gailes", to: "Goodna", travelTrain: 1 },
	{ from: "Goodna", to: "Redbank", travelTrain: 4 },
	{ from: "Redbank", to: "Riverview", travelTrain: 2 },
	{ from: "Riverview", to: "Dinmore", travelTrain: 1 },
	{ from: "Dinmore", to: "Ebbw Vale", travelTrain: 2 },
	{ from: "Ebbw Vale", to: "Bundamba", travelTrain: 2 },
	{ from: "Bundamba", to: "Booval", travelTrain: 1 },
	{ from: "Booval", to: "East Ipswich", travelTrain: 1 },
	{ from: "East Ipswich", to: "Ipswich", travelTrain: 2 },
	{ from: "Ipswich", to: "Thomas Street", travelTrain: 2 },
	{ from: "Thomas Street", to: "Wulkuraka", travelTrain: 2 },
	{ from: "Wulkuraka", to: "Karrabin", travelTrain: 2 },
	{ from: "Karrabin", to: "Walloon", travelTrain: 3 },
	{ from: "Walloon", to: "Thagoona", travelTrain: 3 },
	{ from: "Thagoona", to: "Yarrowlea", travelTrain: 3 },
	{ from: "Yarrowlea", to: "Rosewood", travelTrain: 1 },
	{ from: "Corinda", to: "Moolabin", travelTrain: 1 },
	{ from: "Yeerongpilly", to: "Tennyson Yard", travelTrain: 2 },
	{ from: "Clapham", to: "Yeerongpilly", travelTrain: 1 },
	{ from: "Tennyson Yard", to: "Moolabin", travelTrain: 2 },
	{ from: "Salisbury", to: "Acacia Ridge", travelTrain: 5 },
	{ from: "Roma Street", to: "South Brisbane", travelTrain: 4 },
	{ from: "Brisbane - Roma Street", to: "South Brisbane", travelTrain: 4 },
	{ from: "South Brisbane", to: "South Bank", travelTrain: 1 },
	{ from: "South Bank", to: "Park Road", travelTrain: 1 },
	{ from: "Park Road", to: "Dutton Park", travelTrain: 2 },
	{ from: "Dutton Park", to: "Fairfield", travelTrain: 1 },
	{ from: "Fairfield", to: "Yeronga", travelTrain: 2 },
	{ from: "Yeronga", to: "Yeerongpilly", travelTrain: 1 },
	{ from: "Yeerongpilly", to: "Moorooka", travelTrain: 1 },
	{ from: "Moorooka", to: "Rocklea", travelTrain: 2 },
	{ from: "Rocklea", to: "Salisbury", travelTrain: 1 },
	{ from: "Salisbury", to: "Coopers Plains", travelTrain: 2 },
	{ from: "Coopers Plains", to: "Banoon", travelTrain: 1 },
	{ from: "Banoon", to: "Sunnybank", travelTrain: 1 },
	{ from: "Sunnybank", to: "Altandi", travelTrain: 1 },
	{ from: "Altandi", to: "Runcorn", travelTrain: 1 },
	{ from: "Runcorn", to: "Fruitgrove", travelTrain: 2 },
	{ from: "Fruitgrove", to: "Kuraby", travelTrain: 1 },
	{ from: "Kuraby", to: "Trinder Park", travelTrain: 3 },
	{ from: "Trinder Park", to: "Woodridge", travelTrain: 1 },
	{ from: "Woodridge", to: "Kingston", travelTrain: 2 },
	{ from: "Kingston", to: "Loganlea", travelTrain: 1 },
	{ from: "Loganlea", to: "Bethania", travelTrain: 2 },
	{ from: "Bethania", to: "Eden's Landing", travelTrain: 1 },
	{ from: "Eden's Landing", to: "Holmview", travelTrain: 1 },
	{ from: "Holmview", to: "Beenleigh", travelTrain: 2 },
	{ from: "Beenleigh", to: "Ormeau", travelTrain: 7 },
	{ from: "Ormeau", to: "Coomera", travelTrain: 5 },
	{ from: "Coomera", to: "Helensvale", travelTrain: 5 },
	{ from: "Helensvale", to: "Nerang", travelTrain: 5 },
	{ from: "Nerang", to: "Robina", travelTrain: 5 },
	{ from: "Robina", to: "Varsity Lakes", travelTrain: 4 },
	{ from: "Park Road", to: "Buranda", travelTrain: 2 },
	{ from: "Buranda", to: "Coorparoo", travelTrain: 1 },
	{ from: "Coorparoo", to: "Norman Park", travelTrain: 1 },
	{ from: "Norman Park", to: "Morningside", travelTrain: 2 },
	{ from: "Morningside", to: "Cannon Hill", travelTrain: 1 },
	{ from: "Cannon Hill", to: "Murarrie", travelTrain: 1 },
	{ from: "Murarrie", to: "Hemmant", travelTrain: 2 },
	{ from: "Hemmant", to: "Lindum", travelTrain: 2 },
	{ from: "Lindum", to: "Lytton Junction", travelTrain: 1 },
	{ from: "Lytton Junction", to: "Wynnum North", travelTrain: 1 },
	{ from: "Wynnum North", to: "Wynnum", travelTrain: 2 },
	{ from: "Wynnum", to: "Wynnum Central", travelTrain: 2 },
	{ from: "Wynnum Central", to: "Manly", travelTrain: 2 },
	{ from: "Manly", to: "Lota", travelTrain: 1 },
	{ from: "Lota", to: "Thorneside", travelTrain: 1 },
	{ from: "Thorneside", to: "Birkdale", travelTrain: 2 },
	{ from: "Birkdale", to: "Wellington Point", travelTrain: 2 },
	{ from: "Wellington Point", to: "Ormiston", travelTrain: 1 },
	{ from: "Ormiston", to: "Cleveland", travelTrain: 2 },
	{ from: "Lytton Junction", to: "Fisherman Islands", travelTrain: 10 },
	{ from: "Nambour", to: "Yandina", travelTrain: 9 },
	{ from: "Yandina", to: "North Arm", travelTrain: 6 },
	{ from: "North Arm", to: "Eumundi", travelTrain: 4 },
	{ from: "Eumundi", to: "Sunrise", travelTrain: 2 },
	{ from: "Sunrise", to: "Cooroy", travelTrain: 6 },
	{ from: "Cooroy", to: "Pomona", travelTrain: 9 },
	{ from: "Pomona", to: "Cooran", travelTrain: 7 },
	{ from: "Cooran", to: "Traveston", travelTrain: 6 },
	{ from: "Traveston", to: "Woondum", travelTrain: 7 },
	{ from: "Woondum", to: "Glanmire", travelTrain: 8 },
	{ from: "Glanmire", to: "Gympie North", travelTrain: 4 },
	{ from: "Yandina", to: "Eumundi", travelTrain: 10 },
	{ from: "Eumundi", to: "Cooroy", travelTrain: 8 },
	{ from: "Traveston", to: "Gympie North", travelTrain: 19 },
	{ from: "Petrie", to: "Kallangur", travelTrain: 2 },
	{ from: "Kallangur", to: "Murrumba Downs", travelTrain: 1 },
	{ from: "Murrumba Downs", to: "Mango Hill", travelTrain: 2 },
	{ from: "Mango Hill", to: "Mango Hill East", travelTrain: 2 },
	{ from: "Mango Hill East", to: "Rothwell", travelTrain: 2 },
	{ from: "Rothwell", to: "Kippa-Ring", travelTrain: 4 },
	{ from: "Darra", to: "Richlands", travelTrain: 3 },
	{ from: "Richlands", to: "Springfield", travelTrain: 5 },
	{ from: "Springfield", to: "Springfield Central", travelTrain: 3 },
	// NCL
	{ from: "Rockhampton", to: "Glenmore Junction", travelTrain: 14 },
	{ from: "Glenmore Junction", to: "Rockhampton", travelTrain: 12 },
	{ from: "Glenmore Junction", to: "Parkhurst", travelTrain: 8 },
	{ from: "Parkhurst", to: "Glenmore Junction", travelTrain: 7 },
	{ from: "Parkhurst", to: "The Caves", travelTrain: 14 },
	{ from: "The Caves", to: "Parkhurst", travelTrain: 12 },
	{ from: "The Caves", to: "Yaamba", travelTrain: 10 },
	{ from: "Yaamba", to: "The Caves", travelTrain: 12 },
	{ from: "Yaamba", to: "Glen Geddes", travelTrain: 15 },
	{ from: "Glen Geddes", to: "Yaamba", travelTrain: 17 },
	{ from: "Glen Geddes", to: "Kunwarara", travelTrain: 17 },
	{ from: "Kunwarara", to: "Glen Geddes", travelTrain: 15 },
	{ from: "Kunwarara", to: "Princhester", travelTrain: 20 },
	{ from: "Princhester", to: "Kunwarara", travelTrain: 17 },
	{ from: "Princhester", to: "Marlborough", travelTrain: 14 },
	{ from: "Marlborough", to: "Princhester", travelTrain: 10 },
	{ from: "Marlborough", to: "Kooltandra", travelTrain: 16 },
	{ from: "Kooltandra", to: "Marlborough", travelTrain: 15 },
	{ from: "Kooltandra", to: "Ogmore", travelTrain: 13 },
	{ from: "Ogmore", to: "Kooltandra", travelTrain: 14 },
	{ from: "Ogmore", to: "Wumalgi", travelTrain: 15 },
	{ from: "Wumalgi", to: "Ogmore", travelTrain: 15 },
	{ from: "Wumalgi", to: "St. Lawrence", travelTrain: 15 },
	{ from: "St. Lawrence", to: "Wumalgi", travelTrain: 17 },
	{ from: "St. Lawrence", to: "Kalarka", travelTrain: 18 },
	{ from: "Kalarka", to: "St. Lawrence", travelTrain: 20 },
	{ from: "Wumalgi", to: "St Lawrence", travelTrain: 15 }, // ADDED
	{ from: "St Lawrence", to: "Wumalgi", travelTrain: 17 }, // ADDED
	{ from: "St Lawrence", to: "Kalarka", travelTrain: 18 }, // ADDED
	{ from: "Kalarka", to: "St Lawrence", travelTrain: 20 }, // ADDED
	{ from: "Kalarka", to: "Elalie", travelTrain: 13 },
	{ from: "Elalie", to: "Kalarka", travelTrain: 15 },
	{ from: "Elalie", to: "Carmila", travelTrain: 15 },
	{ from: "Carmila", to: "Elalie", travelTrain: 14 },
	{ from: "Carmila", to: "Orkabie", travelTrain: 10 },
	{ from: "Orkabie", to: "Carmila", travelTrain: 9 },
	{ from: "Orkabie", to: "Ilbilbie", travelTrain: 14 },
	{ from: "Ilbilbie", to: "Orkabie", travelTrain: 14 },
	{ from: "Ilbilbie", to: "Koumala", travelTrain: 14 },
	{ from: "Koumala", to: "Ilbilbie", travelTrain: 14 },
	{ from: "Koumala", to: "Yukan QR", travelTrain: 8 },
	{ from: "Yukan QR", to: "Koumala", travelTrain: 11 },
	{ from: "Yukan QR", to: "Sarina", travelTrain: 11 },
	{ from: "Sarina", to: "Yukan QR", travelTrain: 14 },
	{ from: "Sarina", to: "Dawlish", travelTrain: 10 },
	{ from: "Dawlish", to: "Sarina", travelTrain: 9 },
	{ from: "Dawlish", to: "Balberra", travelTrain: 6 },
	{ from: "Balberra", to: "Dawlish", travelTrain: 6 },
	{ from: "Balberra", to: "Rosella", travelTrain: 8 },
	{ from: "Rosella", to: "Balberra", travelTrain: 6 },
	{ from: "Rosella", to: "Mackay", travelTrain: 15 },
	{ from: "Mackay", to: "Rosella", travelTrain: 14 },
	{ from: "Mackay", to: "Erakala", travelTrain: 7 },
	{ from: "Erakala", to: "Mackay", travelTrain: 6 },
	{ from: "Erakala", to: "Farleigh", travelTrain: 7 },
	{ from: "Farleigh", to: "Erakala", travelTrain: 7 },
	{ from: "Farleigh", to: "Aminungo", travelTrain: 13 },
	{ from: "Aminungo", to: "Farleigh", travelTrain: 11 },
	{ from: "Aminungo", to: "Kuttabul", travelTrain: 10 },
	{ from: "Kuttabul", to: "Aminungo", travelTrain: 9 },
	{ from: "Kuttabul", to: "Mt. Ossa", travelTrain: 9 },
	{ from: "Mt. Ossa", to: "Kuttabul", travelTrain: 12 },
	{ from: "Mt. Ossa", to: "Calen", travelTrain: 10 },
	{ from: "Calen", to: "Mt. Ossa", travelTrain: 10 },
	{ from: "Calen", to: "Yalboroo", travelTrain: 13 },
	{ from: "Yalboroo", to: "Calen", travelTrain: 13 },
	{ from: "Yalboroo", to: "Bloomsbury", travelTrain: 15 },
	{ from: "Bloomsbury", to: "Yalboroo", travelTrain: 18 },
	{ from: "Bloomsbury", to: "Thoopara", travelTrain: 16 },
	{ from: "Thoopara", to: "Bloomsbury", travelTrain: 16 },
	{ from: "Thoopara", to: "Proserpine", travelTrain: 15 },
	{ from: "Proserpine", to: "Thoopara", travelTrain: 17 },
	{ from: "Proserpine", to: "Bubialo", travelTrain: 17 },
	{ from: "Bubialo", to: "Proserpine", travelTrain: 20 },
	{ from: "Bubialo", to: "Longford Creek", travelTrain: 12 },
	{ from: "Longford Creek", to: "Bubialo", travelTrain: 12 },
	{ from: "Longford Creek", to: "Mookarra", travelTrain: 16 },
	{ from: "Mookarra", to: "Longford Creek", travelTrain: 13 },
	{ from: "Mookarra", to: "Bowen Junction", travelTrain: 13 },
	{ from: "Mookarra", to: "Bowen", travelTrain: 13 }, // ADDED
	{ from: "Bowen Junction", to: "Mookarra", travelTrain: 10 },
	{ from: "Bowen Junction", to: "Merinda", travelTrain: 7 },
	{ from: "Bowen", to: "Mookarra", travelTrain: 10 }, // ADDED
	{ from: "Bowen", to: "Merinda", travelTrain: 7 }, // ADDED
	{ from: "Merinda", to: "Bowen Junction", travelTrain: 5 },
	{ from: "Merinda", to: "Bowen", travelTrain: 5 }, // ADDED
	{ from: "Merinda", to: "QNIP02", travelTrain: 4 },
	{ from: "QNIP02", to: "Merinda", travelTrain: 1 },
	{ from: "QNIP02", to: "Durroburra", travelTrain: 1 },
	{ from: "Durroburra", to: "QNIP02", travelTrain: 1 },
	{ from: "Durroburra", to: "Kaili", travelTrain: 8 },
	{ from: "Kaili", to: "Durroburra", travelTrain: 7 },
	{ from: "Kaili", to: "QNIP01", travelTrain: 2 },
	{ from: "QNIP01", to: "Kaili", travelTrain: 2 },
	{ from: "QNIP01", to: "Wathana", travelTrain: 1 },
	{ from: "Wathana", to: "QNIP01", travelTrain: 1 },
	{ from: "Wathana", to: "Wilmington", travelTrain: 9 },
	{ from: "Wilmington", to: "Wathana", travelTrain: 9 },
	{ from: "Wilmington", to: "Guthalungra", travelTrain: 14 },
	{ from: "Guthalungra", to: "Wilmington", travelTrain: 14 },
	{ from: "Guthalungra", to: "Gumlu", travelTrain: 13 },
	{ from: "Gumlu", to: "Guthalungra", travelTrain: 13 },
	{ from: "Gumlu", to: "Bobawaba", travelTrain: 10 },
	{ from: "Bobawaba", to: "Gumlu", travelTrain: 10 },
	{ from: "Bobawaba", to: "Inkerman", travelTrain: 9 },
	{ from: "Inkerman", to: "Bobawaba", travelTrain: 9 },
	{ from: "Inkerman", to: "Home Hill", travelTrain: 10 },
	{ from: "Home Hill", to: "Inkerman", travelTrain: 10 },
	{ from: "Home Hill", to: "Ayr", travelTrain: 11 },
	{ from: "Ayr", to: "Home Hill", travelTrain: 13 },
	{ from: "Ayr", to: "Pioneer", travelTrain: 9 },
	{ from: "Pioneer", to: "Ayr", travelTrain: 11 },
	{ from: "Pioneer", to: "Barratta", travelTrain: 10 },
	{ from: "Barratta", to: "Pioneer", travelTrain: 10 },
	{ from: "Barratta", to: "Giru", travelTrain: 11 },
	{ from: "Giru", to: "Barratta", travelTrain: 8 },
	{ from: "Giru", to: "Cromarty", travelTrain: 6 },
	{ from: "Cromarty", to: "Giru", travelTrain: 7 },
	{ from: "Cromarty", to: "Storth", travelTrain: 6 },
	{ from: "Storth", to: "Cromarty", travelTrain: 7 },
	{ from: "Storth", to: "Nome", travelTrain: 10 },
	{ from: "Nome", to: "Storth", travelTrain: 13 },
	{ from: "Nome", to: "Julago", travelTrain: 5 },
	{ from: "Julago", to: "Nome", travelTrain: 6 },
	{ from: "Julago", to: "Sun Metals Junction", travelTrain: 1 },
	{ from: "Sun Metals Junction", to: "Julago", travelTrain: 1 },
	{ from: "Sun Metals Junction", to: "Partington", travelTrain: 2 },
	{ from: "Partington", to: "Sun Metals Junction", travelTrain: 3 },
	{ from: "Partington", to: "Stuart", travelTrain: 3 },
	{ from: "Stuart", to: "Partington", travelTrain: 3 },
	{ from: "Stuart", to: "Stuart Yard", travelTrain: 5 },
	{ from: "Stuart Yard", to: "Stuart", travelTrain: 5 },
	{ from: "Stuart Yard", to: "Cluden", travelTrain: 7 },
	{ from: "Cluden", to: "Stuart Yard", travelTrain: 6 },
	{ from: "Cluden", to: "Oonoonba", travelTrain: 2 },
	{ from: "Oonoonba", to: "Cluden", travelTrain: 2 },
	{ from: "Oonoonba", to: "`Townsville` Fork Points", travelTrain: 1 },
	{ from: "Townsville Fork Points", to: "Oonoonba", travelTrain: 2 },
	{ from: "Townsville Fork Points", to: "Townsville New Station", travelTrain: 6 },
	{ from: "Townsville New Station", to: "Townsville Fork Points", travelTrain: 6 },
	{ from: "Townsville New Station", to: "Garbutt", travelTrain: 15 },
	{ from: "Garbutt", to: "Townsville New Station", travelTrain: 15 },
	{ from: "Townsville Fork Points", to: "Townsville - Charters Towers Road", travelTrain: 6 }, // ADDED
	{ from: "Townsville - Charters Towers Road", to: "Townsville Fork Points", travelTrain: 6 }, // ADDED
	{ from: "Townsville - Charters Towers Road", to: "Garbutt", travelTrain: 15 }, // ADDED
	{ from: "Garbutt", to: "Townsville - Charters Towers Road", travelTrain: 15 }, // ADDED
	{ from: "Garbutt", to: "Bohle Industrial Siding", travelTrain: 8 },
	{ from: "Bohle Industrial Siding", to: "Garbutt", travelTrain: 8 },
	{ from: "Bohle Industrial Siding", to: "Nightjar", travelTrain: 1 },
	{ from: "Nightjar", to: "Bohle Industrial Siding", travelTrain: 1 },
	{ from: "Nightjar", to: "Deeragun", travelTrain: 3 },
	{ from: "Deeragun", to: "Nightjar", travelTrain: 3 },
	{ from: "Deeragun", to: "Cobarra New Leg", travelTrain: 8 },
	{ from: "Cobarra New Leg", to: "Deeragun", travelTrain: 8 },
	{ from: "Cobarra New Leg", to: "Cobarra Old Leg", travelTrain: 1 },
	{ from: "Cobarra Old Leg", to: "Cobarra New Leg", travelTrain: 1 },
	{ from: "Cobarra Old Leg", to: "Purono", travelTrain: 3 },
	{ from: "Purono", to: "Cobarra Old Leg", travelTrain: 3 },
	{ from: "Purono", to: "Kurukan", travelTrain: 14 },
	{ from: "Kurukan", to: "Purono", travelTrain: 12 },
	{ from: "Kurukan", to: "Rollingstone", travelTrain: 16 },
	{ from: "Rollingstone", to: "Kurukan", travelTrain: 14 },
	{ from: "Rollingstone", to: "Mutarnee", travelTrain: 11 },
	{ from: "Mutarnee", to: "Rollingstone", travelTrain: 16 },
	{ from: "Mutarnee", to: "Bambaroo", travelTrain: 11 },
	{ from: "Bambaroo", to: "Mutarnee", travelTrain: 14 },
	{ from: "Bambaroo", to: "Pombel", travelTrain: 11 },
	{ from: "Pombel", to: "Bambaroo", travelTrain: 11 },
	{ from: "Pombel", to: "Ingham", travelTrain: 12 },
	{ from: "Ingham", to: "Pombel", travelTrain: 15 },
	{ from: "Ingham", to: "Hinchinbrook", travelTrain: 20 },
	{ from: "Hinchinbrook", to: "Ingham", travelTrain: 20 },
	{ from: "Hinchinbrook", to: "Conn", travelTrain: 14 },
	{ from: "Conn", to: "Hinchinbrook", travelTrain: 15 },
	{ from: "Conn", to: "Cardwell", travelTrain: 18 },
	{ from: "Cardwell", to: "Conn", travelTrain: 19 },
	{ from: "Cardwell", to: "Kennedy", travelTrain: 12 },
	{ from: "Kennedy", to: "Cardwell", travelTrain: 12 },
	{ from: "Kennedy", to: "Bilyana", travelTrain: 10 },
	{ from: "Bilyana", to: "Kennedy", travelTrain: 10 },
	{ from: "Bilyana", to: "Hewitt", travelTrain: 17 },
	{ from: "Hewitt", to: "Bilyana", travelTrain: 20 },
	{ from: "Hewitt", to: "Tully", travelTrain: 5 },
	{ from: "Tully", to: "Hewitt", travelTrain: 5 },
	{ from: "Tully", to: "El Arish", travelTrain: 18 },
	{ from: "El Arish", to: "Tully", travelTrain: 19 },
	{ from: "El Arish", to: "Silkwood", travelTrain: 8 },
	{ from: "Silkwood", to: "El Arish", travelTrain: 8 },
	{ from: "Silkwood", to: "Boogan", travelTrain: 17 },
	{ from: "Boogan", to: "Silkwood", travelTrain: 19 },
	{ from: "Boogan", to: "Mundoo", travelTrain: 9 },
	{ from: "Mundoo", to: "Boogan", travelTrain: 9 },
	{ from: "Mundoo", to: "Innisfail", travelTrain: 8 },
	{ from: "Innisfail", to: "Mundoo", travelTrain: 11 },
	{ from: "Innisfail", to: "Waugh", travelTrain: 21 },
	{ from: "Waugh", to: "Innisfail", travelTrain: 21 },
	{ from: "Waugh", to: "Babinda", travelTrain: 17 },
	{ from: "Babinda", to: "Waugh", travelTrain: 18 },
	{ from: "Babinda", to: "Deeral", travelTrain: 16 },
	{ from: "Deeral", to: "Babinda", travelTrain: 17 },
	{ from: "Deeral", to: "Aloomba", travelTrain: 13 },
	{ from: "Aloomba", to: "Deeral", travelTrain: 15 },
	{ from: "Aloomba", to: "Gordonvale", travelTrain: 7 },
	{ from: "Gordonvale", to: "Aloomba", travelTrain: 8 },
	{ from: "Gordonvale", to: "Kamma", travelTrain: 10 },
	{ from: "Kamma", to: "Gordonvale", travelTrain: 7 },
	{ from: "Kamma", to: "Woree QRX SDG", travelTrain: 12 },
	{ from: "Woree QRX SDG", to: "Kamma", travelTrain: 10 },
	{ from: "Woree QRX SDG", to: "Portsmith", travelTrain: 7 },
	{ from: "Portsmith", to: "Woree QRX SDG", travelTrain: 8 },
	{ from: "Portsmith", to: "Cairns", travelTrain: 1 },
	{ from: "Cairns", to: "Portsmith", travelTrain: 1 },
	{ from: "Townsville Fork Points", to: "Townsville", travelTrain: 5 },
	{ from: "Townsville", to: "Townsville Fork Points", travelTrain: 5 },
	{ from: "Townsville", to: "Townsville Jetty", travelTrain: 5 },
	{ from: "Townsville Jetty", to: "Townsville", travelTrain: 5 },
	{ from: "Townsville New Station", to: "Townsville", travelTrain: 2 },
	{ from: "Townsville", to: "Townsville New Station", travelTrain: 2 },
	{ from: "Townsville - Charters Towers Road", to: "Townsville", travelTrain: 2 }, // ADDED
	{ from: "Townsville", to: "Townsville - Charters Towers Road", travelTrain: 2 }, // ADDED
	{ from: "Nambour", to: "Yandina", travelTrain: 9 },
	{ from: "Yandina", to: "Nambour", travelTrain: 9 },
	{ from: "Yandina", to: "North Arm", travelTrain: 5 },
	{ from: "North Arm", to: "Yandina", travelTrain: 6 },
	{ from: "North Arm", to: "Eumundi", travelTrain: 6 },
	{ from: "Eumundi", to: "North Arm", travelTrain: 4 },
	{ from: "Eumundi", to: "Sunrise", travelTrain: 2 },
	{ from: "Sunrise", to: "Eumundi", travelTrain: 2 },
	{ from: "Sunrise", to: "Cooroy", travelTrain: 7 },
	{ from: "Cooroy", to: "Sunrise", travelTrain: 6 },
	{ from: "Cooroy", to: "Pomona", travelTrain: 8 },
	{ from: "Pomona", to: "Cooroy", travelTrain: 9 },
	{ from: "Pomona", to: "Cooran", travelTrain: 7 },
	{ from: "Cooran", to: "Pomona", travelTrain: 7 },
	{ from: "Cooran", to: "Traveston", travelTrain: 6 },
	{ from: "Traveston", to: "Cooran", travelTrain: 6 },
	{ from: "Traveston", to: "Woondum", travelTrain: 7 },
	{ from: "Woondum", to: "Traveston", travelTrain: 7 },
	{ from: "Woondum", to: "Glanmire", travelTrain: 8 },
	{ from: "Glanmire", to: "Woondum", travelTrain: 8 },
	{ from: "Glanmire", to: "Gympie North", travelTrain: 4 },
	{ from: "Gympie North", to: "Glanmire", travelTrain: 4 },
	{ from: "Gympie North", to: "Tamaree", travelTrain: 5 },
	{ from: "Tamaree", to: "Gympie North", travelTrain: 3 },
	{ from: "Tamaree", to: "Harvey's Siding", travelTrain: 9 },
	{ from: "Harvey's Siding", to: "Tamaree", travelTrain: 6 },
	{ from: "Harvey's Siding", to: "Curra", travelTrain: 5 },
	{ from: "Curra", to: "Harvey's Siding", travelTrain: 5 },
	{ from: "Curra", to: "Theebine", travelTrain: 9 },
	{ from: "Theebine", to: "Curra", travelTrain: 9 },
	{ from: "Theebine", to: "Paterson", travelTrain: 6 },
	{ from: "Paterson", to: "Theebine", travelTrain: 6 },
	{ from: "Paterson", to: "Gundiah", travelTrain: 7 },
	{ from: "Gundiah", to: "Paterson", travelTrain: 6 },
	{ from: "Gundiah", to: "Netherby", travelTrain: 5 },
	{ from: "Netherby", to: "Gundiah", travelTrain: 4 },
	{ from: "Netherby", to: "Tiaro", travelTrain: 6 },
	{ from: "Tiaro", to: "Netherby", travelTrain: 7 },
	{ from: "Tiaro", to: "Owanyilla", travelTrain: 7 },
	{ from: "Owanyilla", to: "Tiaro", travelTrain: 10 },
	{ from: "Owanyilla", to: "Mungar", travelTrain: 9 },
	{ from: "Mungar", to: "Owanyilla", travelTrain: 11 },
	{ from: "Mungar", to: "Yengarie", travelTrain: 6 },
	{ from: "Yengarie", to: "Mungar", travelTrain: 6 },
	{ from: "Yengarie", to: "Maryborough West", travelTrain: 9 },
	{ from: "Maryborough West", to: "Yengarie", travelTrain: 9 },
	{ from: "Maryborough West", to: "Colton", travelTrain: 10 },
	{ from: "Colton", to: "Maryborough West", travelTrain: 9 },
	{ from: "Colton", to: "Torbanlea", travelTrain: 7 },
	{ from: "Torbanlea", to: "Colton", travelTrain: 7 },
	{ from: "Torbanlea", to: "Howard", travelTrain: 4 },
	{ from: "Howard", to: "Torbanlea", travelTrain: 4 },
	{ from: "Howard", to: "Wokka", travelTrain: 7 },
	{ from: "Wokka", to: "Howard", travelTrain: 7 },
	{ from: "Wokka", to: "Isis Junction", travelTrain: 5 },
	{ from: "Isis Junction", to: "Wokka", travelTrain: 5 },
	{ from: "Isis Junction", to: "Goodwood", travelTrain: 7 },
	{ from: "Goodwood", to: "Isis Junction", travelTrain: 7 },
	{ from: "Goodwood", to: "Kinkuna", travelTrain: 7 },
	{ from: "Kinkuna", to: "Goodwood", travelTrain: 7 },
	{ from: "Kinkuna", to: "Elliott", travelTrain: 6 },
	{ from: "Elliott", to: "Kinkuna", travelTrain: 7 },
	{ from: "Elliott", to: "Bundaberg", travelTrain: 14 },
	{ from: "Bundaberg", to: "Elliott", travelTrain: 12 },
	{ from: "Bundaberg", to: "Meadowvale", travelTrain: 17 },
	{ from: "Meadowvale", to: "Bundaberg", travelTrain: 16 },
	{ from: "Meadowvale", to: "Avondale", travelTrain: 11 },
	{ from: "Avondale", to: "Meadowvale", travelTrain: 13 },
	{ from: "Avondale", to: "Littabella", travelTrain: 8 },
	{ from: "Littabella", to: "Avondale", travelTrain: 8 },
	{ from: "Littabella", to: "Flinders", travelTrain: 17 },
	{ from: "Flinders", to: "Littabella", travelTrain: 15 },
	{ from: "Flinders", to: "Berajondo", travelTrain: 13 },
	{ from: "Berajondo", to: "Flinders", travelTrain: 10 },
	{ from: "Berajondo", to: "Baffle", travelTrain: 10 },
	{ from: "Baffle", to: "Berajondo", travelTrain: 9 },
	{ from: "Baffle", to: "Irkanda", travelTrain: 6 },
	{ from: "Irkanda", to: "Baffle", travelTrain: 7 },
	{ from: "Irkanda", to: "Netley", travelTrain: 8 },
	{ from: "Netley", to: "Irkanda", travelTrain: 11 },
	{ from: "Netley", to: "Miriam Vale", travelTrain: 9 },
	{ from: "Miriam Vale", to: "Netley", travelTrain: 11 },
	{ from: "Miriam Vale", to: "Bororen", travelTrain: 8 },
	{ from: "Bororen", to: "Miriam Vale", travelTrain: 8 },
	{ from: "Bororen", to: "Iveragh", travelTrain: 12 },
	{ from: "Iveragh", to: "Bororen", travelTrain: 13 },
	{ from: "Iveragh", to: "Benaraby", travelTrain: 15 },
	{ from: "Benaraby", to: "Iveragh", travelTrain: 16 },
	{ from: "Benaraby", to: "Parana", travelTrain: 10 },
	{ from: "Parana", to: "Benaraby", travelTrain: 9 },
	{ from: "Parana", to: "Gladstone", travelTrain: 9 },
	{ from: "Gladstone", to: "Parana", travelTrain: 11 },
	{ from: "Rocklands", to: "Rockhampton", travelTrain: 11 },
	{ from: "Rockhampton", to: "Rocklands", travelTrain: 10 },
	{ from: "Gympie North", to: "Gympie", travelTrain: 10 },
	{ from: "Gympie", to: "Gympie North", travelTrain: 10 },
	{ from: "Maryborough West", to: "Maryborough", travelTrain: 10 },
	{ from: "Maryborough", to: "Maryborough West", travelTrain: 10 },
	// West Moreton
	{ from: "Ebenezer", to: "Yarrowlea", travelTrain: 1 },
	{ from: "Yarrowlea", to: "Ebenezer", travelTrain: 1 },
	{ from: "Helidon", to: "Grantham", travelTrain: 11.5 },
	{ from: "Grantham", to: "Helidon", travelTrain: 11.5 },
	{ from: "Grantham", to: "Gatton", travelTrain: 11.5 },
	{ from: "Gatton", to: "Grantham", travelTrain: 11.5 },
	{ from: "Gatton", to: "Forest Hill", travelTrain: 9.5 },
	{ from: "Forest Hill", to: "Gatton", travelTrain: 9.5 },
	{ from: "Forest Hill", to: "Laidley", travelTrain: 7.5 },
	{ from: "Laidley", to: "Forest Hill", travelTrain: 7.5 },
	{ from: "Laidley", to: "Yarongmulu", travelTrain: 19.5 },
	{ from: "Yarongmulu", to: "Laidley", travelTrain: 19.5 },
	{ from: "Yarongmulu", to: "Grandchester", travelTrain: 17.5 },
	{ from: "Grandchester", to: "Yarongmulu", travelTrain: 17.5 },
	{ from: "Grandchester", to: "Rosewood", travelTrain: 13.5 },
	{ from: "Rosewood", to: "Grandchester", travelTrain: 13.5 },
	{ from: "Helidon", to: "Lockyer", travelTrain: 14.5 },
	{ from: "Lockyer", to: "Helidon", travelTrain: 14.5 },
	{ from: "Lockyer", to: "Murphys Creek", travelTrain: 18.5 },
	{ from: "Murphys Creek", to: "Lockyer", travelTrain: 18.5 },
	{ from: "Murphys Creek", to: "Holmes", travelTrain: 22.5 },
	{ from: "Holmes", to: "Murphys Creek", travelTrain: 22.5 },
	{ from: "Holmes", to: "Spring Bluff", travelTrain: 19.5 },
	{ from: "Spring Bluff", to: "Holmes", travelTrain: 19.5 },
	{ from: "Spring Bluff", to: "Rangeview", travelTrain: 24.5 },
	{ from: "Rangeview", to: "Spring Bluff", travelTrain: 24.5 },
	{ from: "Rangeview", to: "Harlaxton", travelTrain: 6.5 },
	{ from: "Harlaxton", to: "Rangeview", travelTrain: 6.5 },
	{ from: "Harlaxton", to: "Toowoomba", travelTrain: 9.5 },
	{ from: "Toowoomba", to: "Harlaxton", travelTrain: 9.5 },
	{ from: "Rosewood", to: "Grandchester", travelTrain: 14.5 },
	{ from: "Grandchester", to: "Rosewood", travelTrain: 14.5 },
	{ from: "Grandchester", to: "Yarongmulu", travelTrain: 17.5 },
	{ from: "Yarongmulu", to: "Grandchester", travelTrain: 17.5 },
	{ from: "Yarongmulu", to: "Laidley", travelTrain: 9.5 },
	{ from: "Laidley", to: "Yarongmulu", travelTrain: 9.5 },
	{ from: "Laidley", to: "Forest Hill", travelTrain: 7.5 },
	{ from: "Forest Hill", to: "Laidley", travelTrain: 7.5 },
	{ from: "Forest Hill", to: "Gatton", travelTrain: 9.5 },
	{ from: "Gatton", to: "Forest Hill", travelTrain: 9.5 },
	{ from: "Gatton", to: "Grantham", travelTrain: 11.5 },
	{ from: "Grantham", to: "Gatton", travelTrain: 11.5 },
	{ from: "Grantham", to: "Helidon", travelTrain: 11.5 },
	{ from: "Helidon", to: "Grantham", travelTrain: 11.5 },
	{ from: "Rosewood", to: "Yarrowlea", travelTrain: 4 },
	{ from: "Yarrowlea", to: "Rosewood", travelTrain: 4 },
	{ from: "Toowoomba", to: "Harlaxton", travelTrain: 8.5 },
	{ from: "Harlaxton", to: "Toowoomba", travelTrain: 8.5 },
	{ from: "Harlaxton", to: "Rangeview", travelTrain: 6.5 },
	{ from: "Rangeview", to: "Harlaxton", travelTrain: 6.5 },
	{ from: "Rangeview", to: "Spring Bluff", travelTrain: 23.5 },
	{ from: "Spring Bluff", to: "Rangeview", travelTrain: 23.5 },
	{ from: "Spring Bluff", to: "Holmes", travelTrain: 18.5 },
	{ from: "Holmes", to: "Spring Bluff", travelTrain: 18.5 },
	{ from: "Holmes", to: "Murphys Creek", travelTrain: 22.5 },
	{ from: "Murphys Creek", to: "Holmes", travelTrain: 22.5 },
	{ from: "Murphys Creek", to: "Lockyer", travelTrain: 17.5 },
	{ from: "Lockyer", to: "Murphys Creek", travelTrain: 17.5 },
	{ from: "Lockyer", to: "Helidon", travelTrain: 13.5 },
	{ from: "Helidon", to: "Lockyer", travelTrain: 13.5 },
	{ from: "Toowoomba", to: "Toowoomba Marshalling Yard", travelTrain: 5 },
	{ from: "Toowoomba Marshalling Yard", to: "Toowoomba", travelTrain: 5 },
	{ from: "Toowoomba Marshalling Yard", to: "Willowburn", travelTrain: 5 },
	{ from: "Willowburn", to: "Toowoomba Marshalling Yard", travelTrain: 5 },
	{ from: "Toowoomba", to: "Toowoomba Passenger Station", travelTrain: 3 },
	{ from: "Toowoomba Passenger Station", to: "Toowoomba", travelTrain: 3 },
	{ from: "Toowoomba Passenger Station", to: "Harristown", travelTrain: 1 },
	{ from: "Harristown", to: "Toowoomba Passenger Station", travelTrain: 1 },
	{ from: "Harristown", to: "Wyreema", travelTrain: 1 },
	{ from: "Wyreema", to: "Harristown", travelTrain: 1 },
	{ from: "Willowburn", to: "Toowoomba Marshalling Yard", travelTrain: 10 },
	{ from: "Toowoomba Marshalling Yard", to: "Willowburn", travelTrain: 10 },
	{ from: "Toowoomba Marshalling Yard", to: "Toowoomba", travelTrain: 5 },
	{ from: "Toowoomba", to: "Toowoomba Marshalling Yard", travelTrain: 5 },
	{ from: "Wulkuraka", to: "Karrabin", travelTrain: 3 },
	{ from: "Karrabin", to: "Wulkuraka", travelTrain: 3 },
	{ from: "Karrabin", to: "Walloon", travelTrain: 6 },
	{ from: "Walloon", to: "Karrabin", travelTrain: 6 },
	{ from: "Walloon", to: "Thagoona", travelTrain: 5 },
	{ from: "Thagoona", to: "Walloon", travelTrain: 5 },
	{ from: "Thagoona", to: "Yarrowlea", travelTrain: 2 },
	{ from: "Yarrowlea", to: "Thagoona", travelTrain: 2 },
	{ from: "Yarrowlea", to: "Ebenezer", travelTrain: 1 },
	{ from: "Ebenezer", to: "Yarrowlea", travelTrain: 1 },
	{ from: "Yarrowlea", to: "Rosewood", travelTrain: 4 },
	{ from: "Rosewood", to: "Yarrowlea", travelTrain: 4 },
	{ from: "Yarrowlea", to: "Thagoona", travelTrain: 2 },
	{ from: "Thagoona", to: "Yarrowlea", travelTrain: 2 },
	{ from: "Thagoona", to: "Walloon", travelTrain: 5 },
	{ from: "Walloon", to: "Thagoona", travelTrain: 5 },
	{ from: "Walloon", to: "Karrabin", travelTrain: 6 },
	{ from: "Karrabin", to: "Walloon", travelTrain: 6 },
	{ from: "Karrabin", to: "Wulkuraka", travelTrain: 3 },
	{ from: "Wulkuraka", to: "Karrabin", travelTrain: 3 },
];

SRT_DATA = SRT_DATA.concat(
	SRT_DATA.map((v) => ({
		from: v.to,
		to: v.from,
		travelTrain: v.travelTrain,
	})),
);

import type { TrainMovementDTO } from "../../qr-travel/types.js";

// Output type for each stop (stopping or passing)
export interface SRTStop {
	placeName: string;
	isStop: boolean; // true if train stops, false if passing
	plannedArrival: string;
	plannedDeparture: string;
	actualArrival?: string;
	actualDeparture?: string;
	srtMinutes?: number; // SRT minutes for this segment (if available)
	estimatedPassingTime?: string; // ISO string if available
	arrivalDelaySeconds?: number | null;
	arrivalDelayClass?: "on-time" | "scheduled" | "late" | "very-late" | "early";
	arrivalDelayString?: "on time" | string;
	departureDelaySeconds?: number | null;
	departureDelayClass?: "on-time" | "scheduled" | "late" | "very-late" | "early";
	departureDelayString?: "on time" | string;
}

function getDelay(delaySecs: number | null = null, departureTime: string | null) {
	if (delaySecs === null || departureTime === null) return { delayString: "scheduled", delayClass: "scheduled" };

	let departsInSecs = Math.round(new Date(departureTime).getTime() - Date.now()) / 1000;
	departsInSecs = Math.round(departsInSecs / 60) * 60;
	const roundedDelay = delaySecs ? Math.round(delaySecs / 60) * 60 : null;
	const delayString =
		delaySecs != null && roundedDelay != null
			? delaySecs == 0
				? "on time"
				: `${Math.floor(roundedDelay / 3600)}h ${Math.floor(
						(Math.abs(roundedDelay) % 3600) / 60,
					)}m ${delaySecs > 0 ? "late" : "early"}`
						.replace(/^0h/, "")
						.trim()
			: "scheduled";
	const delayClass: "very-late" | "late" | "early" | "on-time" | "scheduled" =
		delaySecs != null && roundedDelay != null
			? roundedDelay > 0
				? roundedDelay > 5 * 60
					? "very-late"
					: "late"
				: roundedDelay < 0
					? "early"
					: "on-time"
			: "scheduled";
	return { delayString, delayClass };
}

function pushSRT(
	arr: SRTStop[],
	stop: Exclude<SRTStop, "departureDelayClass" | "departureDelayString" | "arrivalDelayClass" | "arrivalDelayString">,
) {
	let arrivalDelayInfo = getDelay(stop.arrivalDelaySeconds || null, stop.actualArrival || null);
	let departureDelayInfo = getDelay(stop.departureDelaySeconds || null, stop.actualDeparture || null);
	type delayClass = "on-time" | "scheduled" | "late" | "very-late" | "early";
	arr.push({
		...stop,
		arrivalDelayClass:
			stop.actualArrival === "0001-01-01T00:00:00" && stop.plannedArrival === "0001-01-01T00:00:00"
				? undefined
				: (arrivalDelayInfo.delayClass as delayClass),
		arrivalDelayString:
			stop.actualArrival === "0001-01-01T00:00:00" && stop.plannedArrival === "0001-01-01T00:00:00"
				? undefined
				: arrivalDelayInfo.delayString,
		departureDelayClass:
			stop.actualDeparture === "0001-01-01T00:00:00" && stop.plannedDeparture === "0001-01-01T00:00:00"
				? undefined
				: (departureDelayInfo.delayClass as delayClass),
		departureDelayString:
			stop.actualDeparture === "0001-01-01T00:00:00" && stop.plannedDeparture === "0001-01-01T00:00:00"
				? undefined
				: departureDelayInfo.delayString,
	});
}

/**
 * Given an array of TrainMovementDTOs (stopping pattern), return an array of SRTStop including both stops and passing stops with SRT times.
 * For segments not in SRT_DATA, just include the stops as-is.
 */
export function expandWithSRTPassingStops(stoppingMovements: TrainMovementDTO[]): SRTStop[] {
	function calcDelay(actual?: string, planned?: string): number | null {
		if (!actual || !planned || actual === "0001-01-01T00:00:00" || planned === "0001-01-01T00:00:00") return null;
		const a = new Date(actual).getTime();
		const p = new Date(planned).getTime();
		if (isNaN(a) || isNaN(p)) return null;
		return Math.round((a - p) / 1000);
	}
	if (stoppingMovements.length < 2)
		return stoppingMovements.map((m) => ({
			placeName: m.PlaceName,
			isStop: true,
			plannedArrival: m.PlannedArrival,
			plannedDeparture: m.PlannedDeparture,
			actualArrival: m.ActualArrival,
			actualDeparture: m.ActualDeparture,
			arrivalDelaySeconds: calcDelay(m.ActualArrival, m.PlannedArrival),
			departureDelaySeconds: calcDelay(m.ActualDeparture, m.PlannedDeparture),
		}));

	const result: SRTStop[] = [];
	let prevTime: Date | null = null;
	for (let i = 0; i < stoppingMovements.length - 1; ++i) {
		const from = stoppingMovements[i];
		const to = stoppingMovements[i + 1];
		// Always add the 'from' stop
		if (i === 0) {
			pushSRT(result, {
				placeName: from.PlaceName,
				isStop: true,
				plannedArrival: from.PlannedArrival,
				plannedDeparture: from.PlannedDeparture,
				actualArrival: from.ActualArrival,
				actualDeparture: from.ActualDeparture,
				arrivalDelaySeconds: calcDelay(from.ActualArrival, from.PlannedArrival),
				departureDelaySeconds: calcDelay(from.ActualDeparture, from.PlannedDeparture),
			});
			// Set prevTime to actual/planned departure if available
			if (from.ActualDeparture && from.ActualDeparture !== "0001-01-01T00:00:00") {
				prevTime = new Date(from.ActualDeparture);
			} else if (from.PlannedDeparture && from.PlannedDeparture !== "0001-01-01T00:00:00") {
				prevTime = new Date(from.PlannedDeparture);
			} else {
				prevTime = null;
			}
		}
		// Find all SRT segments between from and to
		let seg = SRT_DATA.find(
			(s) =>
				(s.from === from.PlaceName && s.to === to.PlaceName) ||
				(s.from === to.PlaceName && s.to === from.PlaceName),
		);
		if (seg) {
			// Direct SRT segment, no passing stops
			// Estimate next stop's arrival time
			let estPass: Date | undefined =
				prevTime && seg.travelTrain ? new Date(prevTime.getTime() + seg.travelTrain * 60000) : undefined;
			pushSRT(result, {
				placeName: to.PlaceName,
				isStop: true,
				plannedArrival: to.PlannedArrival,
				plannedDeparture: to.PlannedDeparture,
				actualArrival: to.ActualArrival,
				actualDeparture: to.ActualDeparture,
				srtMinutes: seg.travelTrain,
				estimatedPassingTime: estPass
					? estPass.getFullYear().toString().padStart(4, "0") +
						"-" +
						(estPass.getMonth() + 1).toString().padStart(2, "0") +
						"-" +
						estPass.getDate().toString().padStart(2, "0") +
						"T" +
						estPass.getHours().toString().padStart(2, "0") +
						":" +
						estPass.getMinutes().toString().padStart(2, "0") +
						":" +
						estPass.getSeconds().toString().padStart(2, "0")
					: undefined,
				arrivalDelaySeconds: calcDelay(to.ActualArrival, to.PlannedArrival),
				departureDelaySeconds: calcDelay(to.ActualDeparture, to.PlannedDeparture),
			});
			prevTime = estPass ?? null;
			continue;
		}
		// Try to find a chain of SRT segments between from and to (i.e. passing stops)
		// BFS to find shortest SRT path
		let queue: { path: SRTEntry[]; last: string }[] = SRT_DATA.filter(
			(s) => s.from.trim().toLocaleLowerCase() === from.PlaceName.trim().toLowerCase(),
		).map((s) => ({ path: [s], last: s.to }));
		queue =
			queue.length == 0
				? SRT_DATA.filter((s) => s.to.trim().toLocaleLowerCase() === from.PlaceName.trim().toLowerCase()).map(
						(s) => ({ path: [s], last: s.from }),
					)
				: queue;
		let found: SRTEntry[] | null = null;
		let visited = new Set<string>();

		while (queue.length && !found) {
			let { path, last } = queue.shift()!;
			if (last === to.PlaceName) {
				found = path;
				break;
			}
			if (visited.has(last)) continue;
			visited.add(last);

			for (let next of SRT_DATA.filter(
				(s) =>
					s.from.trim().toLowerCase() === last.trim().toLowerCase() ||
					s.to.trim().toLowerCase() === last.trim().toLowerCase(),
			)) {
				// Determine the next stop based on which end matches 'last'
				const nextStop = next.from.trim().toLowerCase() === last.trim().toLowerCase() ? next.to : next.from;
				if (!visited.has(nextStop)) queue.push({ path: [...path, next], last: nextStop });
			}
		}
		if (found) {
			// Build a list of stops in order by traversing the path
			let stops: string[] = [from.PlaceName];
			let current = from.PlaceName;
			for (let seg of found) {
				// Determine which end of the segment we're going to
				if (seg.from.trim().toLowerCase() === current.trim().toLowerCase()) {
					current = seg.to;
				} else {
					current = seg.from;
				}
				stops.push(current);
			}

			// Calculate total SRT time for the entire segment
			let totalSRT = found.reduce((sum, seg) => sum + seg.travelTrain, 0);

			// Calculate actual time between from and to stations
			let fromTime = prevTime;
			let toTime: Date | null = null;
			if (to.ActualArrival && to.ActualArrival !== "0001-01-01T00:00:00") {
				toTime = new Date(to.ActualArrival);
			} else if (to.PlannedArrival && to.PlannedArrival !== "0001-01-01T00:00:00") {
				toTime = new Date(to.PlannedArrival);
			}

			// Calculate scaling factor: actualTime / srtTime
			let scaleFactor = 1.0;
			if (fromTime && toTime && totalSRT > 0) {
				let actualMinutes = (toTime.getTime() - fromTime.getTime()) / 60000;
				scaleFactor = actualMinutes / totalSRT;
			}

			// Only add true passing stops (all stops except first and last)
			let cumulativeSRT = 0;
			for (let j = 1; j < stops.length - 1; ++j) {
				const stopName = stops[j];
				const foundSeg = found[j - 1]; // The segment that leads TO this stop
				if (foundSeg) {
					cumulativeSRT += foundSeg.travelTrain;
					const orig = stoppingMovements.find((m) => m.PlaceName === stopName);

					// Calculate scaled time based on actual travel time
					let estPass: Date | undefined = undefined;
					if (fromTime) {
						let scaledMinutes = cumulativeSRT * scaleFactor;
						estPass = new Date(fromTime.getTime() + scaledMinutes * 60000);
					}

					pushSRT(result, {
						placeName: stopName,
						isStop: false,
						plannedArrival: orig?.PlannedArrival || "",
						plannedDeparture: orig?.PlannedDeparture || "",
						actualArrival: orig?.ActualArrival,
						actualDeparture: orig?.ActualDeparture,
						srtMinutes: foundSeg.travelTrain,
						estimatedPassingTime: estPass
							? estPass.getFullYear().toString().padStart(4, "0") +
								"-" +
								(estPass.getMonth() + 1).toString().padStart(2, "0") +
								"-" +
								estPass.getDate().toString().padStart(2, "0") +
								"T" +
								estPass.getHours().toString().padStart(2, "0") +
								":" +
								estPass.getMinutes().toString().padStart(2, "0") +
								":" +
								estPass.getSeconds().toString().padStart(2, "0")
							: undefined,
						arrivalDelaySeconds: calcDelay(
							orig?.ActualArrival || (estPass ? estPass.toISOString() : undefined),
							orig?.PlannedArrival || (estPass ? estPass.toISOString() : undefined),
						),
						departureDelaySeconds: calcDelay(
							orig?.ActualDeparture || (estPass ? estPass.toISOString() : undefined),
							orig?.PlannedDeparture || (estPass ? estPass.toISOString() : undefined),
						),
					});
					prevTime = estPass ?? null;
				}
			}
			// Add the final stop (not as a passing stop)
			// Use actual arrival time for the destination, don't estimate it
			pushSRT(result, {
				placeName: to.PlaceName,
				isStop: true,
				plannedArrival: to.PlannedArrival,
				plannedDeparture: to.PlannedDeparture,
				actualArrival: to.ActualArrival,
				actualDeparture: to.ActualDeparture,
				srtMinutes: totalSRT,
				arrivalDelaySeconds: calcDelay(to.ActualArrival, to.PlannedArrival),
				departureDelaySeconds: calcDelay(to.ActualDeparture, to.PlannedDeparture),
			});
			// Update prevTime to the actual departure of this stop
			if (to.ActualDeparture && to.ActualDeparture !== "0001-01-01T00:00:00") {
				prevTime = new Date(to.ActualDeparture);
			} else if (to.PlannedDeparture && to.PlannedDeparture !== "0001-01-01T00:00:00") {
				prevTime = new Date(to.PlannedDeparture);
			} else {
				prevTime = toTime;
			}
			continue;
		}
		// else: no SRT path found, include the stop
		pushSRT(result, {
			placeName: to.PlaceName,
			isStop: true,
			plannedArrival: to.PlannedArrival,
			plannedDeparture: to.PlannedDeparture,
			actualArrival: to.ActualArrival,
			actualDeparture: to.ActualDeparture,
			arrivalDelaySeconds: calcDelay(to.ActualArrival, to.PlannedArrival),
			departureDelaySeconds: calcDelay(to.ActualDeparture, to.PlannedDeparture),
		});
		// Update prevTime for next segments
		if (to.ActualDeparture && to.ActualDeparture !== "0001-01-01T00:00:00") {
			prevTime = new Date(to.ActualDeparture);
		} else if (to.PlannedDeparture && to.PlannedDeparture !== "0001-01-01T00:00:00") {
			prevTime = new Date(to.PlannedDeparture);
		}
	}
	// End for loop
	return result;
}
