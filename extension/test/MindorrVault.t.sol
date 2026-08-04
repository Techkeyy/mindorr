// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {MindorrVault} from "../contracts/MindorrVault.sol";

/// Minimal Foundry cheatcode surface — avoids a forge-std dependency so the
/// suite builds with no `forge install` on a network-flaky machine.
interface Vm {
    function addr(uint256 privateKey) external pure returns (address);
    function sign(uint256 privateKey, bytes32 digest)
        external
        pure
        returns (uint8 v, bytes32 r, bytes32 s);
    function prank(address sender) external;
    function expectRevert(bytes4 revertData) external;
}

/// Trivial ERC20 sufficient for exercising the vault's transfers.
contract MockERC20 {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MindorrVaultTest {
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    MindorrVault vault;
    MockERC20 fxrp;

    // The in-enclave key lives off-chain; here a test scalar stands in for it.
    uint256 constant ENCLAVE_PK = 0xA11CE;
    uint256 constant ATTACKER_PK = 0xB0B;

    // Mirror the vault's kind constants locally: calling the getters after
    // vm.expectRevert would make the cheatcode latch onto the getter call.
    uint8 constant ALLOCATE = 1;
    uint8 constant WITHDRAW = 3;

    address enclave; // managed wallet address (vm.addr(ENCLAVE_PK))
    address owner = address(0x0011);
    address returnAddr = address(0x0022);
    address vaultA = address(0xAA01);
    address attacker = address(0xDEAD);

    function setUp() public {
        vault = new MindorrVault();
        fxrp = new MockERC20();
        enclave = vm.addr(ENCLAVE_PK);

        // Owner registers their enclave wallet + return address + asset, and
        // allowlists one vault.
        vm.prank(owner);
        vault.registerAccount(enclave, returnAddr, address(fxrp));
        vm.prank(owner);
        vault.setVenue(vaultA, true);

        // Fund the vault with FXRP it can deploy / return.
        fxrp.mint(address(vault), 1_000_000);
    }

    // --- helpers ------------------------------------------------------------

    function _sign(uint256 pk, uint8 kind, uint256 amount, address dest)
        internal
        view
        returns (bytes memory)
    {
        bytes32 d = vault.actionDigest(kind, address(fxrp), amount, dest);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, d);
        return abi.encodePacked(r, s, v);
    }

    function _assertEq(uint256 a, uint256 b, string memory m) internal pure {
        require(a == b, m);
    }

    // --- allocate -----------------------------------------------------------

    function test_allocate_toAllowedVault_movesFunds() public {
        bytes memory sig = _sign(ENCLAVE_PK, ALLOCATE, 1000, vaultA);
        vault.execute(owner, ALLOCATE, address(fxrp), 1000, vaultA, sig);
        _assertEq(fxrp.balanceOf(vaultA), 1000, "vault A should have received 1000");
        _assertEq(fxrp.balanceOf(address(vault)), 999_000, "vault balance should drop");
    }

    function test_allocate_toUnlistedVenue_reverts() public {
        bytes memory sig = _sign(ENCLAVE_PK, ALLOCATE, 1000, attacker);
        vm.expectRevert(MindorrVault.VenueNotAllowed.selector);
        vault.execute(owner, ALLOCATE, address(fxrp), 1000, attacker, sig);
    }

    function test_allocate_badSigner_reverts() public {
        // Attacker signs a well-formed action to an allowed vault, but with the
        // wrong key — the enclave signature check must reject it.
        bytes memory sig = _sign(ATTACKER_PK, ALLOCATE, 1000, vaultA);
        vm.expectRevert(MindorrVault.BadSigner.selector);
        vault.execute(owner, ALLOCATE, address(fxrp), 1000, vaultA, sig);
    }

    // --- withdraw -----------------------------------------------------------

    function test_withdraw_toReturnAddress_movesFunds() public {
        bytes memory sig = _sign(ENCLAVE_PK, WITHDRAW, 500, returnAddr);
        vault.execute(owner, WITHDRAW, address(fxrp), 500, returnAddr, sig);
        _assertEq(fxrp.balanceOf(returnAddr), 500, "return address should receive 500");
    }

    function test_withdraw_toForeignAddress_reverts() public {
        // Even a validly signed withdrawal cannot escape to a foreign address.
        bytes memory sig = _sign(ENCLAVE_PK, WITHDRAW, 500, attacker);
        vm.expectRevert(MindorrVault.NotReturnAddress.selector);
        vault.execute(owner, WITHDRAW, address(fxrp), 500, attacker, sig);
    }

    // --- replay -------------------------------------------------------------

    function test_replay_reverts() public {
        bytes memory sig = _sign(ENCLAVE_PK, ALLOCATE, 1000, vaultA);
        vault.execute(owner, ALLOCATE, address(fxrp), 1000, vaultA, sig);
        vm.expectRevert(MindorrVault.Replay.selector);
        vault.execute(owner, ALLOCATE, address(fxrp), 1000, vaultA, sig);
    }
}
