import type { ReadResult } from "@matter/protocol";
import { attributeName, clusterName, formatAttrValue, statusText } from "./format.js";
import { isSuccess, type NodeOutcome, type NodeReport } from "./interrogate.js";

// Clusters that expose credentials, ACLs and network addresses — hidden unless showSensitive is set
const SENSITIVE_CLUSTERS = new Set([
    0x001f, // AccessControl
    0x0033, // GeneralDiagnostics
    0x003e, // OperationalCredentials
]);

const PEER_OUTCOME_LABELS: [NodeOutcome, string][] = [
    ["readable", "readable"],
    ["partial", "partial access"],
    ["denied", "access denied"],
    ["unreachable", "unreachable"],
    ["error", "error"],
];

export function displayReports(reports: NodeReport[], showSensitive = false) {
    if (reports.length === 0) {
        console.log("No device data to display.");
        return;
    }

    console.log("\n" + "═".repeat(70));
    console.log("  FABRIC DEVICE REPORT");
    console.log("═".repeat(70));

    for (const report of reports) {
        displayReport(report, showSensitive);
    }

    const peers = reports.filter(r => r.outcome !== "local");
    const byOutcome = Map.groupBy(peers, r => r.outcome);
    const breakdown = PEER_OUTCOME_LABELS
        .filter(([outcome]) => byOutcome.has(outcome))
        .map(([outcome, label]) => `${byOutcome.get(outcome)!.length} ${label}`);
    console.log(`\nSummary: ${peers.length} peer(s)${breakdown.length ? " — " + breakdown.join(", ") : ""}`);

    if (!showSensitive) {
        const hidden = [...SENSITIVE_CLUSTERS].map(clusterName).join(", ");
        console.log(`\nHidden: ${hidden} (use --show-sensitive to include)`);
    }

    console.log("\n" + "═".repeat(70));
}

function displayReport(report: NodeReport, showSensitive: boolean) {
    const tag = report.label ? ` (${report.label})` : "";
    console.log(`\n┌── Node: ${report.nodeId}${tag}`);
    console.log(`│  ${isSuccess(report.outcome) ? "✓" : "✗"} ${report.verdict}`);

    const values = report.results
        .filter((r): r is ReadResult.AttributeValue => r.kind === "attr-value")
        .filter(r => showSensitive || !SENSITIVE_CLUSTERS.has(r.path.clusterId))
        .sort((a, b) => a.path.endpointId - b.path.endpointId || a.path.clusterId - b.path.clusterId);

    for (const [endpointId, endpointValues] of Map.groupBy(values, v => v.path.endpointId)) {
        console.log(`│`);
        console.log(`├── Endpoint ${endpointId}`);
        for (const [clusterId, clusterValues] of Map.groupBy(endpointValues, v => v.path.clusterId)) {
            console.log(`│   ├── ${clusterName(clusterId)}`);
            for (const { path, value } of clusterValues) {
                console.log(`│   │   ${attributeName(clusterId, path.attributeId)}: ${formatAttrValue(clusterId, path.attributeId, value)}`);
            }
        }
    }

    const errors = report.results.filter(r => r.kind === "attr-status");
    if (errors.length > 0) {
        console.log(`│`);
        console.log(`├── Errors:`);
        for (const { path, status } of errors) {
            console.log(`│   EP${path.endpointId}/${clusterName(path.clusterId)}/${attributeName(path.clusterId, path.attributeId)}: ${statusText(status)}`);
        }
    }

    console.log("└" + "─".repeat(50));
}
