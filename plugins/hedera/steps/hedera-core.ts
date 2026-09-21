import "server-only";

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import {
  assertUrlIsPublic,
  safeFetch,
  SsrfBlockedError,
} from "@/lib/safe-fetch";
import type { HederaCredentials } from "../credentials";

/**
 * Shared helpers for the hedera plugin.
 *
 * This module is intentionally dependency-free: everything here is pure
 * validation, URL building and safeFetch calls. Neither the read path
 * (verify-message) nor the submit path (submit-message) pulls @hashgraph/sdk
 * into the server bundle, and neither opens a socket that the SSRF guard
 * cannot see. Submission goes to an operator relay over HTTPS, never to a
 * consensus node over gRPC.
 */

export type HederaNetwork = "testnet" | "mainnet";

export const HEDERA_MIRROR_API: Record<HederaNetwork, string> = {
  testnet: "https://testnet.mirrornode.hedera.com",
  mainnet: "https://mainnet.mirrornode.hedera.com",
};

/**
 * Largest payload a single HCS submission can carry before the network splits
 * it into one chunk per sequence number. verify-message refuses chunked
 * messages, so submit-message refuses to create them.
 */
export const HCS_MAX_MESSAGE_BYTES = 4096;

const TOPIC_ID_RE = /^0\.0\.\d{1,19}$/;

export function isValidTopicId(value: string): boolean {
  return TOPIC_ID_RE.test(value.trim());
}

export function resolveNetwork(raw: string | undefined): HederaNetwork | null {
  const v = (raw || "testnet").toLowerCase();
  return v === "mainnet" || v === "testnet" ? (v as HederaNetwork) : null;
}

const RELAY_TIMEOUT_MS = 30_000;

export type RelaySubmitResult =
  | {
      success: true;
      transactionId: string | null;
      sequenceNumber: string | null;
      consensusTimestamp: string | null;
    }
  | { success: false; error: string; errorClass: ExecutionErrorType };

type RelayResponseBody = {
  transactionId?: unknown;
  sequenceNumber?: unknown;
  consensusTimestamp?: unknown;
  error?: unknown;
  message?: unknown;
};

function optionalString(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "number") {
    return String(value);
  }
  return null;
}

// Best-effort: a relay explaining why it refused is more useful than a bare
// status code, but its body is untrusted and may not be JSON at all.
function relayErrorMessage(bodyText: string): string | null {
  if (!bodyText) {
    return null;
  }
  try {
    const parsed = JSON.parse(bodyText) as RelayResponseBody;
    return (
      optionalString(parsed.error) ??
      optionalString(parsed.message) ??
      bodyText.slice(0, 200)
    );
  } catch {
    return bodyText.slice(0, 200);
  }
}

/**
 * Submit a message to an HCS topic through an operator relay.
 *
 * The relay is a user-configured HTTPS service that owns the Hedera operator
 * key and signs the submission. This function - and therefore this plugin -
 * never sees signing material, never imports the Hedera SDK, and reaches the
 * network only through safeFetch.
 *
 * Contract: POST <relayUrl> with
 *   { network: "testnet" | "mainnet", topicId: "0.0.x", message: "<utf-8>" }
 * answering 2xx with
 *   { transactionId?, sequenceNumber?, consensusTimestamp? }
 * or a non-2xx status with { error } / { message } explaining the refusal.
 *
 * The returned values are what the relay *reports*. They are deliberately not
 * presented as proof: a relay is a system the workflow author configures, so
 * anything it says about the result has to be confirmed from the mirror by a
 * separate verify-message step.
 */
export async function submitToRelay(
  credentials: HederaCredentials,
  input: { topicId: string; message: string; network: HederaNetwork }
): Promise<RelaySubmitResult> {
  const relayUrl = credentials.HEDERA_RELAY_URL?.trim();
  if (!relayUrl) {
    return {
      success: false,
      error:
        "No relay configured. Add a Hedera connection with the URL of the relay that holds the operator key - this plugin never holds signing material itself.",
      errorClass: ExecutionErrorType.USER,
    };
  }

  let url: URL;
  try {
    url = new URL(relayUrl);
  } catch {
    return {
      success: false,
      error: `Relay URL "${relayUrl}" is not a valid URL.`,
      errorClass: ExecutionErrorType.USER,
    };
  }
  if (url.protocol !== "https:") {
    return {
      success: false,
      error: "Relay URL must use https.",
      errorClass: ExecutionErrorType.USER,
    };
  }

  const token = credentials.HEDERA_RELAY_TOKEN?.trim();
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  // SSRF guard: the relay host comes from the connection, so it is
  // user-supplied. assertUrlIsPublic is always-on -- it ignores
  // SAFE_FETCH_SHADOW, where safeFetch alone would only log and continue.
  // Mirrors plugins/blockscout/steps/blockscout-core.ts.
  try {
    await assertUrlIsPublic(url.toString());
  } catch (error) {
    if (error instanceof SsrfBlockedError) {
      return {
        success: false,
        error: `Relay URL is not allowed: ${error.message}`,
        errorClass: ExecutionErrorType.USER,
      };
    }
    throw error;
  }

  let status: number;
  let bodyText: string;
  try {
    const res = await safeFetch(url.toString(), {
      plugin: "hedera",
      method: "POST",
      headers,
      body: JSON.stringify({
        network: input.network,
        topicId: input.topicId,
        message: input.message,
      }),
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
    status = res.status;
    bodyText = await res.text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Relay request failed: ${message.slice(0, 300)}`,
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }

  if (status >= 400) {
    // A 4xx from a relay the user runs is about the request it was given (bad
    // topic id, missing or wrong token, oversized payload); a 429 or 5xx is
    // the relay failing. Keep the two apart so the fault lands on the right
    // side of the workflow.
    const detail = relayErrorMessage(bodyText);
    const errorClass =
      status >= 500 || status === 429
        ? ExecutionErrorType.EXTERNAL
        : ExecutionErrorType.USER;
    return {
      success: false,
      error: `Relay returned HTTP ${status}${detail ? `: ${detail}` : ""}.`,
      errorClass,
    };
  }

  let payload: RelayResponseBody;
  try {
    payload = bodyText ? (JSON.parse(bodyText) as RelayResponseBody) : {};
  } catch {
    return {
      success: false,
      error: "Relay returned a non-JSON response.",
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }

  return {
    success: true,
    transactionId: optionalString(payload.transactionId),
    sequenceNumber: optionalString(payload.sequenceNumber),
    consensusTimestamp: optionalString(payload.consensusTimestamp),
  };
}
