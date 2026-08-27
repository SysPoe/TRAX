import type { CorridorIndex } from "./shapeIndex.js";
import { normalizeStationName } from "./geometry.js";
import { qualifiedKey } from "./keys.js";
import { parseEntityKey } from "../../identity.js";
import type {
	CorridorConfidence,
	CorridorGapResolution,
	CorridorNode,
	JourneyAnchor,
	JourneyContext,
	ManualCorridorNode,
	ManualNetwork,
	CorridorResolutionConfig,
} from "./types.js";

interface ManualEdge {
	to: string;
	minutes: number | null;
}

export interface ManualPath {
	networkId: string;
	nodes: string[];
	minutes: Array<number | null>;
	evidence: "manual-corridor" | "manual-topology";
}

function nodeKey(network: ManualNetwork, id: string): string {
	return qualifiedKey(network.feedId, `${network.id}\0${id}`);
}

function networkKey(network: ManualNetwork): string {
	return qualifiedKey(network.feedId, network.id);
}

function manualStationId(network: ManualNetwork, node: ManualCorridorNode): string | null {
	if (node.stationId == null || node.stationId === "") return null;
	try {
		parseEntityKey(node.stationId);
		return node.stationId;
	} catch {
		return qualifiedKey(network.feedId, node.stationId);
	}
}

function scopeMatches(
	routeId: string | null,
	direction: string | number | null,
	routeIds?: readonly string[],
	directions?: readonly (string | number | null)[],
): boolean {
	if (routeIds && routeIds.length > 0 && (routeId == null || !routeIds.includes(routeId))) return false;
	if (directions && directions.length > 0 && !directions.some((candidate) => String(candidate) === String(direction)))
		return false;
	return true;
}

function nodeMatchesAnchor(
	network: ManualNetwork,
	node: ManualCorridorNode,
	anchor: JourneyAnchor,
	index: CorridorIndex,
): boolean {
	const stationId = manualStationId(network, node);
	if (stationId && stationId === anchor.stationId) return true;
	const anchorName = anchor.name ? normalizeStationName(anchor.name) : "";
	if (!anchorName) return false;
	const names = [node.name, ...(node.aliases ?? [])].filter((name): name is string => Boolean(name));
	if (names.some((name) => normalizeStationName(name) === anchorName)) return true;
	if (stationId)
		return (
			index.stationGeometry.get(stationId)?.names.some((name) => normalizeStationName(name) === anchorName) ??
			false
		);
	return false;
}

function pathMinutes(network: ManualNetwork, nodes: readonly string[]): Array<number | null> {
	const byPair = new Map<string, number | null>();
	for (const edge of network.edges ?? []) {
		byPair.set(`${nodeKey(network, edge.from)}|${nodeKey(network, edge.to)}`, edge.minutes ?? null);
		if (edge.bidirectional)
			byPair.set(`${nodeKey(network, edge.to)}|${nodeKey(network, edge.from)}`, edge.minutes ?? null);
	}
	for (const corridor of network.corridors ?? []) {
		for (let index = 1; index < corridor.nodes.length; index++) {
			const from = nodeKey(network, corridor.nodes[index - 1]);
			const to = nodeKey(network, corridor.nodes[index]);
			byPair.set(`${from}|${to}`, byPair.get(`${from}|${to}`) ?? null);
			if (corridor.bidirectional) byPair.set(`${to}|${from}`, byPair.get(`${from}|${to}`) ?? null);
		}
	}
	return nodes.slice(1).map((to, index) => byPair.get(`${nodes[index]}|${to}`) ?? null);
}

function addEdge(adjacency: Map<string, ManualEdge[]>, from: string, to: string, minutes: number | null): void {
	const edges = adjacency.get(from) ?? [];
	if (!edges.some((edge) => edge.to === to)) edges.push({ to, minutes });
	else {
		const existing = edges.find((edge) => edge.to === to)!;
		if (existing.minutes == null && minutes != null) existing.minutes = minutes;
	}
	adjacency.set(from, edges);
}

function pathStationSignature(
	network: ManualNetwork,
	nodes: readonly string[],
	byId: ReadonlyMap<string, ManualCorridorNode>,
	index: CorridorIndex,
): string {
	const stationIds = nodes
		.map((key) => {
			const node = byId.get(key)!;
			if (node.kind === "waypoint") return null;
			const stationId = manualStationId(network, node);
			if (stationId) return stationId;
			const nodeNames = [node.name, ...(node.aliases ?? [])]
				.filter((name): name is string => Boolean(name))
				.map(normalizeStationName);
			const match = [...index.stationGeometry.entries()].find(([, geometry]) =>
				geometry.names.some((name) => nodeNames.includes(normalizeStationName(name))),
			);
			return match?.[0] ?? key;
		})
		.filter((stationId): stationId is string => stationId !== null);
	const uniqueStationIds = stationIds.filter(
		(stationId, index) => index === 0 || stationId !== stationIds[index - 1],
	);
	return uniqueStationIds.join("|");
}

function explicitPath(
	network: ManualNetwork,
	from: JourneyAnchor,
	to: JourneyAnchor,
	index: CorridorIndex,
	journey: JourneyContext,
): ManualPath | "ambiguous" | null {
	const nodesByKey = new Map(network.nodes.map((node) => [nodeKey(network, node.id), node]));
	const paths: string[][] = [];
	for (const corridor of network.corridors ?? []) {
		if (!scopeMatches(journey.routeId, journey.direction, corridor.routeIds, corridor.directions)) continue;
		const path = corridor.nodes.map((id) => nodeKey(network, id));
		if (path.some((key) => !nodesByKey.has(key))) continue;
		const findSlices = (candidate: string[]): string[][] => {
			const matches: string[][] = [];
			for (const [fromIndex, fromKey] of candidate.entries()) {
				const fromNode = nodesByKey.get(fromKey);
				if (!fromNode || !nodeMatchesAnchor(network, fromNode, from, index)) continue;
				for (const [toIndex, toKey] of candidate.entries()) {
					const toNode = nodesByKey.get(toKey);
					if (toIndex <= fromIndex || !toNode || !nodeMatchesAnchor(network, toNode, to, index)) continue;
					matches.push(candidate.slice(fromIndex, toIndex + 1));
				}
			}
			return matches;
		};
		paths.push(...findSlices(path));
		if (corridor.bidirectional) paths.push(...findSlices([...path].reverse()));
	}
	if (paths.length === 0) return null;
	const signatures = new Set(paths.map((path) => pathStationSignature(network, path, nodesByKey, index)));
	if (signatures.size > 1) return "ambiguous";
	const selected = paths[0];
	return {
		networkId: networkKey(network),
		nodes: selected,
		minutes: pathMinutes(network, selected),
		evidence: "manual-corridor",
	};
}

function topologyPath(
	network: ManualNetwork,
	from: JourneyAnchor,
	to: JourneyAnchor,
	index: CorridorIndex,
	journey: JourneyContext,
): ManualPath | "ambiguous" | null {
	const nodesByKey = new Map(network.nodes.map((node) => [nodeKey(network, node.id), node]));
	const start = [...nodesByKey.entries()]
		.filter(([, node]) => nodeMatchesAnchor(network, node, from, index))
		.map(([key]) => key);
	const ends = new Set(
		[...nodesByKey.entries()].filter(([, node]) => nodeMatchesAnchor(network, node, to, index)).map(([key]) => key),
	);
	if (start.length === 0 || ends.size === 0) return null;

	const adjacency = new Map<string, ManualEdge[]>();
	for (const corridor of network.corridors ?? []) {
		if (!scopeMatches(journey.routeId, journey.direction, corridor.routeIds, corridor.directions)) continue;
		for (let index = 1; index < corridor.nodes.length; index++) {
			const previous = nodeKey(network, corridor.nodes[index - 1]);
			const current = nodeKey(network, corridor.nodes[index]);
			addEdge(adjacency, previous, current, null);
			if (corridor.bidirectional) addEdge(adjacency, current, previous, null);
		}
	}
	for (const edge of network.edges ?? []) {
		if (!scopeMatches(journey.routeId, journey.direction, edge.routeIds, edge.directions)) continue;
		const fromKey = nodeKey(network, edge.from);
		const toKey = nodeKey(network, edge.to);
		if (!nodesByKey.has(fromKey) || !nodesByKey.has(toKey)) continue;
		addEdge(adjacency, fromKey, toKey, edge.minutes ?? null);
		if (edge.bidirectional) addEdge(adjacency, toKey, fromKey, edge.minutes ?? null);
	}

	const queue = start.map((key) => [key]);
	let queueIndex = 0;
	const paths: string[][] = [];
	const signatures = new Set<string>();
	const maxExploredPaths = 5_000;
	while (queueIndex < queue.length) {
		if (queueIndex >= maxExploredPaths) return "ambiguous";
		const path = queue[queueIndex++];
		const current = path.at(-1)!;
		if (ends.has(current)) {
			paths.push(path);
			signatures.add(pathStationSignature(network, path, nodesByKey, index));
			if (signatures.size > 1) return "ambiguous";
			continue;
		}
		for (const edge of adjacency.get(current) ?? []) {
			if (path.includes(edge.to)) continue;
			queue.push([...path, edge.to]);
		}
	}
	if (paths.length === 0) return null;

	const path = paths[0];
	return {
		networkId: networkKey(network),
		nodes: path,
		minutes: pathMinutes(network, path),
		evidence: "manual-topology",
	};
}

function toNode(
	network: ManualNetwork,
	node: ManualCorridorNode,
	anchor: JourneyAnchor | null,
	index: CorridorIndex,
	evidence: ManualPath["evidence"],
	confidence: CorridorConfidence,
): CorridorNode {
	const configuredStationId = manualStationId(network, node);
	const geometryStation = configuredStationId ? index.stationGeometry.get(configuredStationId) : undefined;
	const nodeNames = [node.name, ...(node.aliases ?? [])]
		.filter((name): name is string => Boolean(name))
		.map(normalizeStationName);
	const nameMatch = [...index.stationGeometry.entries()].find(([, geometry]) =>
		geometry.names.some((name) => nodeNames.includes(normalizeStationName(name))),
	);
	const stationId = anchor?.stationId ?? configuredStationId ?? nameMatch?.[0] ?? null;
	return {
		id: nodeKey(network, node.id),
		stationId,
		name: node.name ?? geometryStation?.names[0],
		kind: node.kind,
		scheduled: Boolean(anchor),
		passing: !anchor && node.kind === "station",
		evidence,
		confidence,
	};
}

function resolveNetworkGap(
	network: ManualNetwork,
	from: JourneyAnchor,
	to: JourneyAnchor,
	index: CorridorIndex,
	journey: JourneyContext,
): { path: ManualPath; nodes: CorridorNode[] } | "ambiguous" | null {
	const byId = new Map(network.nodes.map((node) => [nodeKey(network, node.id), node]));
	const path = explicitPath(network, from, to, index, journey) ?? topologyPath(network, from, to, index, journey);
	if (!path || path === "ambiguous") return path;
	const confidence: CorridorConfidence = path.evidence === "manual-corridor" ? "high" : "medium";
	const nodes = path.nodes.map((key, nodeIndex) =>
		toNode(
			network,
			byId.get(key)!,
			nodeIndex === 0 ? from : nodeIndex === path.nodes.length - 1 ? to : null,
			index,
			path.evidence,
			confidence,
		),
	);
	return { path, nodes };
}

/** Resolve one gap through configured ordered corridors or unique topology. */
export function resolveManualGap(
	from: JourneyAnchor,
	to: JourneyAnchor,
	journey: JourneyContext,
	index: CorridorIndex,
	config: CorridorResolutionConfig,
): { resolution: CorridorGapResolution; path: ManualPath } | { ambiguous: true } | null {
	const networks = config.manualNetworks.filter(
		(network) =>
			network.feedId === journey.feedId &&
			(!network.sourceIds || network.sourceIds.length === 0 || network.sourceIds.includes(journey.sourceId)),
	);
	for (const priority of ["authoritative", "fallback"] as const) {
		const priorityNetworks = networks
			.filter((network) => (network.priority ?? "fallback") === priority)
			.sort((a, b) => a.id.localeCompare(b.id));
		let selected: { path: ManualPath; nodes: CorridorNode[] } | null = null;
		let selectedSignature: string | null = null;
		for (const network of priorityNetworks) {
			const result = resolveNetworkGap(network, from, to, index, journey);
			if (result === "ambiguous") return { ambiguous: true };
			if (!result) continue;
			const signature = result.nodes
				.filter((node) => node.kind === "station")
				.map((node) => node.stationId ?? node.id)
				.join("|");
			if (selectedSignature !== null && selectedSignature !== signature) return { ambiguous: true };
			selectedSignature = signature;
			selected ??= result;
		}
		if (selected) {
			return {
				path: selected.path,
				resolution: {
					status: "resolved",
					from,
					to,
					nodes: selected.nodes,
					evidence: selected.path.evidence,
					confidence: selected.nodes[0]?.confidence ?? "medium",
				},
			};
		}
	}
	return null;
}

/** Return a configured manual edge duration for timing interpolation. */
export function manualEdgeMinutes(
	fromId: string,
	toId: string,
	config: CorridorResolutionConfig,
	journey?: Pick<JourneyContext, "feedId" | "routeId" | "direction">,
): number | null {
	for (const network of config.manualNetworks) {
		if (journey && network.feedId !== journey.feedId) continue;
		for (const edge of network.edges ?? []) {
			if (journey && !scopeMatches(journey.routeId, journey.direction, edge.routeIds, edge.directions)) continue;
			const direct = nodeKey(network, edge.from) === fromId && nodeKey(network, edge.to) === toId;
			const reverse =
				edge.bidirectional && nodeKey(network, edge.to) === fromId && nodeKey(network, edge.from) === toId;
			if (direct || reverse) return edge.minutes ?? null;
		}
		for (const corridor of network.corridors ?? []) {
			for (let index = 1; index < corridor.nodes.length; index++) {
				const from = nodeKey(network, corridor.nodes[index - 1]);
				const to = nodeKey(network, corridor.nodes[index]);
				if ((from === fromId && to === toId) || (corridor.bidirectional && from === toId && to === fromId))
					return null;
			}
		}
	}
	return null;
}
