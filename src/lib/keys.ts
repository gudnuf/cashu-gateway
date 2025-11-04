import { HDKey } from "@scure/bip32";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { getPublicKey } from "nostr-tools";

/**
 * Manages BIP39 mnemonic-derived Nostr keypairs following NIP-06 specification
 */
export class Keys {
  private mnemonic: string;
  private privateKey: Uint8Array;
  public publicKey: Uint8Array;

  /**
   * @param mnemonic - BIP39 mnemonic phrase (12-24 words)
   * @param derivationPath - BIP32 derivation path (default: m/44'/1237'/0'/0/0 per NIP-06)
   */
  constructor(mnemonic: string, derivationPath: string = "m/44'/1237'/0'/0/0") {
    if (!validateMnemonic(mnemonic, wordlist)) {
      throw new Error("Invalid BIP39 mnemonic");
    }

    this.mnemonic = mnemonic;

    const seed = mnemonicToSeedSync(mnemonic);
    const hdKey = HDKey.fromMasterSeed(seed);
    const derivedKey = hdKey.derive(derivationPath);

    if (!derivedKey.privateKey) {
      throw new Error("Failed to derive private key");
    }

    this.privateKey = derivedKey.privateKey;

    const publicKeyHex = getPublicKey(this.privateKey);
    this.publicKey = Buffer.from(publicKeyHex, "hex");
  }

  getPrivateKeyHex(): string {
    return Buffer.from(this.privateKey).toString("hex");
  }

  getPublicKeyHex(): string {
    return Buffer.from(this.publicKey).toString("hex");
  }

  getPrivateKey(): Uint8Array {
    return this.privateKey;
  }

  getPublicKey(): Uint8Array {
    return this.publicKey;
  }

  getMnemonic(): string {
    return this.mnemonic;
  }

  /**
   * @param strength - Mnemonic strength in bits (128 = 12 words, 256 = 24 words)
   */
  static generateMnemonic(strength: number = 128): string {
    return generateMnemonic(wordlist, strength);
  }
}
