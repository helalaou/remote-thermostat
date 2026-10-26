import { readConfig } from './config.ts';
import { Store } from './store.ts';

const config = readConfig();
const store = new Store(config.dataDir);
try {
  const [command, argument, ...options] = process.argv.slice(2);
  if (command === 'create-owner' || command === 'create-neighbor') {
    const role = command === 'create-owner' ? 'owner' : 'neighbor';
    const daysIndex = options.indexOf('--days');
    const days = daysIndex >= 0 ? Number(options[daysIndex + 1]) : 30;
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('--days must be 1–365.');
    const created = store.createKey(
      role,
      argument || (role === 'owner' ? 'Owner' : 'Neighbor'),
      role === 'neighbor' ? Date.now() + days * 86_400_000 : null,
    );
    console.log(
      `Created ${role} access: ${created.label}\nID: ${created.id}\nAccess key (shown once): ${created.token}\nPaste into the app login form. Never put it in a URL or commit it.\n${created.expiresAt ? `Expires: ${new Date(created.expiresAt).toISOString()}` : 'No expiry; revoke locally if exposed.'}`,
    );
  } else if (command === 'list') {
    console.table(store.listKeys());
  } else if (command === 'revoke' && argument) {
    store.revokeKey(argument);
    console.log('Access key and all its sessions revoked.');
  } else {
    throw new Error(
      'Usage: npm run admin -- create-owner | create-neighbor "Label" [--days 30] | list | revoke <id>',
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Admin action failed.');
  process.exitCode = 1;
} finally {
  store.close();
}
