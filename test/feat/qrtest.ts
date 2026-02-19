import CryptoJS from "crypto-js";
import fs from "fs";

type SearchInputResponse = {
    success: boolean;
    href: string;
    fields: {
        btpt: SearchInputPriceType[];
        stations: SearchInputStation[];
        trains: SearchInputTrain[];
    };
};

type SearchInputPriceType = {
    defaultpricetypeid: number;
    bookingtypeid: number;
    bookingtypename: string;
    pricetypeid: number;
    pricetypename: string;
    defaultpricetypesequence: number;
    clientid: number;
    pricetypeinactive: boolean;
    bookingtypeinactive: boolean;
    enquirypricetypeid: number | null;
};

type SearchInputStation = {
    isstart: boolean;
    genericid: number; // e.g. 6032
    name: string; // e.g. MIR - Miriam Vale
};

type SearchInputTrain = {
    genericid: number; // e.g. 1034
    name: string; // e.g. ZRailBus P986 Winton to Longreach
};

type RailServiceSearchRequestBody = {
    RailServiceSearchRequest: RailServiceSearchRequest[];
};

type RailServiceSearchRequest = {
    BookingTypeID: number;
    oldBookedOption: number;
    upgradeFlow: boolean;
    PriceTypeID: number | null;
    IsReturnTrip: boolean;
    ClientID: number;
    DiscountCode: {
        ReturnApplicableDiscounts: boolean;
        DiscountCode: string;
    };
    ReturnAllPriceTypes: number;
    SearchType: number;
    ServiceID: number | null;
    ConcessionTypes: RailServiceSearchConcessionType[];
    ReturnAllConcessionTypes: boolean;
    StopTypeID: number;
    RailRegions: RailServiceSearchRegion[];
    BookingReferenceNumber: string;
};

type RailServiceSearchConcessionType = {
    ConcessionTypeId: number;
    IsLead?: boolean;
    ConcessionTypeSequence: number;
    PassengerType: string; // e.g. ADULT
    ConcessionTypeName: string | null;
    BookedServiceId: string;
};

type RailServiceSearchRegion = {
    FromRegionID: number;
    ToRegionID: number;
    TravelDate: string; // e.g. "20 Feb 2026"
    ReturnFromRegionID: number;
    ReturnToRegionID: number;
    ReturnTravelDate: string;
    TotalAdults: number;
    TotalChildren: number;
    ChildrenAge: string[];
    ServiceTypeID: string;
    ReturnServiceTypeID: string;
    DiscountCode: string;
    TotalInfants: number;
    InfantAges: string[];
    ChildAges: string[];
};

type RailServiceSearchRequestOptions = {
    fromRegionId: number; // e.g. 6002
    toRegionId: number; // e.g. 6029
    travelDate: string; // e.g. "20 Feb 2026"
    returnDate?: string; // e.g. "21 Feb 2026"
    totalAdults?: number;
    totalChildren?: number;
    childAges?: string[]; // e.g. ["15"]
};

type SearchResultResponse = {
    success: boolean;
    href: string;
    fields: SearchResultFields;
};

type SearchResultFields = {
    raiL_SERVICES: RailServiceResult[];
    roEs: unknown[];
    dynamicRules: unknown[];
    discounT_SERVICES: null;
    responseList: unknown[];
    errorList: unknown[];
    xmlResponse: null;
    xmlRequest: null;
};

type RailServiceResult = {
    serviceid: number;
    servicE_NAME: string;
    starT_STATION: string;
    enD_STATION: string;
    traiN_NAME: string;
    traveL_DATE: string; // e.g. 2026-02-21T00:00:00
    currency: string; // e.g. AUD
    departurE_TIME: string; // uses sentinel date like 9999-12-31T05:15:00
    arrivaL_TIME: string; // uses sentinel date like 9999-12-31T09:55:00
    returN_JOURNEY: boolean;
    raiL_ROUTE_ID: number;
    raiL_OPTIONS: RailServiceOption[];
    days: number;
    startregioncode: string; // e.g. BDB
    endregioncode: string; // e.g. BNE
    routE_LEG_TYPES: null;
    applicableDiscounts: null;
    rail_Notes: null;
    servicetypeid: number;
    trainindexforsplitjourney: number;
};

type RailServiceOption = {
    servicE_OPTION_ID: number;
    servicE_OPTION_NAME: string;
    servicE_OPTION_TYPE: number;
    totaL_ADULTS: number;
    pricE_ID: number;
    adulT_PRICE: number;
    totaL_ADULT_PRICE: number;
    chilD_PRICES: RailServiceChildPrice[];
    agenT_COMMISSION: number;
    availablE_QUANTITY: number;
    bookinG_TYPE_ID: number;
    bookinG_TYPE: string;
    pricE_TYPE_ID: number;
    pricE_TYPE: string;
    seatinG_FOR: number;
    adulT_PRICE_WITH_DISCOUNT: number;
    totaL_ADULT_PRICE_WITH_DISCOUNT: number;
    applicablediscounts: null;
    agentgroupallocation: RailServiceAgentGroupAllocation;
    pricE_TYPE_TEXT: string; // HTML
    concessiontypeid: number;
    concessiontypenotes: null;
    loW_AVAILABILITY_THRESHOLD_VALUESpecified: boolean;
    loW_AVAILABILITY_THRESHOLD_TYPESpecified: boolean;
    isextra: boolean;
    totalcapacity: number;
    loW_AVAILABILITY_INDICATOR: boolean;
    concessionfee: number;
    servicE_OPTION_DESCRIPTION: string;
};

type RailServiceChildPrice = {
    totaL_CHILDREN: number;
    chilD_PRICE: number;
    totaL_CHILD_PRICE: number;
    froM_AGE: number;
    tO_AGE: number;
    agenT_CHILD_COMMISSION: number;
    chilD_PRICE_WITH_DISCOUNT: number;
    totaL_CHILD_PRICE_WITH_DISCOUNT: number;
    additionaL_CHILD_PRICE: number;
    additionaL_CHILD_PRICE_WITH_DISCOUNT: number;
    concessiontypeid: number;
    concessionfee: number;
};

type RailServiceAgentGroupAllocation = {
    estimateD_PICKUP: number;
    guaranteed: number;
    monthlY_QUOTA: number;
    bookable: number;
    maX_AVAILABLE: number;
    totaL_ALLOCATION: number;
};

function createRailServiceSearchRequest(
    options: RailServiceSearchRequestOptions,
): RailServiceSearchRequest {
    const childAges = options.childAges ?? [];
    const totalChildren = options.totalChildren ?? childAges.length;
    const totalAdults = options.totalAdults ?? 1;
    const isReturnTrip = Boolean(options.returnDate);

    const concessionTypes: RailServiceSearchConcessionType[] = [
        {
            ConcessionTypeId: 0,
            IsLead: true,
            ConcessionTypeSequence: 0,
            PassengerType: "ADULT",
            ConcessionTypeName: null,
            BookedServiceId: "0",
        },
    ];

    if (totalChildren > 0) {
        concessionTypes.push({
            ConcessionTypeId: 0,
            ConcessionTypeSequence: 0,
            PassengerType: "CHILD",
            ConcessionTypeName: null,
            BookedServiceId: "0",
        });
    }

    return {
        BookingTypeID: 1,
        oldBookedOption: 0,
        upgradeFlow: false,
        PriceTypeID: null,
        IsReturnTrip: isReturnTrip,
        ClientID: 0,
        DiscountCode: {
            ReturnApplicableDiscounts: false,
            DiscountCode: "",
        },
        ReturnAllPriceTypes: 1,
        SearchType: 0,
        ServiceID: null,
        ConcessionTypes: concessionTypes,
        ReturnAllConcessionTypes: false,
        StopTypeID: 1,
        RailRegions: [
            {
                FromRegionID: options.fromRegionId,
                ToRegionID: options.toRegionId,
                TravelDate: options.travelDate,
                ReturnFromRegionID: isReturnTrip ? options.toRegionId : 0,
                ReturnToRegionID: isReturnTrip ? options.fromRegionId : 0,
                ReturnTravelDate: options.returnDate ?? options.travelDate,
                TotalAdults: totalAdults,
                TotalChildren: totalChildren,
                ChildrenAge: childAges,
                ServiceTypeID: "",
                ReturnServiceTypeID: "",
                DiscountCode: "",
                TotalInfants: 0,
                InfantAges: [],
                ChildAges: childAges,
            },
        ],
        BookingReferenceNumber: "",
    };
}

function buildOdlAppSignature(
    url: string,
    params: null | Record<string, string> = null,
    appId: string = "BookingWebsite",
    keys: {
        k1: string;
        k2: string;
        k3: string;
        k4: string;
    } = {
            k1: "Ol4ZqzkegcLw==",
            k2: "46AGqjZio4CsE8",
            k3: "Zr3YgzcIjM+oCy",
            k4: "rcfMcajleMFZVa",
        },
): string {
    let u = url;

    if (params && Object.keys(params).length > 0) {
        const qs = Object.entries(params)
            .map((kv) => kv.map(encodeURIComponent).join("="))
            .join("&");
        u = `${u}?${qs}`;
    }

    const lowerUrl = u.toLowerCase();
    const nonce = CryptoJS.lib.WordArray.random(16);
    const ts = Math.floor(Date.now() / 1000);
    const hmacKey = keys.k4 + keys.k3 + keys.k2 + keys.k1;
    const message = appId + lowerUrl + ts + (nonce as any + ts);

    const hmac = CryptoJS.HmacSHA256(message, hmacKey);
    const sig = CryptoJS.enc.Base64.stringify(hmac);
    return `${appId},${sig},${nonce},${ts}`;
}

async function getSearchInput(): Promise<SearchInputResponse> {
    const url = "https://queenslandrailtravel-booking.opendestinations.com/bookingsiteapi/api/rail/searchinput";

    let res = await fetch(url, {
        headers: {
            Accept: "application/json, text/plain, */*",
            "Accept-Encoding": "gzip, deflate, br, zstd",
            "Accept-Language": "en-AU,en-US;q=0.9,en;q=0.8,en-CA;q=0.7",
            "Cache-Control": "no-cache",
            Pragma: "no-cache",
            Priority: "u=1, i",
            "Sec-Ch-Ua": '"Not(A:Brand";v="8", "Chromium";v="144", "Microsoft Edge";v="144"',
            "Sec-Ch-Ua-Mobile": "?0",
            "Sec-Ch-Ua-Platform": '"Windows"',
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "same-origin",
            "Sec-Gpc": "1",
            "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 Edg/144.0.0.0",
            "X-Odlapp-Signature": buildOdlAppSignature(url),
            Referer: "https://queenslandrailtravel-booking.opendestinations.com/BookingSite/rail/search",
        },
        body: null,
        method: "GET",
    });
    return await res.json();
}

async function searchRailServices(
    request: RailServiceSearchRequest | RailServiceSearchRequest[],
): Promise<SearchResultResponse> {
    const url = "https://queenslandrailtravel-booking.opendestinations.com/bookingsiteapi/api/rail/search";
    const body: RailServiceSearchRequestBody = {
        RailServiceSearchRequest: Array.isArray(request) ? request : [request],
    };

    const res = await fetch(url, {
        headers: {
            Accept: "application/json, text/plain, */*",
            "Accept-Language": "en-AU,en-US;q=0.9,en;q=0.8,en-CA;q=0.7",
            "Cache-Control": "no-cache",
            "Content-Type": "application/json",
            Pragma: "no-cache",
            Priority: "u=1, i",
            "Sec-Ch-Ua": '"Not(A:Brand";v="8", "Chromium";v="144", "Microsoft Edge";v="144"',
            "Sec-Ch-Ua-Mobile": "?0",
            "Sec-Ch-Ua-Platform": '"Windows"',
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "same-origin",
            "Sec-Gpc": "1",
            "X-Odlapp-Signature": buildOdlAppSignature(url),
            Referer: "https://queenslandrailtravel-booking.opendestinations.com/BookingSite/rail/search",
        },
        referrer: "https://queenslandrailtravel-booking.opendestinations.com/BookingSite/rail/search",
        body: JSON.stringify(body),
        method: "POST",
        mode: "cors",
        credentials: "omit",
    });

    return await res.json();
}

(async () => {
    const searchInput = await getSearchInput();
    const fromStation = searchInput.fields.stations.find(v => v.name.toLowerCase().includes("roma st"));
    if (!fromStation) {
        throw new Error("Could not find 'Roma St' station");
    }
    const toStation = searchInput.fields.stations.find(v => v.name.toLowerCase().includes("miriam vale"));
    if (!toStation) {
        throw new Error("Could not find 'Miriam Vale' station");
    }
    fs.writeFileSync("testout.json", JSON.stringify(await searchRailServices(
        createRailServiceSearchRequest({
            fromRegionId: fromStation.genericid,
            toRegionId: toStation.genericid,
            travelDate: "20 Feb 2026",
        })
    ), null, 2));
})().catch(err => console.error(err));
