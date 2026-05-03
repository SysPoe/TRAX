import bilevelData from "../../../../data/region-specific/CA/GTHA/bilevel_registry.json" with { type: "json" };

export type BilevelCarEntry = {
	serial_number: string | null;
	delivery_date: string | null;
	notes: string[];
	series: string;
	is_accessible: boolean;
};

export const BILEVEL_REGISTRY = bilevelData as Record<string, BilevelCarEntry>;
