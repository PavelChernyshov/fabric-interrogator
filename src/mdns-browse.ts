import { createSocket } from "node:dgram";

const MDNS_ADDRESS = "224.0.0.251";
const MDNS_PORT = 5353;
const TYPE_PTR = 12;
const CLASS_IN = 1;
const MAX_POINTER_JUMPS = 16;

/** Encode a domain name into DNS wire format (length-prefixed labels). */
function encodeDnsName(name: string): Buffer {
    const parts = name.endsWith(".") ? name.slice(0, -1).split(".") : name.split(".");
    const bufs: Buffer[] = [];
    for (const part of parts) {
        bufs.push(Buffer.from([part.length]), Buffer.from(part));
    }
    bufs.push(Buffer.from([0]));
    return Buffer.concat(bufs);
}

/** Decode a DNS name from wire format, handling compressed pointers. */
function decodeDnsName(buf: Buffer, offset: number): [string, number] {
    const labels: string[] = [];
    let cur = offset;
    let jumped = false;
    let end = offset;
    let jumps = 0;
    for (;;) {
        if (cur >= buf.length) break;
        const len = buf[cur];
        if (len === 0) {
            cur++;
            if (!jumped) end = cur;
            break;
        }
        if ((len & 0xc0) === 0xc0) {
            // Guard against malicious pointer loops
            if (++jumps > MAX_POINTER_JUMPS) break;
            if (!jumped) end = cur + 2;
            cur = buf.readUInt16BE(cur) & 0x3fff;
            jumped = true;
            continue;
        }
        cur++;
        labels.push(buf.subarray(cur, cur + len).toString());
        cur += len;
    }
    if (!jumped) end = cur;
    return [labels.join("."), end];
}

/**
 * Browse for Matter operational nodes on a fabric via mDNS.
 * Sends a DNS-SD PTR query for the fabric's `_I<compressedFabricId>` subtype from a random port
 * (RFC 6762 §5.1 one-shot query, so responders reply unicast to us). IPv4 only.
 * Returns the node IDs found in the PTR targets. Addresses are not resolved here.
 */
export async function mdnsBrowseFabricNodes(fabricGlobalIdHex: string, timeoutMs: number): Promise<bigint[]> {
    const queryName = `_I${fabricGlobalIdHex}._sub._matter._tcp.local`;
    const nodeIds = new Set<bigint>();

    // Build DNS PTR query packet
    const qname = encodeDnsName(queryName);
    const header = Buffer.alloc(12);
    header.writeUInt16BE(1, 4); // QDCOUNT = 1
    const qfoot = Buffer.alloc(4);
    qfoot.writeUInt16BE(TYPE_PTR, 0);
    qfoot.writeUInt16BE(CLASS_IN, 2);
    const query = Buffer.concat([header, qname, qfoot]);

    return new Promise(resolve => {
        const sock = createSocket({ type: "udp4", reuseAddr: true });

        const timer = setTimeout(() => {
            sock.close();
            resolve([...nodeIds]);
        }, timeoutMs);

        sock.on("message", (msg) => {
            try {
                if (msg.length < 12) return;
                const ancount = msg.readUInt16BE(6);
                const nscount = msg.readUInt16BE(8);
                const arcount = msg.readUInt16BE(10);
                const qdcount = msg.readUInt16BE(4);
                let off = 12;

                // Skip questions
                for (let i = 0; i < qdcount; i++) {
                    const [, next] = decodeDnsName(msg, off);
                    off = next + 4;
                }

                // Parse answer + authority + additional sections for PTR records
                const totalRecords = ancount + nscount + arcount;
                for (let i = 0; i < totalRecords && off < msg.length; i++) {
                    const [, nameEnd] = decodeDnsName(msg, off);
                    off = nameEnd;
                    if (off + 10 > msg.length) break;
                    const rtype = msg.readUInt16BE(off);
                    const rdlen = msg.readUInt16BE(off + 8);
                    off += 10;
                    if (rtype === TYPE_PTR && off + rdlen <= msg.length) {
                        const [target] = decodeDnsName(msg, off);
                        // target format: <compFabricId>-<nodeIdHex>._matter._tcp.local
                        const match = target.match(/^([0-9A-Fa-f]+)-([0-9A-Fa-f]+)\._matter\._tcp\.local$/);
                        if (match && match[1].toUpperCase() === fabricGlobalIdHex.toUpperCase()) {
                            nodeIds.add(BigInt("0x" + match[2]));
                        }
                    }
                    off += rdlen;
                }
            } catch {
                // Ignore malformed packets
            }
        });

        sock.on("error", () => {
            clearTimeout(timer);
            sock.close();
            resolve([...nodeIds]);
        });

        sock.bind(0, () => {
            sock.send(query, MDNS_PORT, MDNS_ADDRESS);
            // Send a second query after 1s for reliability
            setTimeout(() => {
                try { sock.send(query, MDNS_PORT, MDNS_ADDRESS); } catch {}
            }, 1000);
        });
    });
}
