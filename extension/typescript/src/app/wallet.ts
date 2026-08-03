/**
 * ★ Mindorr managed wallet — the in-enclave signing key.
 *
 * Mirrors the fce-sign primitive: a secp256k1 key is delivered encrypted to the
 * TEE, decrypted *inside* the enclave via the node's /decrypt endpoint, and held
 * only in enclave memory. It is never exported and never leaves the TEE.
 *
 * This is one half of Mindorr's trust story; the other half is policy.ts, which
 * decides whether a given digest may be signed at all. handlers.ts joins them:
 * evaluate first, sign only on approval.
 */

import type { Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import { NodeClient } from "../base/node.js";
import type { Address } from "./policy.js";

export class ManagedWallet {
  private account: PrivateKeyAccount | null = null;

  hasKey(): boolean {
    return this.account !== null;
  }

  /** The managed wallet's public address, or null before a key is loaded. */
  address(): Address | null {
    return this.account ? this.account.address : null;
  }

  /**
   * Load a raw 32-byte secp256k1 private key that is already in plaintext.
   * Used after the enclave has decrypted a delivered key, and directly in tests.
   */
  loadKey(privKey: Uint8Array): void {
    if (privKey.length !== 32) {
      throw new Error(`expected a 32-byte secp256k1 key, got ${privKey.length} bytes`);
    }
    const hex = `0x${Buffer.from(privKey).toString("hex")}` as Hex;
    this.account = privateKeyToAccount(hex);
  }

  /**
   * Production path: decrypt a key that was encrypted to this TEE's public key,
   * then load it. The decrypt happens inside the enclave via the node.
   */
  async loadEncryptedKey(signPort: string | number, encrypted: Uint8Array): Promise<void> {
    const plain = await new NodeClient(signPort).decrypt(encrypted);
    this.loadKey(plain);
  }

  /** Sign a 32-byte digest with the managed key. Throws if no key is loaded. */
  async signDigest(hash: Hex): Promise<Hex> {
    if (!this.account) {
      throw new Error("no managed key loaded");
    }
    return this.account.sign({ hash });
  }

  clear(): void {
    this.account = null;
  }
}
