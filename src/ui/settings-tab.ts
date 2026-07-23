// ─────────────────────────────────────────────
//  Settings Tab  (Phase 4)
// ─────────────────────────────────────────────
//
//  Server config + at-rest encryption for the client↔server pivot. The P2P
//  pairing flow is gone: a device is configured by a server URL, a vault ID +
//  token, and a vault passphrase. The passphrase-derived key never leaves the
//  device; its fingerprint lets two devices confirm they share the same key.
//
//  Layout is onboarding-first (UX audit §1.1): a Setup section groups the four
//  required fields under a live readiness checklist so a first-run user sees
//  exactly what is still missing; everyday sync controls follow; developer knobs
//  and maintenance/destructive actions are tucked behind Advanced / Danger-zone
//  disclosures so they never crowd the basics.

import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { SyncSettings } from '../types';

/** The slice of the plugin the settings tab drives. Implemented by the plugin. */
export interface SettingsHost extends Plugin {
  settings: SyncSettings;
  saveSettings(): Promise<void>;
  applyVaultKey(): Promise<void>;
  vaultKeyFingerprint(): string | null;
  testConnection(): Promise<string>;
  setupAutoSync(): void;
  clearContentCache(): Promise<number>;
  resetSyncState(): Promise<void>;
  rebaselineToServer(): Promise<void>;
  recheckConflicts(): Promise<void>;
  syncNow(): Promise<void>;
  openSyncStatus(): void;
}

export class SyncSettingTab extends PluginSettingTab {
  /** The live readiness line under the Setup heading. Re-rendered in place by
   *  {@link updateReadiness} whenever a required field changes, so the checklist
   *  tracks typing without a full settings re-display. */
  private readinessEl: HTMLElement | null = null;

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

    this.renderSetup(containerEl);
    this.renderDevice(containerEl);
    this.renderSync(containerEl);
    this.renderAdvanced(containerEl);
    this.renderDangerZone(containerEl);
  }

  // ─── Setup (required fields + readiness) ────────────────────────────────────

  private renderSetup(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Setup').setHeading();

    // The live checklist sits directly under the heading so the very first thing a
    // user sees is what still needs filling in and in what order.
    this.readinessEl = containerEl.createEl('div', { cls: 'vault-sync-readiness' });
    this.updateReadiness();

    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('Base URL of the sync server, e.g. https://sync.example.com')
      .addText(t => {
        t.setValue(this.settings.serverUrl)
          .setPlaceholder('https://sync.example.com')
          .onChange(async v => {
            this.settings.serverUrl = v.trim();
            await this.save();
            this.updateReadiness();
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
            this.updateReadiness();
          });
      });

    new Setting(containerEl)
      .setName('Access token')
      .setDesc('Token authorizing this device for the vault.')
      .addText(t => {
        t.setValue(this.settings.serverToken)
          .setPlaceholder('token…')
          .onChange(async v => {
            this.settings.serverToken = v.trim();
            await this.save();
            this.updateReadiness();
          });
        t.inputEl.type = 'password';
      });

    containerEl.createEl('p', {
      text: 'Your passphrase unlocks the key that encrypts everything before it leaves this device. ' +
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
            this.updateReadiness();
          });
        t.inputEl.type = 'password';
      });

    const fingerprintSetting = new Setting(containerEl)
      .setName('Key fingerprint')
      .setDesc(this.fingerprintDesc());
    // Copy affordance (UX audit §1.4): the fingerprint's whole job is to be compared
    // across devices, so make it one tap to copy instead of hand-transcribing a hex string.
    fingerprintSetting.addExtraButton(btn => {
      btn.setIcon('copy').setTooltip('Copy fingerprint').onClick(() => {
        const fp = this.host.vaultKeyFingerprint();
        if (fp) void navigator.clipboard?.writeText(fp);
      });
    });
    fingerprintSetting.addButton(btn => {
      btn.setButtonText('Unlock & verify').onClick(async () => {
        try {
          await this.host.applyVaultKey();
          fingerprintSetting.setDesc(this.fingerprintDesc());
        } catch (e) {
          fingerprintSetting.setDesc(`Couldn't unlock the vault: ${(e as Error).message}`);
        }
      });
    });

    const testSetting = new Setting(containerEl)
      .setName('Test connection')
      .setDesc('Check the server URL, token, vault, and passphrase without syncing anything.');
    testSetting.addButton(btn => {
      btn.setButtonText('Test').onClick(async () => {
        btn.setButtonText('Testing…').setDisabled(true);
        // Convey pass/fail by color, not a glyph (no-emoji UI decision, §5).
        testSetting.descEl.removeClass('vault-sync-test-ok', 'vault-sync-test-err');
        testSetting.setDesc('Testing…');
        try {
          testSetting.setDesc(await this.host.testConnection());
          testSetting.descEl.addClass('vault-sync-test-ok');
        } catch (e) {
          testSetting.setDesc((e as Error).message);
          testSetting.descEl.addClass('vault-sync-test-err');
        } finally {
          btn.setButtonText('Test').setDisabled(false);
        }
      });
    });

    this.renderAddDeviceHelp(containerEl);
  }

  /** A collapsible "here's how to sync a second device" explainer (UX audit §1.3) —
   *  the single most common real-world task had no first-class explanation. Names the
   *  three values to copy and how the fingerprint confirms they match. */
  private renderAddDeviceHelp(containerEl: HTMLElement): void {
    const help = containerEl.createEl('details', { cls: 'vault-sync-disclosure vault-sync-help' });
    help.createEl('summary', { text: 'Add another device' });

    const body = help.createDiv({ cls: 'setting-item-description' });
    body.createEl('p', {
      text: 'To sync a second device, install Vault Sync there and copy three values from this device:',
    });
    const steps = body.createEl('ol');
    steps.createEl('li', { text: 'Vault ID — use the exact same value.' });
    steps.createEl('li', { text: 'Vault passphrase — use the exact same passphrase.' });
    steps.createEl('li', {
      text: 'Access token — a token authorized for this vault, issued by your sync server ' +
        '(each device can use its own token).',
    });
    body.createEl('p', {
      text: 'Then press “Unlock & verify” on both devices and compare the Key fingerprint: it ' +
        'must be identical. If it differs, the passphrases don’t match and sync will refuse to ' +
        'mix the two — fix the passphrase before syncing. Finally press Test connection, then Sync.',
    });
  }

  /** Repaint the readiness checklist in place from current settings. Cheap — a
   *  handful of spans — and called on every keystroke into a required field. */
  private updateReadiness(): void {
    if (!this.readinessEl) return;
    const s = this.settings;
    this.readinessEl.empty();

    this.readinessEl.createSpan({ cls: 'vault-sync-readiness-label', text: 'Setup progress: ' });
    const fields: Array<[string, boolean]> = [
      ['Server URL', Boolean(s.serverUrl)],
      ['Vault ID', Boolean(s.vaultId)],
      ['Access token', Boolean(s.serverToken)],
      ['Passphrase', Boolean(s.vaultPassphrase)],
    ];
    fields.forEach(([label, ok], i) => {
      if (i > 0) this.readinessEl!.createSpan({ cls: 'vault-sync-readiness-sep', text: ' · ' });
      this.readinessEl!.createSpan({
        cls: `vault-sync-check ${ok ? 'is-ok' : 'is-missing'}`,
        text: `${ok ? '✓' : '✗'} ${label}`,
      });
    });

    const allSet = fields.every(([, ok]) => ok);
    this.readinessEl.createEl('div', {
      cls: 'setting-item-description',
      text: allSet
        ? 'All required fields are set — press Test connection, then Sync now.'
        : 'Fill the fields marked ✗ to finish setup. All four are required, in this order.',
    });
  }

  // ─── This device ────────────────────────────────────────────────────────────

  private renderDevice(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('This device').setHeading();

    new Setting(containerEl)
      .setName('Device name')
      .setDesc('A friendly name for this device.')
      .addText(t => {
        t.setValue(this.settings.deviceName)
          .setPlaceholder('My phone / laptop')
          .onChange(async v => {
            this.settings.deviceName = v;
            await this.save();
          });
      });

    // The Device ID is a raw UUID with no everyday use — tuck it behind a Diagnostics
    // disclosure so it doesn't clutter the basics (UX audit §4).
    const diag = containerEl.createEl('details', { cls: 'vault-sync-disclosure' });
    diag.createEl('summary', { text: 'Diagnostics' });
    new Setting(diag)
      .setName('Device ID')
      .setDesc('Unique identifier for this device (read-only).')
      .addText(t => {
        t.setValue(this.settings.deviceId).setDisabled(true);
      });
  }

  // ─── Sync (everyday controls) ───────────────────────────────────────────────

  private renderSync(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Sync').setHeading();

    new Setting(containerEl)
      .setName('View sync status')
      .setDesc('See the last sync, pending changes, and any skipped conflicts or files needing attention.')
      .addButton(btn => {
        btn.setButtonText('View status').onClick(() => this.host.openSyncStatus());
      });

    new Setting(containerEl)
      .setName('Sync now')
      .setDesc('Run a full sync against the server.')
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
  }

  // ─── Advanced (collapsed) ───────────────────────────────────────────────────

  private renderAdvanced(containerEl: HTMLElement): void {
    const details = containerEl.createEl('details', { cls: 'vault-sync-disclosure' });
    details.createEl('summary', { text: 'Advanced' });

    new Setting(details)
      .setName('Sync Obsidian config')
      .setDesc('Sync files inside .obsidian/ (snippets, templates). Workspace layout is always excluded.')
      .addToggle(t => {
        t.setValue(this.settings.syncObsidianConfig)
          .onChange(async v => {
            this.settings.syncObsidianConfig = v;
            await this.save();
          });
      });

    new Setting(details)
      .setName('Debounce delay')
      .setDesc('Wait this many milliseconds after a file stops changing before recording a change.')
      .addSlider(s => {
        s.setLimits(500, 5000, 100)
          .setValue(this.settings.debounceMs)
          .setDynamicTooltip()
          .onChange(async v => {
            this.settings.debounceMs = v;
            await this.save();
          });
      });

    new Setting(details)
      .setName('Original-version retention')
      .setDesc('Keep the original (pre-edit) version of a file for this many days, so three-way ' +
        'merges stay accurate. Older copies are cleaned up automatically.')
      .addSlider(s => {
        s.setLimits(7, 90, 1)
          .setValue(this.settings.ancestorRetentionDays)
          .setDynamicTooltip()
          .onChange(async v => {
            this.settings.ancestorRetentionDays = v;
            await this.save();
          });
      });

    details.createEl('p', {
      text: 'Excluded paths — files and folders to keep out of sync (glob patterns, one per line).',
      cls: 'setting-item-description',
    });
    new Setting(details)
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
  }

  // ─── Danger zone (collapsed) ────────────────────────────────────────────────

  private renderDangerZone(containerEl: HTMLElement): void {
    const details = containerEl.createEl('details', { cls: 'vault-sync-disclosure' });
    details.createEl('summary', { text: 'Maintenance & danger zone' });

    new Setting(details)
      .setName('Clear sync cache')
      .setDesc('Remove content-store blobs the registry no longer references. ' +
        'Safe — only affects three-way merge quality, not vault content.')
      .addButton(btn => {
        // No warning styling: its own description says it's safe (merge-quality only,
        // never vault content), so it shouldn't look as loud as the destructive
        // actions below it (UX audit §4).
        btn.setButtonText('Clear cache').onClick(async () => {
          btn.setDisabled(true);
          const removed = await this.host.clearContentCache();
          btn.setButtonText(`Removed ${removed}`);
          setTimeout(() => { btn.setButtonText('Clear cache').setDisabled(false); }, 2000);
        });
      });

    new Setting(details)
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

    new Setting(details)
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

    new Setting(details)
      .setName('Re-baseline this device to the server')
      .setDesc('Push every file on this device to the server as the authoritative version — ' +
        'use to rebuild or recover the server from a device you trust. If another device ' +
        'edited the same file, this device wins. Vault content here is never touched.')
      .addButton(btn => {
        // The single most dangerous action here (it can overwrite other devices'
        // edits), so it gets the loud, solid danger style — visibly distinct from the
        // non-destructive warning buttons above (UX audit §4). The double-confirm is
        // escalated in the plugin's rebaseline() handler.
        btn.setButtonText('Re-baseline').setWarning();
        btn.buttonEl.addClass('vault-sync-danger-btn');
        btn.onClick(async () => {
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
      ? `Key ready — fingerprint ${fp}. Compare it across devices: it must be identical. ` +
        'If it differs, the passphrases don’t match and sync will refuse to mix them.'
      : 'Not unlocked yet. Enter a passphrase and vault ID, then press Unlock & verify.';
  }
}
