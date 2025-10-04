export type Platform = {
    platform_code: number;
    trackName: string;
    trackCode: string;
    next: string[];
    exitSide: "left" | "right" | "both";
};
export type PlatformData = {
    [gtfs_stop_id: string]: Platform[];
};
export declare const platformData: PlatformData;
export default platformData;
