import { Env } from "./env";
import { emailLogo } from "./email-logo";

export async function sendInvitation(env: Env, email: string, code: string): Promise<void> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [email], subject: "Your Mixing Pal invitation",
      text: `You're invited to the Mixing Pal closed beta. Download the app: https://mixingpal.com/beta/

Sign in with the email address that received this invitation. We'll email you a six-digit sign-in code. After signing in, enter this separate invitation code:

${code}

Your invitation code expires in seven days. Follow the setup steps in the app to connect Ableton Live. In Settings, turn on Receive pilot updates to get beta releases.`,
      attachments: [{ filename: "mixing-pal.png", content: emailLogo, content_type: "image/png", content_id: "mixing-pal-logo" }],
      html: `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Your Mixing Pal invitation</title></head>
<body style="margin:0;padding:0;background-color:#0d070b;color:#eee5ea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">Your invitation to the Mixing Pal closed beta is here.</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#0d070b;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:480px;background-color:#191116;">
        <tr><td style="padding:32px 24px;">
          <table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 32px;">
            <tr><td style="padding-right:12px;"><img src="cid:mixing-pal-logo" width="44" height="44" alt="" style="display:block;border:0;"></td>
              <td style="color:#eee5ea;font-family:Impact,'Arial Narrow',Arial,sans-serif;font-size:20px;font-weight:700;letter-spacing:1px;">MIXING PAL</td></tr>
          </table>
          <h1 style="margin:0 0 12px;color:#eee5ea;font-family:Impact,'Arial Narrow',Arial,sans-serif;font-size:28px;line-height:1.2;font-weight:700;text-transform:uppercase;">You're invited.</h1>
          <p style="margin:0 0 24px;color:#eee5ea;font-size:16px;line-height:1.5;">Welcome to the Mixing Pal closed beta. Download the app and open your Live set.</p>
          <p style="margin:0 0 24px;"><a href="https://mixingpal.com/beta/" style="display:inline-block;padding:16px 24px;background-color:#83f700;color:#0d070b;font-size:16px;font-weight:700;text-decoration:none;">Download Mixing Pal</a></p>
          <p style="margin:0 0 16px;color:#eee5ea;font-size:16px;line-height:1.5;">Sign in with the email address that received this invitation. We'll email you a six-digit sign-in code. After signing in, enter this separate invitation code:</p>
          <p style="margin:0 0 16px;padding:16px;background-color:#0d070b;color:#eee5ea;font-family:'Courier New',monospace;font-size:14px;line-height:1.5;word-break:break-all;">${code}</p>
          <p style="margin:0 0 24px;color:#eee5ea;font-size:14px;line-height:1.5;">Your invitation code expires in seven days.</p>
          <p style="margin:0;color:#ab9da5;font-size:14px;line-height:1.5;">Follow the setup steps in the app to connect Ableton Live. In Settings, turn on “Receive pilot updates” to get beta releases.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>` }),
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error("Invitation email was not accepted");
}
