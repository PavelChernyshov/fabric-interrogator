#!/usr/bin/env node

import { ControllerBehavior, Environment, Logger, ServerNode, StorageService } from "@matter/main";
import { DeviceTypeId, VendorId } from "@matter/main/types";
import { QrCode } from "@matter/types";
import { createWriteStream, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { interrogateFabric } from "./interrogate.js";
import { displayReports } from "./display.js";

const environment = Environment.default;

// Redirect matter.js logs to ./logs/matter.log so the console only shows our output
const logDir = join(dirname(fileURLToPath(import.meta.url)), "..", "logs");
mkdirSync(logDir, { recursive: true });
const logPath = join(logDir, "matter.log");
const logFile = createWriteStream(logPath, { flags: "a" });
Logger.destinations.default.write = text => logFile.write(text + "\n");
const logger = Logger.get("FabricInterrogator");

/** Flushes the log file before exiting; process.exit alone drops buffered writes. */
function exit(code: number) {
    logFile.end(() => process.exit(code));
}

// BLE is an optional dependency; commissioning over IP works without it
await import("@matter/nodejs-ble").catch(error => logger.info("BLE support unavailable:", error));

console.log(`Storage: ${environment.get(StorageService).location}`);
console.log(`Logs:    ${logPath}`);
console.log('Use "--storage-path=NAME-OR-PATH" for a different storage location, "--storage-clear" to start fresh.\n');

async function main() {
    // A commissionable device that can also act as a controller to read its peers
    const server = await ServerNode.create(ServerNode.RootEndpoint.with(ControllerBehavior), {
        id: "fabric-interrogator",
        commissioning: {
            passcode: environment.vars.number("passcode") ?? 20202021,
            discriminator: environment.vars.number("discriminator") ?? 3840,
        },
        productDescription: {
            name: "Fabric Interrogator",
            deviceType: DeviceTypeId(0x0016), // Root Node device type
        },
        basicInformation: {
            vendorId: VendorId(0xfff1), // Test vendor ID
            vendorName: "matter.js",
            productId: 0x8000,
            productName: "Fabric Interrogator",
            nodeLabel: "Fabric Interrogator",
            serialNumber: "FI-001",
            uniqueId: "fabric-interrogator-001",
        },
        controller: {
            adminFabricLabel: "Fabric Interrogator",
        },
    });

    process.once("SIGINT", () => {
        console.log("\nShutting down...");
        server.cancel().then(() => exit(0));
    });

    await server.start();

    if (server.lifecycle.isCommissioned) {
        console.log("Already commissioned. Starting device discovery...\n");
    } else {
        const { qrPairingCode, manualPairingCode } = server.state.commissioning.pairingCodes;
        console.log("\n┌──────────────────────────────────────────┐");
        console.log("│  Commission this device into your fabric │");
        console.log("└──────────────────────────────────────────┘\n");
        console.log(QrCode.get(qrPairingCode));
        console.log(`\nManual pairing code: ${manualPairingCode}`);
        console.log(`QR code payload:     ${qrPairingCode}\n`);
        console.log("Waiting for commissioning...\n");

        await new Promise<void>(resolve => server.lifecycle.commissioned.once(() => resolve()));
        console.log("Commissioned! Starting device discovery...\n");
    }

    const reports = await interrogateFabric(server);
    displayReports(reports, environment.vars.boolean("show.sensitive"));

    console.log("\nInterrogation complete.");
    exit(0);
}

main().catch(error => {
    console.error("Fatal error:", error);
    logger.error(error);
    exit(1);
});
