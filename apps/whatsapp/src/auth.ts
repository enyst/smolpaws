/**
 * WhatsApp device linking for the standalone bridge.
 *
 *   npm --prefix apps/whatsapp run auth                 # QR code in the terminal
 *   npm --prefix apps/whatsapp run auth -- --phone +15551234567
 *                                                       # 8-character pairing code instead of a QR
 *
 * Credentials are saved under ~/.smolpaws/whatsapp/auth (SMOLPAWS_HOME_DIR overrides the home). The
 * bridge itself never pairs inline: when WhatsApp asks for a new link it exits and asks you to run this.
 */
import { mkdirSync } from 'node:fs';

import makeWASocket, {
  DisconnectReason,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

import { resolveWhatsAppVersion } from '../../../src/whatsapp-version.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const HOME_DIR = process.env.HOME || '';
const formatHomePath = (p: string) => (HOME_DIR && p.startsWith(HOME_DIR) ? `~${p.slice(HOME_DIR.length)}` : p);
const logger = pino({ level: 'warn' });

function phoneArgument(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--phone');
  const raw = index >= 0 ? argv[index + 1] : undefined;
  if (!raw) return undefined;
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length < 8) throw new Error(`--phone must be a full international number, got ${raw}`);
  return digits;
}

async function authenticate(): Promise<void> {
  mkdirSync(config.authDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
  let completed = false;
  let pairingRequested = false;
  const phone = phoneArgument(process.argv.slice(2));

  if (state.creds.registered) {
    console.log('✓ Already authenticated with WhatsApp');
    console.log(`  To re-link, delete ${formatHomePath(config.authDir)}/ and run again.`);
    process.exit(0);
  }

  console.log('Starting WhatsApp authentication...\n');
  const { version } = await resolveWhatsAppVersion();
  const sock = makeWASocket({
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    printQRInTerminal: false,
    logger,
    browser: ['SmolPaws', 'Chrome', '1.0.0'],
    version,
  });

  const finish = (): void => {
    if (completed) return;
    completed = true;
    console.log('\n✓ Successfully authenticated with WhatsApp!');
    console.log(`  Credentials saved to ${formatHomePath(config.authDir)}/`);
    console.log('  Start the bridge with: scripts/run-local-bridge.sh whatsapp\n');
    setTimeout(() => process.exit(0), 1_000);
  };

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && phone && !pairingRequested) {
      pairingRequested = true;
      void sock.requestPairingCode(phone).then((code) => {
        console.log('Pairing code (enter it on your phone):\n');
        console.log(`  ${code.match(/.{1,4}/g)?.join('-') ?? code}\n`);
        console.log('  1. Open WhatsApp on your phone');
        console.log('  2. Tap Settings → Linked Devices → Link a Device');
        console.log('  3. Choose "Link with phone number instead" and type the code above\n');
      }).catch((error: unknown) => {
        console.error('Failed to request a pairing code:', error instanceof Error ? error.message : String(error));
        process.exit(1);
      });
      return;
    }

    if (qr && !phone) {
      console.log('Scan this QR code with WhatsApp:\n');
      console.log('  1. Open WhatsApp on your phone');
      console.log('  2. Tap Settings → Linked Devices → Link a Device');
      console.log('  3. Point your camera at the QR code below\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const reason = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      if (reason === DisconnectReason.loggedOut) {
        console.log(`\n✗ Logged out. Delete ${formatHomePath(config.authDir)}/ and try again.`);
        process.exit(1);
      } else if (reason === DisconnectReason.restartRequired) {
        console.log('\n↻ WhatsApp requested a reconnect to finish linking. Reconnecting...');
        setTimeout(() => {
          void authenticate();
        }, 500);
      } else if (!completed) {
        console.log('\n✗ Connection failed. Please try again.');
        process.exit(1);
      }
    }

    if (connection === 'open') {
      if (state.creds.registered) finish();
      else console.log('\nConnected to WhatsApp, waiting for registration to finish...');
    }
  });

  sock.ev.on('creds.update', () => {
    void saveCreds();
    if (state.creds.registered) finish();
  });
}

authenticate().catch((error: unknown) => {
  console.error('Authentication failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
