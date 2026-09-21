import { beforeEach, describe, expect, it, vi } from "vitest";

const { safeFetchMock, assertUrlIsPublicMock, fetchCredentialsMock } =
  vi.hoisted(() => ({
    safeFetchMock: vi.fn(),
    assertUrlIsPublicMock: vi.fn(),
    fetchCredentialsMock: vi.fn(),
  }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/safe-fetch", () => ({
  safeFetch: safeFetchMock,
  assertUrlIsPublic: assertUrlIsPublicMock,
  SsrfBlockedError: class SsrfBlockedError extends Error {
    name = "SsrfBlockedError";
  },
}));
vi.mock("@/lib/credential-fetcher", () => ({
  fetchCredentials: fetchCredentialsMock,
}));
vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);
vi.mock("@/lib/metrics/instrumentation/plugin", async () =>
  (await import("../mocks/step-mocks")).pluginMetricsPassthrough()
);

const RELAY_URL = "https://relay.example.com/hcs/submit";
const TOPIC = "0.0.10590142";

function relayOk(body: {
  transactionId?: string;
  sequenceNumber?: number | string;
  consensusTimestamp?: string;
}) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  };
}

function relayStatus(status: number, body: string) {
  return { ok: false, status, text: async () => body };
}

async function submit(input: Record<string, unknown>) {
  const { submitMessageStep } = await import(
    "@/plugins/hedera/steps/submit-message"
  );
  return submitMessageStep({
    topicId: TOPIC,
    message: "receipt",
    integrationId: "int_1",
    ...input,
  } as never);
}

describe("hedera plugin — submit-message (operator relay)", () => {
  beforeEach(() => {
    safeFetchMock.mockReset();
    assertUrlIsPublicMock.mockReset();
    assertUrlIsPublicMock.mockResolvedValue(undefined);
    fetchCredentialsMock.mockReset();
    fetchCredentialsMock.mockResolvedValue({
      HEDERA_RELAY_URL: RELAY_URL,
      HEDERA_RELAY_TOKEN: "secret-token",
    });
  });

  it("posts the payload to the relay and returns its receipt", async () => {
    safeFetchMock.mockResolvedValue(
      relayOk({
        transactionId: "0.0.10590142@1789702752.456725104",
        sequenceNumber: 19,
        consensusTimestamp: "1789702752.456725104",
      })
    );

    const result = await submit({});

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.topicId).toBe(TOPIC);
      expect(result.network).toBe("testnet");
      expect(result.messageBytes).toBe(Buffer.byteLength("receipt", "utf8"));
      expect(result.transactionId).toBe("0.0.10590142@1789702752.456725104");
      expect(result.sequenceNumber).toBe("19");
      expect(result.consensusTimestamp).toBe("1789702752.456725104");
    }

    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = safeFetchMock.mock.calls[0];
    expect(String(url)).toBe(RELAY_URL);
    expect(init.method).toBe("POST");
    expect(init.plugin).toBe("hedera");
    expect(init.headers.Authorization).toBe("Bearer secret-token");
    expect(init.signal).toBeDefined();
    expect(JSON.parse(init.body)).toEqual({
      network: "testnet",
      topicId: TOPIC,
      message: "receipt",
    });
  });

  it("guards the user-supplied relay URL with assertUrlIsPublic", async () => {
    safeFetchMock.mockResolvedValue(relayOk({ sequenceNumber: 19 }));

    await submit({});

    expect(assertUrlIsPublicMock).toHaveBeenCalledWith(RELAY_URL);
  });

  it("fails with a USER error when no relay is configured", async () => {
    fetchCredentialsMock.mockResolvedValue({});

    const result = await submit({});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/no relay configured/i);
      expect(result.errorClass).toBeDefined();
    }
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it("never reads a relay from the step config instead of the connection", async () => {
    fetchCredentialsMock.mockResolvedValue({});

    // A URL smuggled through the action config must not be used as the relay.
    const result = await submit({ relayUrl: "https://evil.example.com" });

    expect(result.success).toBe(false);
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-https relay URL", async () => {
    fetchCredentialsMock.mockResolvedValue({
      HEDERA_RELAY_URL: "http://10.0.0.5/x",
    });

    const result = await submit({});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/https/i);
    }
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it("validates the relay URL before fetching, not after", async () => {
    fetchCredentialsMock.mockResolvedValue({ HEDERA_RELAY_URL: "not a url" });

    const result = await submit({});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/not a valid URL/i);
    }
    expect(assertUrlIsPublicMock).not.toHaveBeenCalled();
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it("reports a relay authorization failure as a USER error with its message", async () => {
    safeFetchMock.mockResolvedValue(
      relayStatus(401, JSON.stringify({ error: "bad token" }))
    );

    const result = await submit({});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/401/);
      expect(result.error).toMatch(/bad token/);
      expect(result.errorClass).toBe("user");
    }
  });

  it("reports a relay outage as an EXTERNAL error", async () => {
    safeFetchMock.mockResolvedValue(relayStatus(503, "unavailable"));

    const result = await submit({});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/503/);
      expect(result.errorClass).toBe("external");
    }
  });

  it("reports a relay failure to answer with JSON as EXTERNAL", async () => {
    safeFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "<html>",
    });

    const result = await submit({});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/non-JSON/i);
    }
  });

  it("tolerates a relay that reports no receipt fields", async () => {
    safeFetchMock.mockResolvedValue(relayOk({}));

    const result = await submit({});

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.transactionId).toBeNull();
      expect(result.sequenceNumber).toBeNull();
      expect(result.consensusTimestamp).toBeNull();
    }
  });

  it("refuses a payload Hedera would chunk, without calling the relay", async () => {
    const result = await submit({ message: "x".repeat(4097) });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/4096/);
      expect(result.errorClass).toBeDefined();
    }
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it("measures the payload in UTF-8 bytes, not characters", async () => {
    // 2049 three-byte characters is 6147 bytes: over the single-submission cap
    // even though the string is only 2049 characters long.
    const result = await submit({ message: "★".repeat(2049) });

    expect(result.success).toBe(false);
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid topic id and an unknown network before the relay", async () => {
    const badTopic = await submit({ topicId: "nope" });
    expect(badTopic.success).toBe(false);

    const badNetwork = await submit({ network: "testnest" });
    expect(badNetwork.success).toBe(false);

    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it("requires a non-empty message", async () => {
    const result = await submit({ message: "" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/message is required/i);
    }
    expect(safeFetchMock).not.toHaveBeenCalled();
  });
});
