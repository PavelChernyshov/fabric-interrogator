import type { ClientNode, ServerNode } from "@matter/main";
import { Fabric, FabricManager, FabricAuthority, ScannerSet, MdnsClient, PeerAddress, Read, ReadResult, type ClientRead } from "@matter/protocol";
import { EndpointNumber, NodeId } from "@matter/main/types";
import { BasicInformationCluster } from "@matter/types/clusters";
import { Status } from "@matter/types";
import { mdnsBrowseFabricNodes } from "./mdns-browse.js";
import { clusterName, formatValue, statusText } from "./format.js";

// Apple Home adds a second "Apple Keychain" fabric when commissioning; it has no peers worth reading.
const APPLE_KEYCHAIN_VENDOR = 0x1384;
const MDNS_SCAN_TIME = 5_000;
const NODE_TIMEOUT = 15_000;

const WILDCARD_READ: ClientRead = { ...Read(Read.Attribute()), includeKnownVersions: true };
const CONCRETE_PATH = "ep0/BasicInformation/VendorName";
const CONCRETE_READ: ClientRead = {
    ...Read(Read.Attribute({ endpoint: EndpointNumber(0), cluster: BasicInformationCluster, attributes: "vendorName" })),
    includeKnownVersions: true,
};

export type NodeOutcome = "local" | "readable" | "partial" | "denied" | "unreachable" | "error";

export interface NodeReport {
    nodeId: string;
    label?: string;
    outcome: NodeOutcome;
    /** Human-readable explanation of the outcome */
    verdict: string;
    results: ReadResult.Report[];
}

export function isSuccess(outcome: NodeOutcome): boolean {
    return outcome === "local" || outcome === "readable" || outcome === "partial";
}

export async function interrogateFabric(server: ServerNode): Promise<NodeReport[]> {
    console.log("Scanning for peers on the fabric...");

    const fabrics = externalFabrics(server);
    if (fabrics.length === 0) {
        console.log("No external fabrics found. Is this device commissioned into a fabric?");
        return [];
    }

    const reports: NodeReport[] = [];
    for (const fabric of fabrics) {
        console.log(`\nDiscovering nodes on fabric ${fabricIdHex(fabric)} (index ${fabric.fabricIndex})...`);
        const peerNodeIds = await discoverPeers(server, fabric);
        console.log(`  Found ${peerNodeIds.length} peer(s) + our node ${fabric.nodeId}. Reading all nodes...\n`);

        reports.push(readLocalNode(server, fabric.nodeId));
        for (const nodeId of peerNodeIds) {
            reports.push(await readPeerNode(server, fabric, nodeId));
        }
    }
    return reports;
}

/** Fabrics we were commissioned into by someone else (not our own controller fabric, not Apple Keychain). */
function externalFabrics(server: ServerNode): Fabric[] {
    const fabrics = [...server.env.get(FabricManager).fabrics];
    const authority = server.env.has(FabricAuthority) ? server.env.get(FabricAuthority) : undefined;
    const role = (f: Fabric) => {
        if (authority?.hasControlOf(f)) return "ours";
        if (f.rootVendorId === APPLE_KEYCHAIN_VENDOR) return "skipped: Apple Keychain";
        return "external";
    };

    console.log(`\nFabrics: ${fabrics.length} total`);
    for (const f of fabrics) {
        const vendorHex = "0x" + f.rootVendorId.toString(16).toUpperCase();
        console.log(`  [${f.fabricIndex}] ${fabricIdHex(f)}  label=${JSON.stringify(f.label)}  vendor=${vendorHex}  ourNode=${f.nodeId}  (${role(f)})`);
    }

    return fabrics.filter(f => role(f) === "external");
}

async function discoverPeers(server: ServerNode, fabric: Fabric): Promise<bigint[]> {
    // Ask matter.js's own mDNS client to track this fabric's operational records, so peers get resolvable addresses
    const mdnsClient = [...server.env.get(ScannerSet)].find((s): s is MdnsClient => s instanceof MdnsClient);
    mdnsClient?.targetCriteriaProviders.add({
        commissionable: false,
        operationalTargets: [{ fabricId: fabric.globalId }],
    });

    console.log(`  Browsing mDNS for ${MDNS_SCAN_TIME / 1000}s...`);
    const nodeIds = await mdnsBrowseFabricNodes(fabricIdHex(fabric), MDNS_SCAN_TIME);
    return nodeIds.filter(id => id !== fabric.nodeId);
}

function readLocalNode(server: ServerNode, ourNodeId: bigint): NodeReport {
    console.log(`  Reading node ${ourNodeId} (ours)...`);
    const results = readLocalAttributes(server);
    const verdict = `${results.length} attributes read locally (no ACL applies to our own state)`;
    console.log(`    ✓ ${verdict}`);
    return { nodeId: String(ourNodeId), label: "ours", outcome: "local", verdict, results };
}

async function readPeerNode(server: ServerNode, fabric: Fabric, nodeId: bigint): Promise<NodeReport> {
    console.log(`  Reading node ${nodeId}...`);
    const timedOut = `timed out after ${NODE_TIMEOUT / 1000}s`;
    const report = (outcome: NodeOutcome, verdict: string, results: ReadResult.Report[] = []): NodeReport => {
        console.log(`    ${isSuccess(outcome) ? "✓" : "✗"} ${verdict}`);
        return { nodeId: String(nodeId), outcome, verdict, results };
    };

    try {
        const clientNode = await server.peers.forAddress(PeerAddress({ fabricIndex: fabric.fabricIndex, nodeId: NodeId(nodeId) }));

        // 1. Wildcard read: ACL-denied paths are silently omitted, so an empty result means "no access"
        const wildcard = await readWithTimeout(clientNode, WILDCARD_READ);
        const values = wildcard?.filter(r => r.kind === "attr-value") ?? [];
        const clusterIds = [...new Set(values.map(v => v.path.clusterId))];

        if (wildcard === undefined) {
            console.log(`    wildcard read:  ${timedOut}`);
        } else if (values.length === 0) {
            console.log(`    wildcard read:  0 attributes (devices silently omit ACL-denied paths from wildcard reads)`);
        } else {
            const clusterList = clusterIds.length <= 3 ? ` (${clusterIds.map(clusterName).join(", ")})` : "";
            console.log(`    wildcard read:  ${values.length} attributes from ${clusterIds.length} cluster(s)${clusterList}`);
        }

        // Every node has BasicInformation on endpoint 0, so seeing it means we're not ACL-restricted
        if (clusterIds.includes(BasicInformationCluster.id)) {
            return report("readable", `readable: ${values.length} attributes from ${clusterIds.length} cluster(s)`, wildcard);
        }
        if (values.length > 0) {
            return report("partial", "partial access: this device has an ACL entry for us, but it's narrow", wildcard);
        }

        // 2. Concrete read: an ACL-denied concrete path returns an explicit UnsupportedAccess status
        const concrete = await readWithTimeout(clientNode, CONCRETE_READ);
        if (concrete === undefined) {
            console.log(`    concrete read:  ${CONCRETE_PATH} → ${timedOut}`);
            return report("unreachable", "unreachable (offline, or a sleepy/ICD device that didn't wake up in time)");
        }

        const value = concrete.find(r => r.kind === "attr-value");
        if (value) {
            console.log(`    concrete read:  ${CONCRETE_PATH} → ${formatValue(value.value)}`);
            return report("partial", "partial access: wildcard reads are filtered, but concrete reads are allowed", concrete);
        }

        const status = concrete.find(r => r.kind === "attr-status");
        if (!status) {
            console.log(`    concrete read:  ${CONCRETE_PATH} → empty response`);
            return report("error", "error: empty response to a concrete read", concrete);
        }

        console.log(`    concrete read:  ${CONCRETE_PATH} → ${statusText(status.status)}`);
        if (status.status === Status.UnsupportedAccess) {
            return report("denied", "access denied: no ACL entry on this device grants our node read access", concrete);
        }
        return report("error", `error: unexpected status ${statusText(status.status)}`, concrete);

    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("no known address")) {
            return report("unreachable", "unreachable: no address known for this node (it wasn't resolved via mDNS during the scan)");
        }
        return report("error", `error: ${message}`);
    }
}

/**
 * Resolves to undefined if the peer doesn't finish responding within NODE_TIMEOUT.
 * matter.js reads can't be aborted individually, so a timed-out read keeps running in the background.
 */
async function readWithTimeout(clientNode: ClientNode, request: ClientRead): Promise<ReadResult.Report[] | undefined> {
    const collect = async () => {
        const results: ReadResult.Report[] = [];
        for await (const chunk of clientNode.interaction.read(request)) {
            results.push(...chunk);
        }
        return results;
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>(resolve => {
        timer = setTimeout(() => resolve(undefined), NODE_TIMEOUT);
    });
    return Promise.race([collect(), timeout]).finally(() => clearTimeout(timer));
}

/** Our own attributes, read straight from local state (no network, no ACL). */
function readLocalAttributes(server: ServerNode): ReadResult.AttributeValue[] {
    const results: ReadResult.AttributeValue[] = [];
    for (const endpoint of server.endpoints) {
        for (const behaviorType of Object.values(endpoint.behaviors.supported)) {
            const cluster = (behaviorType as any).cluster;
            if (cluster?.id === undefined) continue;

            const state = endpoint.stateOf(behaviorType) as Record<string, unknown>;
            for (const [attrName, value] of Object.entries(state)) {
                const attrDef = cluster.attributes[attrName];
                if (!attrDef) continue;
                results.push({
                    kind: "attr-value",
                    path: { endpointId: endpoint.number, clusterId: cluster.id, attributeId: attrDef.id },
                    value,
                    version: 0,
                    tlv: undefined as any,
                });
            }
        }
    }
    return results;
}

function fabricIdHex(fabric: Fabric): string {
    return fabric.globalId.toString(16).toUpperCase().padStart(16, "0");
}
