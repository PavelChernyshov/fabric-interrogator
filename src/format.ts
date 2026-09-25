import { MatterModel, Metatype } from "@matter/model";
import type { ClusterModel, ValueModel } from "@matter/model";
import { Status } from "@matter/types";

// Pure helpers that turn numeric Matter IDs and decoded values into readable text.

// Well-known global attribute IDs (Matter spec §7.13)
const GENERATED_COMMAND_LIST = 0xfff8;
const ACCEPTED_COMMAND_LIST = 0xfff9;
const EVENT_LIST = 0xfffa;
const ATTRIBUTE_LIST = 0xfffb;

const clusterCache = new Map<number, ClusterModel | undefined>();
function findCluster(clusterId: number): ClusterModel | undefined {
    if (!clusterCache.has(clusterId)) {
        clusterCache.set(clusterId, MatterModel.standard.clusters.find(c => c.id === clusterId));
    }
    return clusterCache.get(clusterId);
}

const hex = (id: number, width = 4) => `0x${id.toString(16).toUpperCase().padStart(width, "0")}`;

export function clusterName(clusterId: number): string {
    return findCluster(clusterId)?.name ?? `Cluster(${hex(clusterId)})`;
}

export function attributeName(clusterId: number, attributeId: number): string {
    return findCluster(clusterId)?.attributes.for(attributeId)?.name ?? `Attribute(${hex(attributeId)})`;
}

export function statusText(status: number): string {
    return `${Status[status] ?? "Unknown"} (${hex(status, 2)})`;
}

/** Formats an attribute value using the Matter model: enum names, set bitmap flags, command/attribute/event names. */
export function formatAttrValue(clusterId: number, attributeId: number, value: unknown): string {
    const cluster = findCluster(clusterId);
    const attr = cluster?.attributes.for(attributeId);
    if (!cluster || !attr) return formatValue(value);

    if (Array.isArray(value)) {
        const members = globalListMembers(cluster, attributeId);
        if (members) return joinTruncated(value.map(id => members.for(id)?.name ?? formatValue(id)));

        const entry = attr.listEntry;
        if (entry?.effectiveMetatype === Metatype.enum && entry.definingModel) {
            const defModel = entry.definingModel;
            return joinTruncated(value.map(v => enumName(defModel, v)));
        }
        return formatValue(value);
    }

    if (attr.effectiveMetatype === Metatype.enum && attr.definingModel) {
        return enumName(attr.definingModel, value);
    }

    // matter.js decodes bitmaps into objects of flag → boolean/number
    if (attr.effectiveMetatype === Metatype.bitmap && isRecord(value)) {
        const set = Object.entries(value).filter(([, v]) => v !== false && v !== 0);
        if (set.length === 0) return "none";
        return set.map(([k, v]) => (v === true ? k : `${k}=${formatValue(v)}`)).join(" | ");
    }

    return formatValue(value);
}

/** Generic formatting for any decoded TLV value. */
export function formatValue(value: unknown): string {
    if (value === null || value === undefined) return "null";
    if (typeof value === "string") return `"${value}"`;
    if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString("hex")}`;
    if (Array.isArray(value)) return value.length === 0 ? "[]" : joinTruncated(value.map(formatValue));
    if (isRecord(value)) {
        const fields = Object.entries(value).map(([k, v]) => `${k}: ${formatValue(v)}`);
        return `{${fields.join(", ")}}`;
    }
    return String(value);
}

function globalListMembers(cluster: ClusterModel, attributeId: number) {
    switch (attributeId) {
        case ACCEPTED_COMMAND_LIST:
        case GENERATED_COMMAND_LIST:
            return cluster.commands;
        case ATTRIBUTE_LIST:
            return cluster.attributes;
        case EVENT_LIST:
            return cluster.events;
    }
    return undefined;
}

function enumName(defModel: ValueModel, value: unknown): string {
    const member = defModel.children.find(child => child.effectiveId === value);
    return member ? `${member.name} (${value})` : formatValue(value);
}

function joinTruncated(items: string[]): string {
    if (items.length <= 5) return `[${items.join(", ")}]`;
    return `[${items.slice(0, 3).join(", ")}, ... (${items.length} items)]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array);
}
