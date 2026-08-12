/**
 * ★ Mindorr configuration: version and operation identifiers.
 *
 * The op-type / op-command strings MUST match the bytes32 constants in the
 * instruction-sending contract exactly, or actions fall through to
 * "unsupported op type". See docs/ARCHITECTURE.md for the op table.
 */

export const VERSION = "0.1.0";

// Managed wallet lifecycle. UPDATE_KEY delivers the master seed (once); CREATE
// derives and reveals a specific user's managed wallet from that seed.
export const OP_TYPE_WALLET = "WALLET";
export const OP_COMMAND_UPDATE_KEY = "UPDATE_KEY";
export const OP_COMMAND_CREATE = "CREATE";

// Vault operations. SET_POLICY and WITHDRAW are owner-signed (enforced on-chain);
// ALLOCATE and REBALANCE are autonomous within policy.
export const OP_TYPE_VAULT = "VAULT";
export const OP_COMMAND_SET_POLICY = "SET_POLICY";
export const OP_COMMAND_CONFIRM_DEPOSIT = "CONFIRM_DEPOSIT";
export const OP_COMMAND_ALLOCATE = "ALLOCATE";
export const OP_COMMAND_REBALANCE = "REBALANCE";
export const OP_COMMAND_WITHDRAW = "WITHDRAW";
