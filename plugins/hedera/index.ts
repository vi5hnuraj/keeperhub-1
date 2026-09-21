import type { IntegrationPlugin } from "@/plugins/registry";
import { registerIntegration } from "@/plugins/registry-core";
import { HederaIcon } from "./icon";

/**
 * Hedera plugin — anchor workflow output to Hedera's public consensus and
 * verify it back from the network's own mirror node.
 *
 * Two actions with deliberately different egress postures:
 *
 *   verify-message  reads the public mirror over safeFetch against a
 *                   compile-time constant host, so it is "fixed-host" and
 *                   stays free.
 *   submit-message  posts to an operator relay whose URL the user configures,
 *                   so it is "user-destination" and plan-gated like every other
 *                   action that can reach a host of the operator's choosing.
 *
 * Neither action holds signing material. The relay owns the Hedera operator
 * key; this plugin never sees it, never imports @hashgraph/sdk, and never opens
 * a socket the SSRF guard cannot see.
 */
const hederaPlugin: IntegrationPlugin = {
  type: "hedera",
  // The relay URL is a user-supplied destination (see the `relayUrl` form
  // field), so the plugin default is user-destination. verify-message overrides
  // it to fixed-host, because a relay connection must not plan-gate a
  // read-only query against two constant public mirror hosts.
  egress: "user-destination",
  label: "Hedera",
  description:
    "Anchor messages on Hedera Consensus Service through an operator relay and verify them from the public mirror node",

  icon: HederaIcon,

  // verify-message needs no connection at all. submit-message needs a relay
  // connection, but its presence is the user's choice, not a requirement of
  // the integration - mirrors blockscout.
  requiresCredentials: false,

  formFields: [
    {
      id: "relayUrl",
      label: "Operator Relay URL",
      type: "url",
      placeholder: "https://relay.example.com/hcs/submit",
      configKey: "relayUrl",
      envVar: "HEDERA_RELAY_URL",
      helpText:
        "HTTPS endpoint that holds a Hedera operator key and signs submissions. Only submit-message uses it, and it must be a service you control or trust.",
      helpLink: {
        text: "See the relay contract",
        url: "https://docs.keeperhub.com/plugins/hedera",
      },
    },
    {
      id: "relayToken",
      label: "Relay Token (optional)",
      type: "password",
      placeholder: "Optional - sent as Authorization: Bearer",
      configKey: "relayToken",
      envVar: "HEDERA_RELAY_TOKEN",
      helpText:
        "Optional bearer token for the relay. It authorizes submissions; it does not carry signing material.",
    },
  ],

  testConfig: {
    getTestFunction: async () => {
      const { testHedera } = await import("./test");
      return testHedera;
    },
  },

  actions: [
    {
      slug: "verify-message",
      label: "Verify HCS Message",
      description:
        "Read a message from an HCS topic via the public mirror node and check it against an expected payload",
      category: "Hedera",
      // Constant mirror host, no user input in the origin: this read stays free
      // even though the plugin default is user-destination for the relay action.
      egress: "fixed-host",
      stepFunction: "verifyMessageStep",
      stepImportPath: "verify-message",
      outputFields: [
        { field: "success", description: "Whether the verification query completed" },
        { field: "found", description: "Whether the mirror holds a message at this sequence (empty payloads count as found)" },
        { field: "verified", description: "Whether the payload matches the expected message (surrounding whitespace ignored; only asserted when one is provided)" },
        { field: "message", description: "The decoded anchored payload" },
        { field: "consensusTimestamp", description: "Network-assigned consensus timestamp" },
        { field: "sequenceNumber", description: "The verified sequence number" },
        { field: "error", description: "Error message if failed" },
      ],
      configFields: [
        {
          key: "topicId",
          label: "Topic ID",
          type: "template-input",
          placeholder: "0.0.10590142",
          example: "0.0.10590142",
          required: true,
          helpTip: "The HCS topic to read, e.g. 0.0.10590142.",
        },
        {
          key: "sequenceNumber",
          label: "Sequence Number",
          type: "template-input",
          placeholder: "18",
          example: "18",
          required: true,
          helpTip: "The topic sequence number to verify.",
        },
        {
          key: "expectedMessage",
          label: "Expected Message",
          type: "template-input",
          required: false,
          helpTip:
            "When set, verification succeeds only if the anchored payload matches (surrounding whitespace is ignored on both sides). Leave empty to just read the payload.",
        },
        {
          key: "network",
          label: "Network",
          type: "select",
          required: true,
          options: [
            { value: "testnet", label: "Testnet" },
            { value: "mainnet", label: "Mainnet" },
          ],
          defaultValue: "testnet",
          example: "testnet",
          helpTip: "Which Hedera network's public mirror node to query.",
        },
      ],
    },
    {
      slug: "submit-message",
      label: "Submit HCS Message",
      description:
        "Anchor a workflow payload to an HCS topic through your operator relay, then verify it with Verify HCS Message",
      category: "Hedera",
      stepFunction: "submitMessageStep",
      stepImportPath: "submit-message",
      outputFields: [
        { field: "success", description: "Whether the relay accepted the submission" },
        { field: "topicId", description: "The topic the message was submitted to" },
        { field: "network", description: "The Hedera network the relay submitted to" },
        { field: "messageBytes", description: "UTF-8 byte length of the submitted payload" },
        { field: "transactionId", description: "Transaction id as reported by the relay - confirm it with Verify HCS Message" },
        { field: "sequenceNumber", description: "Sequence number as reported by the relay - confirm it with Verify HCS Message" },
        { field: "consensusTimestamp", description: "Consensus timestamp as reported by the relay - confirm it with Verify HCS Message" },
        { field: "error", description: "Error message if failed" },
      ],
      configFields: [
        {
          key: "topicId",
          label: "Topic ID",
          type: "template-input",
          placeholder: "0.0.10590142",
          example: "0.0.10590142",
          required: true,
          helpTip: "The HCS topic to submit to, e.g. 0.0.10590142.",
        },
        {
          key: "message",
          label: "Message",
          type: "template-textarea",
          placeholder: '{{AnchorPayload.digest}} or a JSON record',
          required: true,
          helpTip:
            "The payload to anchor, e.g. a digest or receipt. At most 4096 bytes: Hedera splits anything larger into one chunk per sequence number, which Verify HCS Message cannot check.",
        },
        {
          key: "network",
          label: "Network",
          type: "select",
          required: true,
          options: [
            { value: "testnet", label: "Testnet" },
            { value: "mainnet", label: "Mainnet" },
          ],
          defaultValue: "testnet",
          example: "testnet",
          helpTip: "Which Hedera network the relay should submit to.",
        },
      ],
    },
  ],
};

registerIntegration(hederaPlugin);

export default hederaPlugin;
