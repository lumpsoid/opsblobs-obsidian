// ─────────────────────────────────────────────
//  Settings Tab  (Phase 4)
// ─────────────────────────────────────────────
//
//  Server config + at-rest encryption for the client↔server pivot. The P2P
//  pairing flow is gone: a device is configured by a server URL, a vault ID +
//  token, and a vault passphrase. The passphrase-derived key never leaves the
//  device; its fingerprint lets two devices confirm they share the same key.

import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { SyncSettings } from '../types';

/** The slice of the plugin the settings tab drives. Implemented by the plugin. */
export interface SettingsHost extends Plugin {
  settings: SyncSettings;
  saveSettings(): Promise<void>;
  applyVaultKey(): Promise<void>;
  vaultKeyFingerprint(): string | null;
  setupAutoSync(): void;
  clearContentCache(): Promise<number>;
  resetSyncState(): Promise<void>;
  rebaselineToServer(): Promise<void>;
  recheckConflicts(): Promise<void>;
  syncNow(): Promise<void>;
  openSyncStatus(): void;
}

export class SyncSettingTab extends PluginSettingTab {
  constructor(app: App, private host: SettingsHost) {
    super(app, host);
  }

  private get settings(): SyncSettings {
    return this.host.settings;
  }

  private save(): Promise<void> {
    return this.host.saveSettings();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ── Device identity ───────────────────────────────────────────────────
    new Setting(containerEl).setName('This device').setHeading();

    new Setting(containerEl)
      .setName('Device name')
      .setDesc('A friendly name for this device.')
      .addText(t => {
        t.setValue(this.settings.deviceName)
          .setPlaceholder('My MacBook')
          .onChange(async v => {
            this.settings.deviceName = v;
            await this.save();
          });
      });

    new Setting(containerEl)
      .setName('Device ID')
      .setDesc('Unique identifier for this device (read-only).')
      .addText(t => {
        t.setValue(this.settings.deviceId).setDisabled(true);
      });

    // ── Server ────────────────────────────────────────────────────────────
    new Setting(containerEl).setName('Server').setHeading();

    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('Base URL of the sync server, e.g. https://sync.example.com')
      .addText(t => {
        t.setValue(this.settings.serverUrl)
          .setPlaceholder('https://sync.example.com')
          .onChange(async v => {
            this.settings.serverUrl = v.trim();
            await this.save();
          });
      });

    new Setting(containerEl)
      .setName('Vault ID')
      .setDesc('Identifies this vault on the server. Use the same value on every device.')
      .addText(t => {
        t.setValue(this.settings.vaultId)
          .setPlaceholder('my-notes')
          .onChange(async v => {
            this.settings.vaultId = v.trim();
            await this.save();
          });
      });

    new Setting(containerEl)
      .setName('Access token')
      .setDesc('Bearer token authorizing this device for the vault.')
      .addText(t => {
        t.setValue(this.settings.serverToken)
          .setPlaceholder('token…')
          .onChange(async v => {
            this.settings.serverToken = v.trim();
            await this.save();
          });
        t.inputEl.type = 'password';
      });

    // ── Encryption ────────────────────────────────────────────────────────
    new Setting(containerEl).setName('Encryption').setHeading();

    containerEl.createEl('p', {
      text: 'The passphrase derives the key that encrypts everything before it leaves this device. ' +
        'The server never sees it. Use the same passphrase on every device — the fingerprint below ' +
        'must match across devices.',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('Vault passphrase')
      .setDesc('Encrypts your notes end-to-end. If lost, encrypted data cannot be recovered.')
      .addText(t => {
        t.setValue(this.settings.vaultPassphrase)
          .setPlaceholder('correct horse battery staple')
          .onChange(async v => {
            this.settings.vaultPassphrase = v;
            await this.save();
          });
        t.inputEl.type = 'password';
      });

    const fingerprintSetting = new Setting(containerEl)
      .setName('Key fingerprint')
      .setDesc(this.fingerprintDesc());
    fingerprintSetting.addButton(btn => {
      btn.setButtonText('Derive & verify').onClick(async () => {
        try {
          await this.host.applyVaultKey();
          fingerprintSetting.setDesc(this.fingerprintDesc());
        } catch (e) {
          fingerprintSetting.setDesc(`Could not derive key: ${(e as Error).message}`);
        }
      });
    });

    // ── Sync behavior ─────────────────────────────────────────────────────
    new Setting(containerEl).setName('Sync behavior').setHeading();

    new Setting(containerEl)
      .setName('View sync status')
      .setDesc('See the last sync, pending changes, and any skipped conflicts or files needing attention.')
      .addButton(btn => {
        btn.setButtonText('View status').onClick(() => this.host.openSyncStatus());
      });

    new Setting(containerEl)
      .setName('Sync now')
      .setDesc('Run a full pull → merge → push round against the server.')
      .addButton(btn => {
        btn.setButtonText('Sync now').setCta().onClick(async () => {
          btn.setButtonText('Syncing…').setDisabled(true);
          try {
            await this.host.syncNow();
          } finally {
            btn.setButtonText('Sync now').setDisabled(false);
          }
        });
      });

    new Setting(containerEl)
      .setName('Auto-sync interval')
      .setDesc('Sync automatically this often. Set to 0 for manual sync only.')
      .addSlider(s => {
        s.setLimits(0, 60, 5)
          .setValue(this.settings.autoSyncIntervalMinutes)
          .setDynamicTooltip()
          .onChange(async v => {
            this.settings.autoSyncIntervalMinutes = v;
            await this.save();
            this.host.setupAutoSync();
          });
      });

    new Setting(containerEl)
      .setName('Debounce delay')
      .setDesc('Wait this many milliseconds after a file stops changing before recording an operation.')
      .addSlider(s => {
        s.setLimits(500, 5000, 100)
          .setValue(this.settings.debounceMs)
          .setDynamicTooltip()
          .onChange(async v => {
            this.settings.debounceMs = v;
            await this.save();
          });
      });

    new Setting(containerEl)
      .setName('Delete conflict strategy')
      .setDesc('What to do when one device deletes a file and the other modifies it.')
      .addDropdown(d => {
        d.addOption('ask', 'Ask me each time')
          .addOption('keep_deleted', 'Always keep the deletion')
          .addOption('keep_modified', 'Always keep the modified version')
          .setValue(this.settings.deleteConflictStrategy)
          .onChange(async v => {
            this.settings.deleteConflictStrategy = v as SyncSettings['deleteConflictStrategy'];
            await this.save();
          });
      });

    new Setting(containerEl)
      .setName('Sync Obsidian config')
      .setDesc('Sync files inside .obsidian/ (snippets, templates). Workspace layout is always excluded.')
      .addToggle(t => {
        t.setValue(this.settings.syncObsidianConfig)
          .onChange(async v => {
            this.settings.syncObsidianConfig = v;
            await this.save();
          });
      });

    // ── Exclusions ────────────────────────────────────────────────────────
    new Setting(containerEl).setName('Excluded paths').setHeading();
    containerEl.createEl('p', {
      text: 'Files and folders to exclude from sync (glob patterns, one per line).',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .addTextArea(ta => {
        ta.setValue(this.settings.excludedPatterns.join('\n'))
          .setPlaceholder('.obsidian/workspace.json\n.vault-sync/**')
          .onChange(async v => {
            this.settings.excludedPatterns = v.split('\n').map(s => s.trim()).filter(Boolean);
            await this.save();
          });
        ta.inputEl.rows = 5;
        ta.inputEl.addClass('vault-sync-exclusions');
      });

    // ── Storage ───────────────────────────────────────────────────────────
    new Setting(containerEl).setName('Storage').setHeading();

    new Setting(containerEl)
      .setName('Ancestor retention')
      .setDesc('Keep ancestor content for this many days before garbage collection.')
      .addSlider(s => {
        s.setLimits(7, 90, 1)
          .setValue(this.settings.ancestorRetentionDays)
          .setDynamicTooltip()
          .onChange(async v => {
            this.settings.ancestorRetentionDays = v;
            await this.save();
          });
      });

    new Setting(containerEl)
      .setName('Clear sync cache')
      .setDesc('Remove content-store blobs the registry no longer references. ' +
        'Safe — only affects three-way merge quality, not vault content.')
      .addButton(btn => {
        btn.setButtonText('Clear cache').setWarning().onClick(async () => {
          btn.setDisabled(true);
          const removed = await this.host.clearContentCache();
          btn.setButtonText(`Removed ${removed}`);
          setTimeout(() => { btn.setButtonText('Clear cache').setDisabled(false); }, 2000);
        });
      });

    new Setting(containerEl)
      .setName('Re-check for conflicts')
      .setDesc('Re-pull the whole server history and recompute every merge, then sync. ' +
        'Use this to bring back a conflict you skipped or dismissed by accident. ' +
        'Local content and pending changes are untouched.')
      .addButton(btn => {
        btn.setButtonText('Re-check').onClick(async () => {
          btn.setDisabled(true);
          await this.host.recheckConflicts();
          btn.setButtonText('Done');
          setTimeout(() => { btn.setButtonText('Re-check').setDisabled(false); }, 2000);
        });
      });

    new Setting(containerEl)
      .setName('Reset sync state')
      .setDesc('Rebuild the file registry from the vault and re-capture every file as ' +
        'pending operations. Use if sync metadata is corrupted. Un-synced changes are ' +
        're-captured and pushed on the next sync — never discarded. Vault content is never touched.')
      .addButton(btn => {
        btn.setButtonText('Reset').setWarning().onClick(async () => {
          btn.setDisabled(true);
          await this.host.resetSyncState();
          btn.setButtonText('Done');
          setTimeout(() => { btn.setButtonText('Reset').setDisabled(false); }, 2000);
        });
      });

    new Setting(containerEl)
      .setName('Re-baseline this device to the server')
      .setDesc('Push every file on this device to the server as the authoritative version — ' +
        'use to rebuild or recover the server from a device you trust. If another device ' +
        'edited the same file, this device wins. Vault content here is never touched.')
      .addButton(btn => {
        btn.setButtonText('Re-baseline').setWarning().onClick(async () => {
          btn.setDisabled(true);
          try {
            await this.host.rebaselineToServer();
          } finally {
            btn.setButtonText('Re-baseline').setDisabled(false);
          }
        });
      });
  }

  private fingerprintDesc(): string {
    const fp = this.host.vaultKeyFingerprint();
    return fp
      ? `Key ready — fingerprint ${fp}. This must match on every device.`
      : 'No key derived yet. Enter a passphrase and vault ID, then derive.';
  }
}
