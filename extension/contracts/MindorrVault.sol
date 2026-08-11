// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/**
 * @title MindorrVault
 * @notice On-chain counterpart of the Mindorr enclave guard (policy.ts). Funds
 *         are released only when an action is (a) signed by the owner's
 *         registered in-enclave managed wallet, and (b) headed to an allowed
 *         destination. This re-enforces the enclave's destination allowlist
 *         on-chain as defense in depth: even if the off-chain guard were
 *         bypassed, this contract still refuses any transfer that isn't to an
 *         approved vault or the owner's own return address.
 *
 * @dev The digest is byte-identical to codec.ts `actionDigest`:
 *      keccak256(abi.encode(uint8 kind, address asset, uint256 amount, address dest)).
 *      The enclave signs that raw digest (viem account.sign over the hash), so
 *      ecrecover on the same digest recovers the managed wallet.
 *
 *      Replay is guarded by a used-digest set (MVP). A production deployment
 *      should bind an EIP-712 domain (verifyingContract + chainId) and a
 *      per-owner nonce into the digest; tracked as future work.
 */
contract MindorrVault {
    uint8 public constant KIND_ALLOCATE = 1;
    uint8 public constant KIND_REBALANCE = 2;
    uint8 public constant KIND_WITHDRAW = 3;

    struct Account {
        address managedWallet; // address of the in-enclave signing key
        address returnAddress; // withdrawals may only ever go here
        address asset; // FXRP
        bool exists;
    }

    /// owner => account
    mapping(address => Account) public accounts;
    /// owner => venue => allowed
    mapping(address => mapping(address => bool)) public allowedVenue;
    /// replay guard (MVP)
    mapping(bytes32 => bool) public usedDigest;

    event AccountRegistered(
        address indexed owner, address managedWallet, address returnAddress, address asset
    );
    event VenueSet(address indexed owner, address indexed venue, bool allowed);
    event ActionExecuted(
        address indexed owner, uint8 kind, address asset, uint256 amount, address dest, address signer
    );

    error ZeroAddress();
    error NoAccount();
    error WrongAsset();
    error VenueNotAllowed();
    error NotReturnAddress();
    error BadKind();
    error Replay();
    error BadSigner();
    error TransferFailed();

    /// @notice Owner registers or updates their managed wallet, return address and asset.
    function registerAccount(address managedWallet, address returnAddress, address asset) external {
        if (managedWallet == address(0) || returnAddress == address(0) || asset == address(0)) {
            revert ZeroAddress();
        }
        accounts[msg.sender] = Account(managedWallet, returnAddress, asset, true);
        emit AccountRegistered(msg.sender, managedWallet, returnAddress, asset);
    }

    /// @notice Owner adds or removes a vault from their allowlist.
    function setVenue(address venue, bool allowed) external {
        if (!accounts[msg.sender].exists) revert NoAccount();
        allowedVenue[msg.sender][venue] = allowed;
        emit VenueSet(msg.sender, venue, allowed);
    }

    /// @notice The exact digest the enclave signs.
    function actionDigest(uint8 kind, address asset, uint256 amount, address dest)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(kind, asset, amount, dest));
    }

    /// @notice Verify the enclave signature and destination, then release FXRP.
    function execute(
        address owner,
        uint8 kind,
        address asset,
        uint256 amount,
        address dest,
        bytes calldata signature
    ) external {
        Account memory a = accounts[owner];
        if (!a.exists) revert NoAccount();
        if (asset != a.asset) revert WrongAsset();

        // On-chain half of the guard — destinations are constrained here too.
        if (kind == KIND_ALLOCATE || kind == KIND_REBALANCE) {
            if (!allowedVenue[owner][dest]) revert VenueNotAllowed();
        } else if (kind == KIND_WITHDRAW) {
            if (dest != a.returnAddress) revert NotReturnAddress();
        } else {
            revert BadKind();
        }

        bytes32 d = actionDigest(kind, asset, amount, dest);
        if (usedDigest[d]) revert Replay();
        if (_recover(d, signature) != a.managedWallet) revert BadSigner();
        usedDigest[d] = true;

        if (!IERC20(asset).transfer(dest, amount)) revert TransferFailed();
        emit ActionExecuted(owner, kind, asset, amount, dest, a.managedWallet);
    }

    /// @notice Read-only preview of execute()'s verification — destination
    ///         allowlist + signature recovery — WITHOUT the token transfer or the
    ///         replay marking. This lets the enclave's signature be proven on-chain
    ///         before the vault holds any FXRP (the mint comes later). It runs the
    ///         exact same digest + recover logic execute() does.
    /// @return ok        true iff the destination is permitted AND the signature
    ///                   recovers to the registered managed wallet.
    /// @return recovered the address recovered from the signature.
    /// @return reason    "ok" or the first failing check.
    function previewExecute(
        address owner,
        uint8 kind,
        address asset,
        uint256 amount,
        address dest,
        bytes calldata signature
    ) external view returns (bool ok, address recovered, string memory reason) {
        Account memory a = accounts[owner];
        if (!a.exists) return (false, address(0), "no account");
        if (asset != a.asset) return (false, address(0), "wrong asset");

        if (kind == KIND_ALLOCATE || kind == KIND_REBALANCE) {
            if (!allowedVenue[owner][dest]) return (false, address(0), "venue not allowed");
        } else if (kind == KIND_WITHDRAW) {
            if (dest != a.returnAddress) return (false, address(0), "not return address");
        } else {
            return (false, address(0), "bad kind");
        }

        bytes32 d = actionDigest(kind, asset, amount, dest);
        recovered = _recover(d, signature);
        ok = recovered == a.managedWallet;
        reason = ok ? "ok" : "signer mismatch";
    }

    function _recover(bytes32 hash, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        return ecrecover(hash, v, r, s);
    }
}
