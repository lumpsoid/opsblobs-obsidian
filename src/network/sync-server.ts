// ─────────────────────────────────────────────
//  Sync Server (Responder / Device B)
//  Phase 3.1 / 3.2
//
//  Starts a local HTTP server on the configured port.
//  The client (Device A) connects and drives the protocol.
//  All messages are AES-256-GCM encrypted with the paired device's key.
//
//  Session state is accumulated across sequential requests so the server
//  can reconstruct the remote VaultState and apply the merge at SYNC_COMPLETE.
// ─────────────────────────────────────────────

import {
  VaultState,
  FileEntry,
  Operation,
  ProtoMessage,
  ProtoHello,
  ProtoOpsExchange,
  ProtoStateExchange,
  ProtoContentRequest,
  ProtoContentResponse,
  ProtoContentPush,
  ProtoSyncComplete,
  PairedDevice,
  SyncSettings,
} from '../types';
import { Encryption, base64ToBytes, bytesToBase64 } from './encryption';
import { HybridLogicalClock } from '../core/hlc';
import { mergeVaultStates } from '../merge/state-merge';
import { SyncApplicator } from './sync-applicator';

export interface SyncServerOptions {
  port?: number;
  localState: VaultState;
  pairedDevice: PairedDevice;
  settings: SyncSettings;
  hlc: HybridLogicalClock;
  applicator: SyncApplicator;
  onProgress?: (label: string, current: number, total: number) => void;
  onComplete?: () => void;
  onError?: (err: Error) => void;
}

// Accumulated remote state built up across sequential HTTP requests.
interface ServerSession {
  remoteDeviceId: string;
  remoteHlc: ProtoHello['hlc'];
  remoteOps: Operation[];
  remoteFileEntries: Map<string, FileEntry>;
  pushedContent: Map<string, Uint8Array>;  // content uploaded by the client
}

export class SyncServer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private server: any = null;
  private port = 0;
  private enc: Encryption;
  private session: ServerSession | null = null;

  // Public callbacks — can be overwritten after construction
  onComplete: (() => void) | undefined;
  onError: ((err: Error) => void) | undefined;

  constructor(private options: SyncServerOptions) {
    this.enc = new Encryption();
    this.onComplete = options.onComplete;
    this.onError = options.onError;
  }

  getPort(): number { return this.port; }

  /**
   * Start listening. Resolves with the actual port once the server is bound.
   * Throws if not running in a desktop (Node.js) environment.
   */
  async start(preferredPort?: number): Promise<number> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof (globalThis as any).require === 'undefined') {
      throw new Error(
        'Sync server requires a desktop environment (Node.js). ' +
        'On mobile, use client mode by connecting to another device.',
      );
    }

    await this.enc.importKey(this.options.pairedDevice.encryptionKeyBase64);

    return new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const http = (globalThis as any).require('http');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.server = http.createServer((req: any, res: any) => {
        if (req.method !== 'POST' || req.url !== '/sync') {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }

        let body = '';
        req.on('data', (chunk: string) => { body += chunk; });
        req.on('end', async () => {
          try {
            const { data } = JSON.parse(body) as { data: string };
            const message = await this.enc.decrypt<ProtoMessage>(data);
            const reply = await this.processMessage(message);
            const encrypted = await this.enc.encrypt(reply);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: encrypted }));
          } catch (err) {
            console.error('SyncServer request error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: String(err) }));
          }
        });
      });

      const listenPort = preferredPort ?? this.options.port ?? this.options.settings.syncPort;
      this.server.listen(listenPort, '0.0.0.0', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const addr = this.server.address() as { port: number };
        this.port = addr.port;
        resolve(this.port);
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.server.on('error', (err: any) => {
        // If the preferred port is in use, retry on a random port
        if (err.code === 'EADDRINUSE' && preferredPort) {
          this.server.listen(0, '0.0.0.0');
        } else {
          reject(err as Error);
        }
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise(resolve => {
      if (this.server) {
        this.server.close(() => resolve());
        this.server = null;
      } else {
        resolve();
      }
    });
  }

  // ─── Protocol ─────────────────────────────────────────────────────────────

  private async processMessage(msg: ProtoMessage): Promise<ProtoMessage> {
    const { localState, hlc, applicator, onProgress } = this.options;

    switch (msg.type) {
      // ── 1. HELLO ────────────────────────────────────────────────────────
      case 'HELLO': {
        hlc.merge(msg.hlc);
        // Start a fresh session for this sync
        this.session = {
          remoteDeviceId: msg.deviceId,
          remoteHlc: msg.hlc,
          remoteOps: [],
          remoteFileEntries: new Map(),
          pushedContent: new Map(),
        };
        onProgress?.('Connected', 0, 5);
        const reply: ProtoHello = {
          type: 'HELLO',
          deviceId: localState.deviceId,
          deviceName: this.options.settings.deviceName || 'Unknown Device',
          hlc: hlc.now(),
          sessionId: `${localState.deviceId}-${Date.now()}`,
        };
        return reply;
      }

      // ── 2. OPS_SINCE ────────────────────────────────────────────────────
      case 'OPS_SINCE': {
        if (!this.session) throw new Error('Session not initialised — send HELLO first');
        // Store the client's ops for use at SYNC_COMPLETE
        this.session.remoteOps = msg.ops;
        onProgress?.('Exchanging operation logs', 1, 5);
        const reply: ProtoOpsExchange = {
          type: 'OPS_SINCE',
          ops: localState.pendingOps,
          lastSyncHlc: this.options.pairedDevice.lastSyncHlc,
        };
        return reply;
      }

      // ── 3. STATE ────────────────────────────────────────────────────────
      case 'STATE': {
        if (!this.session) throw new Error('Session not initialised — send HELLO first');
        this.session.remoteFileEntries = new Map(msg.fileEntries);
        onProgress?.('Exchanging vault state', 2, 5);

        // Determine which hashes we (server) need the client to push.
        // Any content hash in the client's file entries that we don't have locally.
        const hashesNeeded: string[] = [];
        for (const [, entry] of this.session.remoteFileEntries) {
          if (!entry.deleted && !localState.contentStore.has(entry.contentHash)) {
            hashesNeeded.push(entry.contentHash);
          }
          if (entry.ancestorContentHash && !localState.contentStore.has(entry.ancestorContentHash)) {
            hashesNeeded.push(entry.ancestorContentHash);
          }
        }

        const reply: ProtoStateExchange = {
          type: 'STATE',
          fileEntries: Array.from(localState.fileEntries.entries()),
          hashesNeeded,
        };
        return reply;
      }

      // ── 4a. CONTENT_REQUEST (client asking server for content) ───────────
      case 'CONTENT_REQUEST': {
        onProgress?.(`Sending ${msg.hashes.length} file(s) to client`, 3, 5);
        const chunks: Array<{ hash: string; dataBase64: string }> = [];
        for (const hash of msg.hashes) {
          const content = localState.contentStore.get(hash);
          if (content) {
            chunks.push({ hash, dataBase64: bytesToBase64(content) });
          }
        }
        const reply: ProtoContentResponse = { type: 'CONTENT', chunks };
        return reply;
      }

      // ── 4b. CONTENT_PUSH (client uploading content the server requested) ─
      case 'CONTENT_PUSH': {
        if (!this.session) throw new Error('Session not initialised — send HELLO first');
        for (const chunk of msg.chunks) {
          this.session.pushedContent.set(chunk.hash, base64ToBytes(chunk.dataBase64));
        }
        onProgress?.(`Received ${msg.chunks.length} file(s) from client`, 4, 5);
        // Acknowledge — return a no-op CONTENT response
        const reply: ProtoContentResponse = { type: 'CONTENT', chunks: [] };
        return reply;
      }

      // ── 5. SYNC_COMPLETE ─────────────────────────────────────────────────
      case 'SYNC_COMPLETE': {
        if (!this.session) throw new Error('Session not initialised — send HELLO first');
        hlc.merge(msg.newHlc);

        // Build the remote VaultState from accumulated session data
        const remoteContentStore = new Map<string, Uint8Array>([
          ...localState.contentStore,     // server's own content (for ancestor lookups)
          ...this.session.pushedContent,  // content uploaded by client
        ]);
        const remoteState: VaultState = {
          deviceId: this.session.remoteDeviceId,
          hlc: this.session.remoteHlc,
          fileEntries: this.session.remoteFileEntries,
          pendingOps: this.session.remoteOps,
          contentStore: remoteContentStore,
        };

        // Run the same deterministic merge the client ran
        const mergeResult = mergeVaultStates(localState, remoteState);
        onProgress?.('Applying changes', 5, 5);
        await applicator.applyActions(mergeResult.actions, localState, remoteState);

        this.session = null;
        this.onComplete?.();

        return { type: 'SYNC_COMPLETE', newHlc: hlc.now() };
      }

      default:
        return { type: 'ERROR', code: 'UNKNOWN_MESSAGE', message: 'Unknown message type' };
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Return all non-loopback IPv4 addresses for this machine.
 * Uses Node's `os` module — desktop only.
 */
export function getLocalIPs(): string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const os = (globalThis as any).require('os');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ifaces = os.networkInterfaces() as Record<string, Array<any>>;
    const ips: string[] = [];
    for (const list of Object.values(ifaces)) {
      for (const iface of list) {
        if (iface.family === 'IPv4' && !iface.internal) {
          ips.push(iface.address as string);
        }
      }
    }
    return ips;
  } catch {
    return [];
  }
}
