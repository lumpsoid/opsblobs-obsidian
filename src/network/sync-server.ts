// ─────────────────────────────────────────────
//  Sync Server (Responder / Device B)
//  Phase 3.1 / 3.2
// ─────────────────────────────────────────────
//
//  Starts a local HTTP server. Device A connects to it.
//  All messages are encrypted with the paired device's key.

import {
  VaultState,
  ProtoMessage,
  ProtoHello,
  ProtoOpsExchange,
  ProtoStateExchange,
  ProtoContentRequest,
  ProtoContentResponse,
  ProtoSyncComplete,
  FileEntry,
  SyncSettings,
} from '../types';
import { Encryption } from './encryption';
import { HybridLogicalClock } from '../core/hlc';
import { mergeVaultStates } from '../merge/state-merge';
import { SyncApplicator } from './sync-applicator';

export interface SyncServerOptions {
  port?: number;
  localState: VaultState;
  settings: SyncSettings;
  hlc: HybridLogicalClock;
  applicator: SyncApplicator;
  onProgress?: (label: string, current: number, total: number) => void;
  onComplete?: () => void;
  onError?: (err: Error) => void;
}

export class SyncServer {
  private server: any = null;  // http.Server (Node) or Capacitor equivalent
  private port = 0;
  private sessionId: string;
  private encryption: Encryption | null = null;

  constructor(private options: SyncServerOptions) {
    this.sessionId = `${options.localState.deviceId}-${Date.now()}`;
  }

  getPort(): number { return this.port; }
  getSessionId(): string { return this.sessionId; }

  async start(preferredPort = 0): Promise<number> {
    // Use fetch-based HTTP in Obsidian's environment (works on mobile)
    // The actual HTTP server is implemented via Obsidian's requestUrl + a listener approach
    // For the plugin, we use a simple in-memory message bus during local sync
    // and HTTP for real network sync.
    //
    // This is a simplified skeleton — the actual server implementation
    // depends on the platform (Node http module on desktop, Capacitor on mobile).
    this.port = preferredPort || this.randomPort();
    return this.port;
  }

  async stop(): Promise<void> {
    this.server?.close?.();
    this.server = null;
  }

  /** Handle an incoming sync request (called by the HTTP layer). */
  async handleRequest(encryptedBody: string, deviceKey: string): Promise<string> {
    const enc = new Encryption();
    await enc.importKey(deviceKey);
    const message = await enc.decrypt<ProtoMessage>(encryptedBody);
    const response = await this.processMessage(message, enc);
    return enc.encrypt(response);
  }

  private async processMessage(msg: ProtoMessage, enc: Encryption): Promise<ProtoMessage> {
    const { localState, hlc, applicator, onProgress } = this.options;

    switch (msg.type) {
      case 'HELLO': {
        hlc.merge(msg.hlc);
        const reply: ProtoHello = {
          type: 'HELLO',
          deviceId: localState.deviceId,
          deviceName: this.getDeviceName(),
          hlc: hlc.now(),
          sessionId: this.sessionId,
        };
        return reply;
      }

      case 'OPS_SINCE': {
        // Remote sent its ops; we respond with ours
        const reply: ProtoOpsExchange = {
          type: 'OPS_SINCE',
          ops: localState.pendingOps,
          lastSyncHlc: localState.hlc,
        };
        return reply;
      }

      case 'STATE': {
        const remoteEntries = new Map<string, FileEntry>(msg.fileEntries);
        const remoteState: VaultState = {
          deviceId: 'remote',
          hlc: localState.hlc,
          fileEntries: remoteEntries,
          pendingOps: [],
          contentStore: new Map(),
        };

        const result = mergeVaultStates(localState, remoteState);
        // Respond with our state
        const reply: ProtoStateExchange = {
          type: 'STATE',
          fileEntries: Array.from(localState.fileEntries.entries()),
        };
        return reply;
      }

      case 'CONTENT_REQUEST': {
        const chunks: Array<{ hash: string; dataBase64: string }> = [];
        for (const hash of msg.hashes) {
          const content = localState.contentStore.get(hash);
          if (content) {
            chunks.push({ hash, dataBase64: btoa(String.fromCharCode(...content)) });
          }
        }
        const reply: ProtoContentResponse = { type: 'CONTENT', chunks };
        return reply;
      }

      case 'SYNC_COMPLETE': {
        hlc.merge(msg.newHlc);
        onProgress?.('Sync complete', 1, 1);
        this.options.onComplete?.();
        return { type: 'SYNC_COMPLETE', newHlc: hlc.now() };
      }

      default:
        return { type: 'ERROR', code: 'UNKNOWN_MESSAGE', message: 'Unknown message type' };
    }
  }

  private getDeviceName(): string {
    return this.options.settings.deviceName || 'Unknown Device';
  }

  private randomPort(): number {
    return 40000 + Math.floor(Math.random() * 10000);
  }
}
