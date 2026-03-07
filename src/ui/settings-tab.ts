// ─────────────────────────────────────────────
//  Settings Tab
//  Phase 4.4
// ─────────────────────────────────────────────

import { App, PluginSettingTab, Setting, ButtonComponent } from 'obsidian';
import { SyncSettings, PairedDevice } from '../types';
import { PairingModal } from './pairing-modal';

export class SyncSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: { settings: SyncSettings; saveSettings: () => Promise<void> },
  ) {
    super(app, plugin as any);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('vault-sync-settings');

    containerEl.createEl('h2', { text: 'Vault Sync' });

    // ── Device identity ───────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'This Device' });

    new Setting(containerEl)
      .setName('Device Name')
      .setDesc('A friendly name for this device (shown to paired devices).')
      .addText(t => {
        t.setValue(this.plugin.settings.deviceName)
          .setPlaceholder('My MacBook')
          .onChange(async v => {
            this.plugin.settings.deviceName = v;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Device ID')
      .setDesc('Unique identifier for this device (read-only).')
      .addText(t => {
        t.setValue(this.plugin.settings.deviceId).setDisabled(true);
      });

    // ── Paired devices ────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Paired Devices' });

    if (this.plugin.settings.pairedDevices.length === 0) {
      containerEl.createEl('p', {
        text: 'No devices paired yet. Add a device to start syncing.',
        cls: 'settings-empty-state',
      });
    }

    for (const device of this.plugin.settings.pairedDevices) {
      this.renderPairedDevice(containerEl, device);
    }

    new Setting(containerEl)
      .addButton(btn => {
        btn.setButtonText('+ Pair New Device')
          .setClass('mod-cta')
          .onClick(() => {
            new PairingModal(this.app, this.plugin.settings, async (device) => {
              this.plugin.settings.pairedDevices.push(device);
              await this.plugin.saveSettings();
              this.display();
            }).open();
          });
      });

    // ── Sync behavior ─────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Sync Behavior' });

    new Setting(containerEl)
      .setName('Debounce Delay')
      .setDesc('Wait this many milliseconds after a file stops changing before recording an operation.')
      .addSlider(s => {
        s.setLimits(500, 5000, 100)
          .setValue(this.plugin.settings.debounceMs)
          .setDynamicTooltip()
          .onChange(async v => {
            this.plugin.settings.debounceMs = v;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Delete Conflict Strategy')
      .setDesc('What to do when one device deletes a file and the other modifies it.')
      .addDropdown(d => {
        d.addOption('ask', 'Ask me each time')
          .addOption('keep_deleted', 'Always keep the deletion')
          .addOption('keep_modified', 'Always keep the modified version')
          .setValue(this.plugin.settings.deleteConflictStrategy)
          .onChange(async v => {
            this.plugin.settings.deleteConflictStrategy = v as any;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Sync Obsidian Config')
      .setDesc('Sync files inside .obsidian/ (snippets, templates). Workspace layout is always excluded.')
      .addToggle(t => {
        t.setValue(this.plugin.settings.syncObsidianConfig)
          .onChange(async v => {
            this.plugin.settings.syncObsidianConfig = v;
            await this.plugin.saveSettings();
          });
      });

    // ── Exclusions ────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Excluded Paths' });
    containerEl.createEl('p', {
      text: 'Files and folders to exclude from sync (glob patterns, one per line).',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .addTextArea(ta => {
        ta.setValue(this.plugin.settings.excludedPatterns.join('\n'))
          .setPlaceholder('.obsidian/workspace.json\n.vault-sync/**')
          .onChange(async v => {
            this.plugin.settings.excludedPatterns = v.split('\n').map(s => s.trim()).filter(Boolean);
            await this.plugin.saveSettings();
          });
        ta.inputEl.rows = 5;
        ta.inputEl.style.width = '100%';
        ta.inputEl.style.fontFamily = 'var(--font-monospace)';
        ta.inputEl.style.fontSize = '0.85rem';
      });

    // ── Network ───────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Network' });

    new Setting(containerEl)
      .setName('Sync Port')
      .setDesc('Port this device listens on when acting as server. The other device must be able to reach this port on your local network.')
      .addText(t => {
        t.setValue(String(this.plugin.settings.syncPort))
          .setPlaceholder('47821')
          .onChange(async v => {
            const n = parseInt(v, 10);
            if (n > 1024 && n < 65536) {
              this.plugin.settings.syncPort = n;
              await this.plugin.saveSettings();
            }
          });
      });

    // ── Storage ───────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Storage' });

    new Setting(containerEl)
      .setName('Ancestor Retention')
      .setDesc('Keep ancestor content for this many days before garbage collection.')
      .addSlider(s => {
        s.setLimits(7, 90, 1)
          .setValue(this.plugin.settings.ancestorRetentionDays)
          .setDynamicTooltip()
          .onChange(async v => {
            this.plugin.settings.ancestorRetentionDays = v;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Clear Sync Cache')
      .setDesc('Remove ancestor content cache. Safe to do — only affects three-way merge quality, not vault content.')
      .addButton(btn => {
        btn.setButtonText('Clear Cache').setWarning().onClick(async () => {
          // Would call contentStore.gc(new Set()) in real impl
          btn.setButtonText('Cleared!').setDisabled(true);
          setTimeout(() => { btn.setButtonText('Clear Cache').setDisabled(false); }, 2000);
        });
      });

    new Setting(containerEl)
      .setName('Reset Sync State')
      .setDesc('Rebuild file registry from scratch. Use if sync metadata is corrupted. Vault content is never touched.')
      .addButton(btn => {
        btn.setButtonText('Reset').setWarning().onClick(async () => {
          // Would call registry.reconcileWithVault() and clear oplog
          btn.setButtonText('Done').setDisabled(true);
          setTimeout(() => { btn.setButtonText('Reset').setDisabled(false); }, 2000);
        });
      });

    this.injectStyles();
  }

  private renderPairedDevice(container: HTMLElement, device: PairedDevice): void {
    const lastSync = device.lastSyncTime
      ? new Date(device.lastSyncTime).toLocaleString()
      : 'Never';

    new Setting(container)
      .setName(device.deviceName)
      .setDesc(`ID: ${device.deviceId.slice(0, 12)}… | Last sync: ${lastSync}`)
      .addButton(btn => {
        btn.setButtonText('Unpair').setWarning().onClick(async () => {
          this.plugin.settings.pairedDevices = this.plugin.settings.pairedDevices
            .filter(d => d.deviceId !== device.deviceId);
          await this.plugin.saveSettings();
          this.display();
        });
      });
  }

  private injectStyles() {
    const existing = document.getElementById('vault-sync-settings-styles');
    if (existing) return;

    const style = document.createElement('style');
    style.id = 'vault-sync-settings-styles';
    style.textContent = `
      .vault-sync-settings .settings-empty-state { color: var(--text-muted); font-style: italic; margin: 0.5rem 0 1rem; }
      .vault-sync-settings h3 { margin: 1.5rem 0 0.75rem; color: var(--text-normal); border-bottom: 1px solid var(--background-modifier-border); padding-bottom: 0.25rem; }
    `;
    document.head.appendChild(style);
  }
}
