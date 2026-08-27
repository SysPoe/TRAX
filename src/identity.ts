import type { QualifiedEntityId } from "qdf-gtfs";
import { qualifiedKey } from "./utils/corridor/keys.js";

export { qualifiedKey } from "./utils/corridor/keys.js";

export type EntityKind = "agency" | "place" | "station" | "stop" | "route" | "trip" | "shape" | "service" | "vehicle";

export interface PublicEntityIdentity extends QualifiedEntityId {
	networkId: string;
	kind: EntityKind;
}

export interface TripInstanceIdentity extends PublicEntityIdentity {
	kind: "trip";
	serviceDate: string;
	realtimeStartTime: string;
}

export function entityKey(entity: QualifiedEntityId): string {
	return qualifiedKey(entity.feedId, entity.localId);
}

export function parseEntityKey(key: string): QualifiedEntityId {
	const separator = key.indexOf(":");
	const feedLength = Number.parseInt(key.slice(0, separator), 10);
	if (separator < 1 || !Number.isInteger(feedLength) || feedLength < 0)
		throw new Error("Invalid qualified entity key");
	const feedStart = separator + 1;
	return { feedId: key.slice(feedStart, feedStart + feedLength), localId: key.slice(feedStart + feedLength) };
}

function encode(value: unknown): string {
	return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decode(value: string): unknown {
	return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

export function encodePublicEntityId(identity: PublicEntityIdentity): string {
	return encode([1, identity.networkId, identity.feedId, identity.kind, identity.localId]);
}

export function decodePublicEntityId(value: string): PublicEntityIdentity {
	const decoded = decode(value);
	if (
		!Array.isArray(decoded) ||
		decoded.length !== 5 ||
		decoded[0] !== 1 ||
		decoded.slice(1).some((part) => typeof part !== "string")
	) {
		throw new Error("Invalid public entity ID");
	}
	return { networkId: decoded[1], feedId: decoded[2], kind: decoded[3] as EntityKind, localId: decoded[4] };
}

export function encodeTripInstanceId(identity: TripInstanceIdentity): string {
	return encode([
		1,
		identity.networkId,
		identity.feedId,
		"trip",
		identity.localId,
		identity.serviceDate,
		identity.realtimeStartTime,
	]);
}

export function decodeTripInstanceId(value: string): TripInstanceIdentity {
	const decoded = decode(value);
	if (
		!Array.isArray(decoded) ||
		decoded.length !== 7 ||
		decoded[0] !== 1 ||
		decoded[3] !== "trip" ||
		decoded.slice(1).some((part) => typeof part !== "string")
	) {
		throw new Error("Invalid trip instance ID");
	}
	return {
		networkId: decoded[1],
		feedId: decoded[2],
		kind: "trip",
		localId: decoded[4],
		serviceDate: decoded[5],
		realtimeStartTime: decoded[6],
	};
}
