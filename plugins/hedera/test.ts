/**
 * Connection test for the Hedera plugin.
 *
 * verify-message needs no connection at all, so without a relay configured this
 * confirms the public mirror is reachable - early feedback that the user's
 * network can reach Hedera. With a relay configured it checks that host
 * instead, because that is the only part of the integration a user has to get
 * right.
 *
 * Runs in the client-bundled connection dialog, so it uses the raw fetch global
 * (safe-fetch.ts is "server-only"). The relay URL is a `url` form field, which
 * handlePluginTest validates with assertUrlIsPublic on the server first.
 */
const MIRROR_URL = "https://testnet.mirrornode.hedera.com";
const TIMEOUT_MS = 10_000;

export async function testHedera(
  credentials: Record<string, string>
): Promise<{ success: boolean; error?: string }> {
  const relayUrl = credentials.HEDERA_RELAY_URL?.trim();
  if (relayUrl) {
    return testRelay(relayUrl, credentials.HEDERA_RELAY_TOKEN?.trim());
  }

  try {
    const res = await fetch(`${MIRROR_URL}/api/v1/network/nodes?limit=1`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      return {
        success: false,
        error: `Hedera testnet mirror returned HTTP ${res.status}.`,
      };
    }
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Could not reach the Hedera mirror: ${message}` };
  }
}

/**
 * Confirm the relay host answers HTTP. Any status counts: this proves DNS, TLS
 * and reachability without submitting anything, and it deliberately does not
 * assert a status code, so a relay that only accepts POST is still reported as
 * reachable. Sending a real message from a connection test would anchor
 * something the user never asked for.
 */
async function testRelay(
  relayUrl: string,
  token: string | undefined
): Promise<{ success: boolean; error?: string }> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const res = await fetch(relayUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      return {
        success: false,
        error: `Relay host is reachable but rejected the credentials (HTTP ${res.status}). Check the relay token.`,
      };
    }
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Could not reach the relay: ${message}` };
  }
}
