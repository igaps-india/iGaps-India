import { Resend } from 'resend';
import { config } from '../config';

let _resend: Resend | null = null;

function getResend(): Resend {
  if (!_resend) {
    _resend = new Resend(config.email.resendApiKey);
  }
  return _resend;
}

export async function sendMagicLink(opts: {
  to: string;
  founderName: string;
  applicationId: string;
  token: string;
}): Promise<void> {
  const link = `${config.frontendUrl}/q/closed?app=${opts.applicationId}&token=${opts.token}`;

  const hasRealResendKey =
    config.email.resendApiKey &&
    !config.email.resendApiKey.includes('xxxx') &&
    config.email.resendApiKey !== 're_xxxxxxxxxxxxxxxxxxxx';

  if (config.nodeEnv === 'development' && !hasRealResendKey) {
    console.info(`[Email DEV] Magic link for ${opts.to}: ${link}`);
    return;
  }

  await getResend().emails.send({
    from: config.email.from,
    to: opts.to,
    subject: `${config.appName} — Continue your application`,
    html: `
      <div style="font-family: sans-serif; max-width: 560px; margin: 0 auto;">
        <h2 style="color: #1a1a2e;">Continue your iGaps application</h2>
        <p>Hello ${opts.founderName},</p>
        <p>Thank you for applying. Please click the button below to continue to the questionnaire.</p>
        <p>
          <a href="${link}" style="display:inline-block;padding:12px 24px;background:#4f46e5;color:white;text-decoration:none;border-radius:6px;font-weight:600;">
            Continue Application
          </a>
        </p>
        <p style="color:#6b7280;font-size:13px;">This link expires in 14 days. If you did not apply, you can safely ignore this email.</p>
        <p style="color:#6b7280;font-size:13px;">Or copy and paste this URL: ${link}</p>
      </div>
    `,
  });
}
