import { sendMagicLink } from '../src/utils/email';

async function main() {
  const to = process.argv[2] ?? 'akash@igaps.ai';
  console.info(`Sending test magic link to ${to}...`);

  try {
    await sendMagicLink({
      to,
      founderName: 'Test Founder',
      applicationId: 'test-app-id',
      token: 'test-token',
    });
    console.info('Done — check Resend dashboard and inbox.');
  } catch (err) {
    console.error('FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
