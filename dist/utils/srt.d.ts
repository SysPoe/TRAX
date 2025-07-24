export declare type SRTMatrix = {
    [from: string]: {
        [to: string]: number;
    };
};
export declare function getSRT(from: string, to: string): number | undefined;
