# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Matter fabric interrogator built on matter.js (v0.16.10). The app gets commissioned onto an existing Matter fabric, then discovers all devices on the network and reads their attributes, presenting them in human-readable form.

**User flow:** Run the app → it displays a QR code and manual pairing code → user commissions it into their fabric → app scans for all devices on the network → reads and displays device attributes as a list, or renders errors.

## Source files

- `src/FabricInterrogator.ts` — entry point: creates ServerNode, handles commissioning, runs interrogation
- `src/interrogate.ts` — fabric discovery, peer reading with wildcard + concrete fallback, NodeReport/NodeOutcome types
- `src/format.ts` — pure helpers: cluster/attribute/status names and value formatting via the Matter model
- `src/display.ts` — prints the tree-formatted report and summary to the console
- `src/mdns-browse.ts` — mDNS browsing to discover fabric nodes

## Commands

- **Build:** `npm run build` (runs `tsc`)
- **Run:** `npm run app` (runs `node --enable-source-maps dist/FabricInterrogator.js`)
- **Clean:** `npm run clean`
- **No tests configured**

## Architecture

- **Key dependencies:** `@matter/main` (core), `@matter/protocol` (read API), `@matter/model` (name resolution), `@matter/types` (data types), `@project-chip/matter.js` (controller APIs), `@matter/nodejs-ble` (optional BLE)
- **Node version:** 24.x (see `.nvmrc`)
- **TypeScript:** strict mode, target ES2024, module resolution node16, ESM
