---
title: "Hedera Plugin"
description: "Anchor workflow output to Hedera Consensus Service through an operator relay, and verify it from the public mirror node."
---

# Hedera Plugin

Anchor-and-verify: a workflow can anchor a payload to a Hedera Consensus Service (HCS) topic and read it back from the **public mirror node** — an unauthenticated endpoint that trusts only the Hedera network, not the system that anchored the message and not KeeperHub's database.

## Actions

| Action | Description | Egress |
|--------|-------------|--------|
| Verify HCS Message | Read a topic message from the public mirror node and check it against an expected payload | Two constant public mirror hosts — free |
| Submit HCS Message | Anchor a payload through your operator relay and return its receipt | Your relay URL — plan-gated |

Neither action holds signing material. Submit goes to a relay you configure; the plugin never imports the Hedera SDK and never opens a connection the SSRF guard cannot see.

## Verify HCS Message

Read-only and credential-free: the action queries the public mirror node over HTTPS.

| Input | Required | Description |
|-------|----------|-------------|
| Topic ID | Yes | The HCS topic to read, e.g. `0.0.10590142` |
| Sequence number | Yes | The topic sequence number to verify |
| Expected message | No | When set, `verified` is true only if the anchored payload matches (whitespace on either side is ignored) |
| Network | Yes | `testnet` (default) or `mainnet` — selects which public mirror node is queried |

### Outputs

| Output | Description |
|--------|-------------|
| `found` | True when the mirror holds a message at that sequence (an anchored empty message counts as found) |
| `verified` | True when `found` and the payload matches the expected message (surrounding whitespace on either side is ignored) |
| `message` | The decoded payload |
| `consensusTimestamp` | The network-assigned consensus timestamp |
| `sequenceNumber` | The verified sequence number |

A `404` from the mirror surfaces as `found: false` with `success: true` when the topic exists, so workflows can branch on "not yet anchored" without treating it as a failure. A `404` for a topic that does not exist is a configuration error and fails the step, so a polling workflow cannot loop forever on a mistyped topic id. Only a `404` means "no such topic" — a `429` or a `5xx` from the mirror is reported as a mirror failure, never as a bad topic id.

Disambiguating those two `404`s costs a second request (a probe of the topic itself), and each request carries a 30-second timeout, so a single run of this step can take up to roughly 60 seconds when nothing is anchored at the requested sequence yet.

Messages larger than the HCS single-transaction payload are split into one chunk per sequence number by the network; a chunked message fails this step with a clear error rather than reporting a content mismatch, because the fragment alone is not the anchored payload.

## Submit HCS Message

Anchoring needs a Hedera operator account: it pays for the submission and signs it. That key is money-moving signing material, so it never enters this plugin or a KeeperHub pod. Instead you attach a Hedera connection with the URL of an **operator relay** — a small service you host that owns the operator key and signs submissions on your behalf.

The action is plan-gated (`user-destination`), because the destination host is yours to choose.

| Input | Required | Description |
|-------|----------|-------------|
| Topic ID | Yes | The HCS topic to submit to, e.g. `0.0.10590142` |
| Message | Yes | The payload to anchor, e.g. a digest or receipt. At most 4096 bytes |
| Network | Yes | `testnet` (default) or `mainnet` |

| Output | Description |
|--------|-------------|
| `topicId`, `network`, `messageBytes` | What was submitted |
| `transactionId`, `sequenceNumber`, `consensusTimestamp` | As **reported by the relay** — confirm them with Verify HCS Message before gating on them |
| `error` | Error message if failed |

A payload over 4096 bytes is refused rather than anchored: Hedera splits it into one chunk per sequence number, and Verify HCS Message cannot check a fragment. Anchor a digest instead and keep the full record where the workflow already keeps it.

### The relay contract

`POST <relayUrl>` with

```json
{ "network": "testnet", "topicId": "0.0.10590142", "message": "<utf-8 payload>" }
```

answering `2xx` with any of

```json
{ "transactionId": "0.0.x@1234.5678", "sequenceNumber": 19, "consensusTimestamp": "1789702752.456725104" }
```

or a non-`2xx` status with `{ "error": "..." }` (or `{ "message": "..." }`) explaining the refusal. A `401`/`403` or other `4xx` is reported as a configuration or authorization problem; a `429` or `5xx` is reported as the relay failing.

If the connection also sets a relay token, it is sent as `Authorization: Bearer <token>`. That token authorizes the use of the relay; it is not a signing key.

## Why verify against a mirror?

Hedera consensus orders messages network-wide and assigns monotonically increasing sequence numbers. Once a message is anchored, nobody can rewrite it — so a workflow that holds payment until `verified: true` is gating on proof any third party can reproduce from the same public endpoint. The step only reports `verified` when the mirror's response identifies the exact topic and sequence that were requested, and queries go only to Hedera's public mirror nodes.

## What the submit receipt does and does not prove

The receipt comes from the relay, which is a system the workflow author chose. It is useful — it gives you the sequence number to verify and the transaction to look up — but it is not evidence. Anchor, then verify: sequence Verify HCS Message on the relay's reported `sequenceNumber` and gate on `verified`, which comes from Hedera's own mirror. A relay that lies either produces a real transaction or none; it cannot produce `verified: true`.
