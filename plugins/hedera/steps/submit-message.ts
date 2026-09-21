import "server-only";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import type { HederaCredentials } from "../credentials";
import {
  HCS_MAX_MESSAGE_BYTES,
  isValidTopicId,
  resolveNetwork,
  submitToRelay,
} from "./hedera-core";

type SubmitMessageResult =
  | {
      success: true;
      topicId: string;
      network: string;
      messageBytes: number;
      transactionId: string | null;
      sequenceNumber: string | null;
      consensusTimestamp: string | null;
    }
  | { success: false; error: string; errorClass?: ExecutionErrorType };

export type SubmitMessageCoreInput = {
  topicId: string;
  message: string;
  network?: string;
};

export type SubmitMessageInput = StepInput &
  SubmitMessageCoreInput & {
    integrationId?: string;
  };

async function stepHandler(
  input: SubmitMessageCoreInput,
  credentials: HederaCredentials
): Promise<SubmitMessageResult> {
  const topicId = (input.topicId || "").trim();
  if (!isValidTopicId(topicId)) {
    return {
      success: false,
      error: `Invalid Hedera topic id "${topicId}". Expected format: 0.0.<number>.`,
      errorClass: ExecutionErrorType.USER,
    };
  }

  const message = input.message ?? "";
  if (message.length === 0) {
    return {
      success: false,
      error: "Message is required.",
      errorClass: ExecutionErrorType.USER,
    };
  }

  // HCS splits an oversized submission into one chunk per sequence number, and
  // verify-message refuses chunked messages (a fragment is not the anchored
  // payload). Refuse to create the state the other half of this plugin cannot
  // verify, rather than anchoring something unverifiable.
  const messageBytes = Buffer.byteLength(message, "utf8");
  if (messageBytes > HCS_MAX_MESSAGE_BYTES) {
    return {
      success: false,
      error: `Message is ${messageBytes} bytes; Hedera anchors at most ${HCS_MAX_MESSAGE_BYTES} bytes per submission and the network splits anything larger into one chunk per sequence number. Anchor a digest of the payload instead - the full record can live wherever the workflow already keeps it.`,
      errorClass: ExecutionErrorType.USER,
    };
  }

  const network = resolveNetwork(input.network);
  if (!network) {
    return {
      success: false,
      error: `Unknown network "${input.network}". Use "testnet" or "mainnet".`,
      errorClass: ExecutionErrorType.USER,
    };
  }

  const result = await submitToRelay(credentials, {
    topicId,
    message,
    network,
  });
  if (!result.success) {
    return result;
  }

  return {
    success: true,
    topicId,
    network,
    messageBytes,
    transactionId: result.transactionId,
    sequenceNumber: result.sequenceNumber,
    consensusTimestamp: result.consensusTimestamp,
  };
}

export async function submitMessageStep(
  input: SubmitMessageInput
): Promise<SubmitMessageResult> {
  "use step";

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId, {
        organizationId: input._context?.organizationId ?? null,
      })
    : {};

  return runPluginStep(
    { pluginName: "hedera", actionName: "submit-message" },
    input,
    () => stepHandler(input, credentials)
  );
}

export const _integrationType = "hedera";
