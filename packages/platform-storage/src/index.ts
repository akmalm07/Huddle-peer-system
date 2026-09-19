/** Ciphertext-only local persistence contract shared by web, desktop, and mobile. */
export interface EncryptedRecordRepository<RecordId extends string> {
  read(id: RecordId): Promise<Uint8Array | undefined>;
  commit(id: RecordId, ciphertext: Uint8Array): Promise<void>;
  remove(id: RecordId): Promise<void>;
}

export interface WebStorageCapabilities {
  readonly kind: "indexeddb";
  requestPersistentStorage(): Promise<boolean>;
}

export interface NativeStorageCapabilities {
  readonly kind: "sqlite-secure-keystore";
  readonly secureKeyStoreAvailable: boolean;
}
