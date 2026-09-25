# Fabric Interrogator

A Matter fabric interrogator built on [matter.js](https://github.com/matter-js) (v0.16.10). Gets commissioned onto an existing Matter fabric, discovers all devices on the network, and tries to read their attributes, showing what it gets (or why it gets nothing) in human-readable form.

It's an experiment to answer one question: **what can a device actually see and access once it's commissioned onto a Matter fabric?**

**Short answer: almost nothing.** Commissioning makes you an authenticated fabric member, but ACL entries are only written on *your* node, giving the fabric's admins control over you. Nothing grants you access on the other devices: they silently return empty responses to wildcard reads and `UnsupportedAccess` to concrete reads. See [FINDINGS.md](FINDINGS.md) for the reasoning, evidence and spec references.

## How it works

1. **Start the app** — displays a QR code and manual pairing code
2. **Commission it** into your fabric using any Matter controller (Apple Home, Google Home, etc.)
3. **Automatic discovery** — scans for all other devices on the fabric via mDNS
4. **Attribute reading** — performs wildcard reads on each discovered peer, falling back to a concrete read (`ep0/BasicInformation/vendorName`) to surface explicit ACL errors
5. **Display** — gives each device a verdict (readable, partial access, access denied, unreachable), prints whatever was readable as a tree of Node → Endpoint → Cluster → Attributes with resolved names, and ends with a summary

## Prerequisites

- Node.js (see `.nvmrc` for version)
- An existing Matter fabric to commission into

## Setup

```sh
npm install
```

## Usage

```sh
npm run app
```

On first run, the app displays a QR code. Scan it with your Matter controller to commission the device onto your fabric. Once commissioned, it automatically discovers peers and tries to read their attributes.

On subsequent runs, the app skips commissioning and goes straight to discovery.

matter.js protocol logs are written to `logs/matter.log`. They contain your LAN/Thread addresses and fabric IDs, so don't share them unredacted.

When commissioned via Apple Home, the extra "Apple Keychain" fabric (root vendor `0x1384`) is skipped.

### Options

These are passed as environment-style flags via the matter.js `Environment`:

- `--storage-path=NAME-OR-PATH` — use a different storage location
- `--storage-clear` — clear stored commissioning data and start fresh
- `--passcode=N` — setup passcode (default `20202021`)
- `--discriminator=N` — discriminator (default `3840`)
- `--show-sensitive` — include AccessControl, GeneralDiagnostics and OperationalCredentials in the report (hidden by default: they contain ACLs, certificates, fabric labels and network addresses)

> **Note:** the defaults are the well-known Matter test values. While the app is waiting to be commissioned, anyone on your local network can pair with it. Set your own passcode if that matters.

Commissioning data (including this node's operational credentials for your fabric) is stored outside the repo, under matter.js's default storage location (`~/.matter/fabric-interrogator`).

### Example output

Excerpt from a real run on a home fabric with an Apple Home hub and 8 other devices. IDs are replaced with `<placeholders>`, and `...` marks omitted lines. Most devices deny access; see [FINDINGS.md](FINDINGS.md) for why.

```
Discovering nodes on fabric <fabric-id> (index 1)...
  Browsing mDNS for 5s...
  Found 8 peer(s) + our node <our-node>. Reading all nodes...

  Reading node <our-node> (ours)...
    ✓ 101 attributes read locally (no ACL applies to our own state)
  Reading node <device>...
    wildcard read:  0 attributes (devices silently omit ACL-denied paths from wildcard reads)
    concrete read:  ep0/BasicInformation/VendorName → UnsupportedAccess (0x7E)
    ✗ access denied: no ACL entry on this device grants our node read access
  ...
  Reading node <hub>...
    wildcard read:  5 attributes from 1 cluster(s) (OtaSoftwareUpdateProvider)
    ✓ partial access: this device has an ACL entry for us, but it's narrow

...

┌── Node: <device>
│  ✗ access denied: no ACL entry on this device grants our node read access
│
├── Errors:
│   EP0/BasicInformation/VendorName: UnsupportedAccess (0x7E)
└──────────────────────────────────────────────────

...

Summary: 8 peer(s) — 1 partial access, 6 access denied, 1 unreachable

Hidden: AccessControl, GeneralDiagnostics, OperationalCredentials (use --show-sensitive to include)
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript |
| `npm run app` | Run the interrogator (build first; `npm install` builds automatically) |
| `npm run clean` | Delete the `dist/` directory |

## Architecture

- **Entry point:** `src/FabricInterrogator.ts`
- **ServerNode** with `ControllerBehavior` — acts as both a commissionable device and a controller that can read peers
- **Wildcard reads, plus one concrete read** to surface ACL denials, via `@matter/protocol`'s `Read` API
- **Name resolution** via `@matter/model`'s `MatterModel.standard` to map numeric cluster/attribute IDs to human-readable names

## Dependencies

- `@matter/main` — core matter.js framework
- `@matter/protocol` — interaction protocol (Read requests)
- `@matter/model` — Matter data model for name resolution
- `@matter/types` — QR code rendering, data types
- `@project-chip/matter.js` — controller APIs
- `@matter/nodejs-ble` (optional) — BLE commissioning support

## License

[MIT](LICENSE)
