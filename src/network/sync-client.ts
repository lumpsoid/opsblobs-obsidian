// ─────────────────────────────────────────────
//  Sync Client (Initiator / Device A)
//  Phase 3.1 / 3.2
// ─────────────────────────────────────────────

import { requestUrl } from 'obsidian';
import {
  VaultState,
  ProtoMessage,
  ProtoHello,
  ProtoOpsExchange,
  ProtoStateExchange,
  ProtoContentRequest,
  ProtoContentResponse,
  ProtoSyncComplete,
  SyncSession,
  PairedDevice,
} from '../types';
import { Encryption, base64ToBytes } from './encryption';
import { HybridLogicalClock } from '../core/hlc';
import { mergeVaultStates } from '../merge/state-merge';
import { SyncApplicator } from './sync-applicator';

export interface SyncClientOptions {
  remoteIp: string;
  remotePort: number;
  pairedDevice: PairedDevice;
  localState: VaultState;
  hlc: HybridLogicalClock;
  applicator: SyncApplicator;
  onProgress?: (label: string, current: number, total: number) => void;
}

export class SyncClient {
  private enc: Encryption;
  private baseUrl: string;
  private sessionId: string;

  constructor(private options: SyncClientOptions) {
    this.enc = new Encryption();
    this.baseUrl = `http://${options.remoteIp}:${options.remotePort}`;
    this.sessionId = `${options.localState.deviceId}-${Date.now()}`;
  }

  async runSync(): Promise<void> {
    const { localState, hlc, applicator, onProgress, pairedDevice } = this.options;

    await this.enc.importKey(pairedDevice.encryptionKeyBase64);

    // ── Step 1: HELLO exchange ───────────────────────────────────────────
    onProgress?.('Connecting...', 0, 5);
    const hello: ProtoHello = {
      type: 'HELLO',
      deviceId: localState.deviceId,
      deviceName: 'This device',
      hlc: hlc.now(),
      sessionId: this.sessionId,
    };
    const helloResp = await this.send<ProtoHello>(hello);
    if (helloResp.type !== 'HELLO') throw new Error('Expected HELLO response');
    hlc.merge(helloResp.hlc);

    // ── Step 2: Exchange operation logs ──────────────────────────────────
    onProgress?.('Exchanging operation logs...', 1, 5);
    const opsMsg: ProtoOpsExchange = {
      type: 'OPS_SINCE',
      ops: localState.pendingOps,
      lastSyncHlc: pairedDevice.lastSyncHlc,
    };
    const opsResp = await this.send<ProtoOpsExchange>(opsMsg);
    if (opsResp.type !== 'OPS_SINCE') throw new Error('Expected OPS_SINCE response');

    // ── Step 3: Exchange full state ───────────────────────────────────────
    onProgress?.('Exchanging vault state...', 2, 5);
    const stateMsg: ProtoStateExchange = {
      type: 'STATE',
      fileEntries: Array.from(localState.fileEntries.entries()),
    };
    const stateResp = await this.send<ProtoStateExchange>(stateMsg);
    if (stateResp.type !== 'STATE') throw new Error('Expected STATE response');

    // ── Step 4: Compute merge ─────────────────────────────────────────────
    onProgress?.('Computing merge...', 3, 5);
    const remoteState: VaultState = {
      deviceId: helloResp.deviceId,
      hlc: helloResp.hlc,
      fileEntries: new Map(stateResp.fileEntries),
      pendingOps: opsResp.ops,
      contentStore: new Map(),
    };

    // Collect hashes we need from remote
    const hashesNeeded: string[] = [];
    for (const [, entry] of remoteState.fileEntries) {
      if (!entry.deleted && !localState.contentStore.has(entry.contentHash)) {
        hashesNeeded.push(entry.contentHash);
      }
      if (entry.ancestorContentHash && !localState.contentStore.has(entry.ancestorContentHash)) {
        hashesNeeded.push(entry.ancestorContentHash);
      }
    }

    // ── Step 5: Fetch content we need ─────────────────────────────────────
    if (hashesNeeded.length > 0) {
      onProgress?.(`Downloading ${hashesNeeded.length} files...`, 4, 5);
      const contentReq: ProtoContentRequest = { type: 'CONTENT_REQUEST', hashes: hashesNeeded };
      const contentResp = await this.send<ProtoContentResponse>(contentReq);
      if (contentResp.type !== 'CONTENT') throw new Error('Expected CONTENT response');

      for (const chunk of contentResp.chunks) {
        const bytes = base64ToBytes(chunk.dataBase64);
        remoteState.contentStore.set(chunk.hash, bytes);
      }
    }

    // ── Step 5b: Send content remote needs ────────────────────────────────
    const hashesForRemote: string[] = [];
    for (const [, entry] of localState.fileEntries) {
      if (!entry.deleted) hashesForRemote.push(entry.contentHash);
    }
    // (Remote will request what it needs via CONTENT_REQUEST — handled by server)

    // ── Step 6: Apply merge ───────────────────────────────────────────────
    onProgress?.('Applying changes...', 5, 5);
    const mergeResult = mergeVaultStates(localState, remoteState);
    await applicator.applyActions(mergeResult.actions, localState, remoteState);

    // ── Step 7: Complete handshake ────────────────────────────────────────
    const completeMsg: ProtoSyncComplete = {
      type: 'SYNC_COMPLETE',
      newHlc: mergeResult.mergedHlc,
    };
    await this.send<ProtoSyncComplete>(completeMsg);
    hlc.setCurrent(mergeResult.mergedHlc);
  }

  private async send<T extends ProtoMessage>(message: ProtoMessage): Promise<T> {
    const encrypted = await this.enc.encrypt(message);
    const response = await requestUrl({
      url: `${this.baseUrl}/sync`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: encrypted }),
    });
    const body = response.json as { data: string };
    return this.enc.decrypt<T>(body.data);
  }
}
