/**
 * ★ Mindorr managed wallets, per-user in-enclave signing keys.
 *
 * Multi-tenant model: the enclave holds ONE master seed, delivered encrypted to
 * the TEE and decrypted inside it via the node's /decrypt endpoint (the fce-sign
 * primitive). From that seed it deterministically derives a distinct secp256k1
 * key per user as keccak256(masterSeed ‖ userAddress). Each user therefore gets
 * their own managed wallet whose private key is born inside the enclave, never
 * leaves it, and is reproducible across enclave restarts (so a user's vault is
 * never orphaned). The seed is the only secret that ever crosses the wire, and
 * it does so encrypted to the TEE's attested key.
 *
 * This is one half of Mindorr's trust story; the other half is policy.ts, which
 * decides whether a given digest may be signed at all. handlers.ts joins them:
 * evaluate first, sign only on approval.
 */

import { keccak256, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import { bytesToHex, hexToBytes } from "../base/encoding.js";
import { NodeClient } from "../base/node.js";
import type { Address } from "./policy.js";

/** A single user's in-enclave signing key. */
export class ManagedWallet {
  private constructor(private readonly account: PrivateKeyAccount) {}

  /** Build from a raw 32-byte secp256k1 private key already in enclave memory. */
  static fromPrivateKey(privKey: Uint8Array): ManagedWallet {
    if (privKey.length !== 32) {
      throw new Error(`expected a 32-byte secp256k1 key, got ${privKey.length} bytes`);
    }
    const hex = bytesToHex(privKey) as Hex;
    return new ManagedWallet(privateKeyToAccount(hex));
  }

  /** The managed wallet's public address. */
  address(): Address {
    return this.account.address;
  }

  /** Sign a 32-byte digest with this managed key. */
  async signDigest(hash: Hex): Promise<Hex> {
    return this.account.sign({ hash });
  }
}

/**
 * Holds the master seed and vends deterministic per-user managed wallets.
 * Derivation is pure and cached, so the same user always resolves to the same
 * wallet for the life of the seed.
 */
export class WalletManager {
  private seed: Uint8Array | null = null;
  private readonly cache = new Map<string, ManagedWallet>();

  /** True once the master seed has been delivered. */
  hasSeed(): boolean {
    return this.seed !== null;
  }

  /**
   * Load a raw 32-byte master seed already in plaintext. Used after the enclave
   * has decrypted a delivered seed, and directly in tests.
   */
  loadSeed(seed: Uint8Array): void {
    if (seed.length !== 32) {
      throw new Error(`expected a 32-byte master seed, got ${seed.length} bytes`);
    }
    this.seed = seed;
    this.cache.clear();
  }

  /**
   * Production path: decrypt a master seed encrypted to this TEE's public key,
   * then load it. The decrypt happens inside the enclave via the node.
   */
  async loadEncryptedSeed(signPort: string | number, encrypted: Uint8Array): Promise<void> {
    const plain = await new NodeClient(signPort).decrypt(encrypted);
    this.loadSeed(plain);
  }

  /**
   * The managed wallet for `user`, derived deterministically from the master
   * seed. Throws if no seed is loaded.
   */
  walletFor(user: Address): ManagedWallet {
    if (!this.seed) {
      throw new Error("no master seed loaded");
    }
    const key = user.toLowerCase();
    let w = this.cache.get(key);
    if (!w) {
      w = ManagedWallet.fromPrivateKey(deriveKey(this.seed, user));
      this.cache.set(key, w);
    }
    return w;
  }

  clear(): void {
    this.seed = null;
    this.cache.clear();
  }
}

/**
 * Derive a user's 32-byte secp256k1 private key as keccak256(seed ‖ userBytes).
 * Deterministic, so it reproduces across enclave restarts.
 */
function deriveKey(seed: Uint8Array, user: Address): Uint8Array {
  const userBytes = hexToBytes(user);
  if (userBytes.length !== 20) {
    throw new Error(`user must be a 20-byte address, got ${userBytes.length} bytes`);
  }
  const material = new Uint8Array(seed.length + userBytes.length);
  material.set(seed, 0);
  material.set(userBytes, seed.length);
  return hexToBytes(keccak256(material));
}
