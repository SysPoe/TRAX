export interface ExpressInfo {
    type: "express" | "local" | "unknown_segment";
    from: string;
    to: string;
    skipping?: string[];
    message?: string;
}
export declare function findExpress(givenStops: string[], combosData?: string[][]): ExpressInfo[];
export declare function findExpressString(expressData: ExpressInfo[], stop_id: string): string;
declare const _default: {
    findExpress: typeof findExpress;
    findExpressString: typeof findExpressString;
};
export default _default;
