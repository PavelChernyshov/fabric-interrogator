# Findings

Section numbers (§) refer to the [Matter Core Specification R1.5](https://csa-iot.org/wp-content/uploads/2025/11/23-27349-009_Matter-1.5-Core-Specification.pdf) (CSA document 23-27349, 2025-11-10); each link opens the cited page. Console output is from this app, with node IDs and CASE Authenticated Tags replaced by `<placeholders>`.

## Question

Once a node is commissioned onto an existing Matter fabric, what can it read from the other devices on that fabric?

## Answer

Almost nothing. Commissioning makes the node an authenticated member of the fabric: it gets an operational certificate and can open secure (CASE) sessions to every device. But it gets no read access. Each device decides access through its own Access Control List (ACL), and commissioning only writes ACL entries on the *new* node, giving the fabric's administrators control over it. Nothing is added on the other devices.

On a home fabric run by an Apple Home hub, with 8 other devices:

| Device | Result |
|---|---|
| Hub | Partial access: only the OTA Software Update Provider cluster |
| 6 devices | Access denied: nothing readable |
| 1 device | Unreachable during the runs |

## Denied devices return nothing, silently

Matter handles denied reads in two different ways ([§8.4.3.2](https://csa-iot.org/wp-content/uploads/2025/11/23-27349-009_Matter-1.5-Core-Specification.pdf#page=562)):

- **Wildcard reads** (any part of the path left open) are first expanded into every existing path, without checking access ([§8.2.1.6](https://csa-iot.org/wp-content/uploads/2025/11/23-27349-009_Matter-1.5-Core-Specification.pdf#page=553)). Each path the ACL denies is then **silently dropped**. A device you have no access to returns an empty report: no data, no error.
- **Concrete reads** (endpoint, cluster and attribute all specified) return an explicit `UNSUPPORTED_ACCESS` (0x7E) status when access is denied.

So the app does both: a wildcard read to get everything it's allowed to see, then one concrete read (`ep0/BasicInformation/VendorName`) to make a denial visible. Without the concrete read, a denied device and an unresponsive one look much the same: an empty report or a timeout. With it, all 6 denied devices gave the same answer:

```
  Reading node <device>...
    wildcard read:  0 attributes (devices silently omit ACL-denied paths from wildcard reads)
    concrete read:  ep0/BasicInformation/VendorName → UnsupportedAccess (0x7E)
    ✗ access denied: no ACL entry on this device grants our node read access

Summary: 8 peer(s) — 1 partial access, 6 access denied, 1 unreachable
```

A device can also restrict access itself with an Access Restriction List, but that answers a concrete read with `ACCESS_RESTRICTED`, not `UNSUPPORTED_ACCESS` ([§6.6.2.8](https://csa-iot.org/wp-content/uploads/2025/11/23-27349-009_Matter-1.5-Core-Specification.pdf#page=435), [§8.4.3.2](https://csa-iot.org/wp-content/uploads/2025/11/23-27349-009_Matter-1.5-Core-Specification.pdf#page=562)). `UNSUPPORTED_ACCESS` means denied by the ACL.

## The hub grants one cluster

The hub is the only device that returns anything: the 5 global attributes of its OTA Software Update Provider cluster, and nothing else, not even BasicInformation.

```
  Reading node <hub>...
    wildcard read:  5 attributes from 1 cluster(s) (OtaSoftwareUpdateProvider)
    ✓ partial access: this device has an ACL entry for us, but it's narrow

┌── Node: <hub>
│  ✓ partial access: this device has an ACL entry for us, but it's narrow
│
├── Endpoint 0
│   ├── OtaSoftwareUpdateProvider
│   │   FeatureMap: none
│   │   ClusterRevision: 1
│   │   GeneratedCommandList: [QueryImageResponse, ApplyUpdateResponse]
│   │   AcceptedCommandList: [QueryImage, ApplyUpdateRequest, NotifyUpdateApplied]
│   │   AttributeList: [GeneratedCommandList, AcceptedCommandList, AttributeList, FeatureMap, ClusterRevision]
└──────────────────────────────────────────────────
```

Since a wildcard read only returns paths the ACL grants, the hub has an ACL entry that matches our node for this one cluster.

## An empty wildcard read means no ACL entry at all

A denied concrete read only shows that one attribute is off limits. The empty wildcard reads prove more, with the hub as the positive control:

1. Every cluster has global attributes (ClusterRevision, FeatureMap, AttributeList, AcceptedCommandList, GeneratedCommandList) that require only View privilege ([§7.13](https://csa-iot.org/wp-content/uploads/2025/11/23-27349-009_Matter-1.5-Core-Specification.pdf#page=490)).
2. Every privilege includes View: Operate, Manage and Administer each grant it implicitly ([§6.6.6.2](https://csa-iot.org/wp-content/uploads/2025/11/23-27349-009_Matter-1.5-Core-Specification.pdf#page=448), [§9.10.5.2](https://csa-iot.org/wp-content/uploads/2025/11/23-27349-009_Matter-1.5-Core-Specification.pdf#page=628)).
3. So an ACL entry granting our node *any* privilege on *any* cluster of a device would make at least that cluster's global attributes appear in a wildcard read.
4. The hub shows exactly this: one entry, one cluster's attributes.
5. The denied devices return nothing, so none of their ACL entries matches our node ID or any CASE Authenticated Tag in our certificate.

## What commissioning does write

On our own node, the commissioner's AddNOC step creates an entry granting Administer to the fabric's administrator ([§11.18.6.8](https://csa-iot.org/wp-content/uploads/2025/11/23-27349-009_Matter-1.5-Core-Specification.pdf#page=959), [§6.6.3](https://csa-iot.org/wp-content/uploads/2025/11/23-27349-009_Matter-1.5-Core-Specification.pdf#page=436)). After commissioning by Apple Home, our node's ACL (from `npm run app -- --show-sensitive`) holds:

```
│   ├── AccessControl
│   │   Acl: [{privilege: 5, authMode: 2, subjects: [<hub>, <CAT-1>], targets: null, fabricIndex: 1},
│   │         {privilege: 3, authMode: 2, subjects: [<CAT-2>], targets: null, fabricIndex: 1},
│   │         {privilege: 5, authMode: 2, subjects: [<keychain-admin>], targets: null, fabricIndex: 2}]
```

- `privilege: 5` is Administer and `3` is Operate ([§9.10.5.2](https://csa-iot.org/wp-content/uploads/2025/11/23-27349-009_Matter-1.5-Core-Specification.pdf#page=628)); `authMode: 2` is CASE ([§9.10.5.4](https://csa-iot.org/wp-content/uploads/2025/11/23-27349-009_Matter-1.5-Core-Specification.pdf#page=629)); `targets: null` means the whole node.
- `<CAT-1>` and `<CAT-2>` are CASE Authenticated Tags: subjects in the `0xFFFF_FFFD_xxxx_xxxx` range that match every node whose certificate carries the tag ([§6.6.2.1.2](https://csa-iot.org/wp-content/uploads/2025/11/23-27349-009_Matter-1.5-Core-Specification.pdf#page=432)).
- Fabric 1 is the home fabric: the hub and every holder of `<CAT-1>` can administer us, and every holder of `<CAT-2>` can operate us. Fabric 2 is the Apple Keychain fabric that Apple Home adds.

The fabric can manage us, but we get nothing in return.

## Getting real access

- **The fabric admin adds ACL entries for our node on each device.** Only a subject with Administer privilege can write a device's ACL ([§6.6.2.9](https://csa-iot.org/wp-content/uploads/2025/11/23-27349-009_Matter-1.5-Core-Specification.pdf#page=435), [§9.10.6](https://csa-iot.org/wp-content/uploads/2025/11/23-27349-009_Matter-1.5-Core-Specification.pdf#page=637)), so this can't be done from our side.
- **Each device is commissioned into our own fabric (multi-admin).** The device's current admin opens a commissioning window ([§11.19](https://csa-iot.org/wp-content/uploads/2025/11/23-27349-009_Matter-1.5-Core-Specification.pdf#page=971)), and we commission the device as a new administrator. AddNOC then grants us Administer on that device ([§11.18.6.8](https://csa-iot.org/wp-content/uploads/2025/11/23-27349-009_Matter-1.5-Core-Specification.pdf#page=959)). This is how tools like chip-tool get full access. This app doesn't implement it.
