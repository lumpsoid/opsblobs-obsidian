// ─────────────────────────────────────────────
//  Pairing Flow Modal
//  Phase 4.2
// ─────────────────────────────────────────────

import { App, Modal, ButtonComponent, TextComponent, Setting } from 'obsidian';
import { PairedDevice, SyncSettings } from '../types';
import { Encryption, generatePairingCode, generateSalt, base64ToBytes, bytesToBase64 } from '../network/encryption';

type PairingStep = 'choose' | 'show_code' | 'enter_code' | 'confirming' | 'done' | 'error';

export class PairingModal extends Modal {
  private step: PairingStep = 'choose';
  private pairingCode = '';
  private salt: Uint8Array;
  private derivedKeyBase64 = '';
  private errorMessage = '';

  constructor(
    app: App,
    private settings: SyncSettings,
    private onPaired: (device: PairedDevice) => Promise<void>,
  ) {
    super(app);
    this.salt = generateSalt();
  }

  onOpen() {
    this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('vault-sync-pairing-modal');

    switch (this.step) {
      case 'choose': this.renderChoose(); break;
      case 'show_code': this.renderShowCode(); break;
      case 'enter_code': this.renderEnterCode(); break;
      case 'confirming': this.renderConfirming(); break;
      case 'done': this.renderDone(); break;
      case 'error': this.renderError(); break;
    }

    this.injectStyles();
  }

  private renderChoose() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: '🔗 Pair a New Device' });
    contentEl.createEl('p', {
      text: 'Choose how to pair. One device shows a code, the other enters it.',
      cls: 'pairing-subtitle',
    });

    const options = contentEl.createDiv('pairing-options');

    const showCard = options.createDiv('pairing-card');
    showCard.createEl('div', { text: '📱', cls: 'card-icon' });
    showCard.createEl('h3', { text: 'Show Code' });
    showCard.createEl('p', { text: 'Display a pairing code for the other device to enter.' });
    new ButtonComponent(showCard)
      .setButtonText('Generate Code')
      .setClass('mod-cta')
      .onClick(async () => {
        this.pairingCode = generatePairingCode();
        this.derivedKeyBase64 = await Encryption.deriveKey(this.pairingCode, this.salt);
        this.step = 'show_code';
        this.render();
      });

    const enterCard = options.createDiv('pairing-card');
    enterCard.createEl('div', { text: '⌨️', cls: 'card-icon' });
    enterCard.createEl('h3', { text: 'Enter Code' });
    enterCard.createEl('p', { text: 'Enter the code shown on the other device.' });
    new ButtonComponent(enterCard)
      .setButtonText('Enter Code')
      .onClick(() => {
        this.step = 'enter_code';
        this.render();
      });
  }

  private renderShowCode() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: '📱 Show This Code' });

    const codeDisplay = contentEl.createDiv('pairing-code-display');
    // Display code with spaces for readability: "123 456"
    const formatted = this.pairingCode.slice(0, 3) + ' ' + this.pairingCode.slice(3);
    codeDisplay.createEl('div', { text: formatted, cls: 'code-digits' });
    codeDisplay.createEl('p', { text: 'Enter this code on the other device', cls: 'code-hint' });

    // QR code placeholder (would use a QR library in production)
    const qrContainer = contentEl.createDiv('qr-placeholder');
    qrContainer.createEl('div', {
      text: `IP: ${this.getLocalIP()} | Port: shown in sync panel | Code: ${this.pairingCode}`,
      cls: 'qr-text',
    });

    const saltDisplay = contentEl.createDiv('pairing-salt');
    saltDisplay.createEl('small', {
      text: `Salt: ${bytesToBase64(this.salt).slice(0, 16)}...`,
      cls: 'salt-hint',
    });

    contentEl.createEl('p', {
      text: 'Once the other device has entered the code, confirm pairing below.',
      cls: 'pairing-waiting',
    });

    // Name input for the remote device
    let remoteName = '';
    new Setting(contentEl)
      .setName('Other Device Name')
      .setDesc('A friendly name for the device that will enter the code')
      .addText(t => {
        t.setPlaceholder('My Laptop');
        t.onChange(v => { remoteName = v.trim(); });
      });

    const footer = contentEl.createDiv('pairing-footer');
    new ButtonComponent(footer)
      .setButtonText('Confirm Pairing ✓')
      .setClass('mod-cta')
      .onClick(async () => {
        // This device acts as server: no lastKnownIp/lastKnownPort so main.ts
        // will put it into server (listener) mode when syncing.
        const device: PairedDevice = {
          deviceId: `pending-${Date.now()}`,
          deviceName: remoteName || 'Remote Device',
          encryptionKeyBase64: this.derivedKeyBase64,
          lastSyncHlc: null,
          lastSyncTime: null,
          // Intentionally no lastKnownIp / lastKnownPort — this device listens.
        };
        await this.onPaired(device);
        this.step = 'done';
        this.render();
      });

    new ButtonComponent(footer)
      .setButtonText('← Back')
      .onClick(() => { this.step = 'choose'; this.render(); });
  }

  private renderEnterCode() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: '⌨️ Enter the Code' });
    contentEl.createEl('p', {
      text: 'Enter the 6-digit code shown on the other device.',
      cls: 'pairing-subtitle',
    });

    let code = '';
    let ip = '';
    let saltBase64 = '';

    new Setting(contentEl)
      .setName('Pairing Code')
      .setDesc('6-digit code from the other device')
      .addText(t => {
        t.setPlaceholder('123456');
        t.inputEl.maxLength = 6;
        t.inputEl.inputMode = 'numeric';
        t.onChange(v => { code = v.replace(/\s/g, ''); });
      });

    new Setting(contentEl)
      .setName('Other Device IP')
      .setDesc('Local network IP (e.g. 192.168.1.42)')
      .addText(t => {
        t.setPlaceholder('192.168.1.42');
        t.onChange(v => { ip = v; });
      });

    new Setting(contentEl)
      .setName('Salt (from other device)')
      .setDesc('Base64 salt shown on other device')
      .addText(t => {
        t.setPlaceholder('base64 salt...');
        t.onChange(v => { saltBase64 = v; });
      });

    const footer = contentEl.createDiv('pairing-footer');
    new ButtonComponent(footer)
      .setButtonText('Pair Device')
      .setClass('mod-cta')
      .onClick(async () => {
        if (code.length !== 6) {
          this.errorMessage = 'Please enter a 6-digit code.';
          this.step = 'error';
          this.render();
          return;
        }
        try {
          const salt = saltBase64 ? base64ToBytes(saltBase64) : this.salt;
          this.derivedKeyBase64 = await Encryption.deriveKey(code, salt);
          // In a real implementation, we'd do a challenge-response here to verify
          // the key matches before saving
          const device: PairedDevice = {
            deviceId: `device-${Date.now()}`,
            deviceName: ip || 'Remote Device',
            encryptionKeyBase64: this.derivedKeyBase64,
            lastSyncHlc: null,
            lastSyncTime: null,
          };
          await this.onPaired(device);
          this.step = 'done';
          this.render();
        } catch (e) {
          this.errorMessage = `Pairing failed: ${(e as Error).message}`;
          this.step = 'error';
          this.render();
        }
      });

    new ButtonComponent(footer)
      .setButtonText('← Back')
      .onClick(() => { this.step = 'choose'; this.render(); });
  }

  private renderConfirming() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: '🔄 Confirming...' });
    contentEl.createEl('p', { text: 'Verifying pairing with the other device.' });
  }

  private renderDone() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: '✅ Paired!' });
    contentEl.createEl('p', { text: 'Devices are now paired and ready to sync.' });
    new ButtonComponent(contentEl)
      .setButtonText('Done')
      .setClass('mod-cta')
      .onClick(() => this.close());
  }

  private renderError() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: '❌ Error' });
    contentEl.createEl('p', { text: this.errorMessage, cls: 'pairing-error' });
    new ButtonComponent(contentEl)
      .setButtonText('← Try Again')
      .onClick(() => { this.step = 'choose'; this.render(); });
  }

  private getLocalIP(): string {
    // In a real implementation, enumerate network interfaces
    return '(check network settings)';
  }

  private injectStyles() {
    const existing = document.getElementById('vault-sync-pairing-styles');
    if (existing) return;

    const style = document.createElement('style');
    style.id = 'vault-sync-pairing-styles';
    style.textContent = `
      .vault-sync-pairing-modal .modal-content { padding: 1.5rem; max-width: 520px; }
      .vault-sync-pairing-modal h2 { margin: 0 0 0.5rem; }
      .pairing-subtitle { color: var(--text-muted); margin: 0 0 1.5rem; }
      .pairing-options { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin: 1rem 0; }
      .pairing-card { border: 1px solid var(--background-modifier-border); border-radius: 8px; padding: 1rem; text-align: center; }
      .pairing-card h3 { margin: 0.5rem 0 0.25rem; font-size: 1rem; }
      .pairing-card p { color: var(--text-muted); font-size: 0.85rem; margin: 0 0 0.75rem; }
      .card-icon { font-size: 2rem; }
      .pairing-code-display { text-align: center; padding: 1.5rem; background: var(--background-secondary); border-radius: 8px; margin: 1rem 0; }
      .code-digits { font-size: 2.5rem; font-weight: 700; letter-spacing: 0.15em; font-family: var(--font-monospace); }
      .code-hint { color: var(--text-muted); font-size: 0.85rem; margin: 0.5rem 0 0; }
      .qr-placeholder { background: var(--background-modifier-border); padding: 1rem; border-radius: 6px; margin: 0.75rem 0; text-align: center; }
      .qr-text { font-family: var(--font-monospace); font-size: 0.75rem; word-break: break-all; }
      .salt-hint { color: var(--text-faint); font-size: 0.7rem; }
      .pairing-waiting { text-align: center; color: var(--text-muted); }
      .pairing-error { color: var(--color-red); }
      .pairing-footer { display: flex; gap: 0.75rem; margin-top: 1rem; justify-content: flex-end; }
    `;
    document.head.appendChild(style);
  }
}
