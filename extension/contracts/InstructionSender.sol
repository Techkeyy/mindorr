// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

// TODO: Replace local interfaces with imports from flare-smart-contracts-v2 once published as a package.
import { ITeeExtensionRegistry } from "./interfaces/ITeeExtensionRegistry.sol";
import { ITeeMachineRegistry } from "./interfaces/ITeeMachineRegistry.sol";

/// @title HelloWorldInstructionSender (Mindorr instruction sender)
/// @author Flare Foundation / Mindorr
/// @notice On-chain entry point that forwards Mindorr's confidential-vault ops to
///         the TEE: WALLET/UPDATE_KEY and VAULT/{SET_POLICY,CONFIRM_DEPOSIT,ALLOCATE,
///         REBALANCE,WITHDRAW}. Each method sets the (opType, opCommand) the enclave
///         handlers route on (see typescript/src/app/config.ts) and forwards the raw
///         message bytes; the framework hex-encodes them for the handler.
///
///         The contract keeps its scaffold name so the existing binding-generation
///         (generate-bindings.sh: CONTRACT_NAME=HelloWorldInstructionSender, pkg
///         `helloworld`) and deploy/register tooling work unchanged.
///
/// DO NOT MODIFY: constructor, setExtensionId(), _getExtensionId()
contract HelloWorldInstructionSender {
    // --- Mindorr op identifiers. bytes32(string) must match config.ts exactly, or
    //     actions fall through to "unsupported op type" in the enclave.
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_TYPE_WALLET = bytes32("WALLET");
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_UPDATE_KEY = bytes32("UPDATE_KEY");

    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_TYPE_VAULT = bytes32("VAULT");
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_SET_POLICY = bytes32("SET_POLICY");
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_CONFIRM_DEPOSIT = bytes32("CONFIRM_DEPOSIT");
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_ALLOCATE = bytes32("ALLOCATE");
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_REBALANCE = bytes32("REBALANCE");
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_WITHDRAW = bytes32("WITHDRAW");

    /// @notice Reference to the TEE extension registry contract.
    ITeeExtensionRegistry public immutable TEE_EXTENSION_REGISTRY;
    /// @notice Reference to the TEE machine registry contract.
    ITeeMachineRegistry public immutable TEE_MACHINE_REGISTRY;

    /// @notice First public extension ID. The registry reserves IDs below this
    /// for system/reserved extensions; public extensions are assigned from here up.
    uint256 private constant FIRST_PUBLIC_EXTENSION_ID = 0x10000; // 65536

    uint256 private _extensionId;

    /// @notice Initializes the contract with registry addresses.
    /// @param _teeExtensionRegistry Address of the TEE extension registry.
    /// @param _teeMachineRegistry Address of the TEE machine registry.
    constructor(
        ITeeExtensionRegistry _teeExtensionRegistry,
        ITeeMachineRegistry _teeMachineRegistry
    ) {
        require(address(_teeExtensionRegistry) != address(0), "TeeExtensionRegistry cannot be zero address");
        require(address(_teeMachineRegistry) != address(0), "TeeMachineRegistry cannot be zero address");
        require(address(_teeExtensionRegistry).code.length > 0, "TeeExtensionRegistry has no code");
        require(address(_teeMachineRegistry).code.length > 0, "TeeMachineRegistry has no code");
        TEE_EXTENSION_REGISTRY = _teeExtensionRegistry;
        TEE_MACHINE_REGISTRY = _teeMachineRegistry;
    }

    /// @notice Finds and sets this contract's extension id. Can only be set once.
    /// DO NOT MODIFY this function.
    function setExtensionId() external {
        require(_extensionId == 0, "Extension ID already set.");

        uint256 c = TEE_EXTENSION_REGISTRY.nextPublicExtensionId();
        for (uint256 i = FIRST_PUBLIC_EXTENSION_ID; i < c; ++i) {
            if (TEE_EXTENSION_REGISTRY.getTeeExtensionInstructionsSender(i) == address(this)) {
                _extensionId = i;
                return;
            }
        }
        revert("Extension ID not found.");
    }

    /// @notice WALLET/UPDATE_KEY — deliver the signing key, encrypted to the TEE.
    /// @param _encryptedKey secp256k1 key ciphertext (encrypted to the TEE pubkey).
    function sendUpdateKey(bytes calldata _encryptedKey) external payable {
        _send(OP_TYPE_WALLET, OP_COMMAND_UPDATE_KEY, _encryptedKey);
    }

    /// @notice VAULT/SET_POLICY — set the owner's policy (allowlist, caps, return address).
    /// @param _policy JSON-encoded policy payload.
    function sendSetPolicy(bytes calldata _policy) external payable {
        _send(OP_TYPE_VAULT, OP_COMMAND_SET_POLICY, _policy);
    }

    /// @notice VAULT/CONFIRM_DEPOSIT — verify an XRP deposit via an FDC proof.
    /// @param _deposit JSON-encoded {proof, expected} payload.
    function sendConfirmDeposit(bytes calldata _deposit) external payable {
        _send(OP_TYPE_VAULT, OP_COMMAND_CONFIRM_DEPOSIT, _deposit);
    }

    /// @notice VAULT/ALLOCATE — allocate to an allowlisted venue (autonomous within policy).
    /// @param _intent JSON-encoded allocate intent.
    function sendAllocate(bytes calldata _intent) external payable {
        _send(OP_TYPE_VAULT, OP_COMMAND_ALLOCATE, _intent);
    }

    /// @notice VAULT/REBALANCE — reaffirm the split is within policy (autonomous).
    /// @param _intent JSON-encoded rebalance intent.
    function sendRebalance(bytes calldata _intent) external payable {
        _send(OP_TYPE_VAULT, OP_COMMAND_REBALANCE, _intent);
    }

    /// @notice VAULT/WITHDRAW — withdraw to the owner's return address only.
    /// @param _intent JSON-encoded withdraw intent.
    function sendWithdraw(bytes calldata _intent) external payable {
        _send(OP_TYPE_VAULT, OP_COMMAND_WITHDRAW, _intent);
    }

    /// @notice Route one instruction to a random TEE machine for this extension.
    function _send(bytes32 _opType, bytes32 _opCommand, bytes calldata _message) internal {
        address[] memory teeIds = TEE_MACHINE_REGISTRY.getRandomTeeIds(_getExtensionId(), 1);
        address[] memory cosigners = new address[](0);

        ITeeExtensionRegistry.TeeInstructionParams memory params = ITeeExtensionRegistry.TeeInstructionParams({
            opType: _opType,
            opCommand: _opCommand,
            message: _message,
            cosigners: cosigners,
            cosignersThreshold: 0,
            claimBackAddress: msg.sender
        });

        TEE_EXTENSION_REGISTRY.sendInstructions{value: msg.value}(
            teeIds,
            params
        );
    }

    /// @notice Returns the cached extension ID, reverting if not yet set.
    /// @return The extension ID assigned to this contract.
    function _getExtensionId() internal view returns (uint256) {
        require(_extensionId != 0, "Extension ID is not set.");
        return _extensionId;
    }
}
