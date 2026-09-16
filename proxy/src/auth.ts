import { betterAuth } from "better-auth";
import { bearer, emailOTP } from "better-auth/plugins";
import { ApiError, Env } from "./env";
import { emailLogo } from "./email-logo";

export function auth(env: Env) {
  return betterAuth({
    appName: "Mixing Pal",
    baseURL: env.API_ORIGIN,
    basePath: "/auth",
    secret: env.AUTH_SECRET,
    database: env.DB,
    telemetry: { enabled: false },
    logger: { disabled: true },
    session: { expiresIn: 30 * 24 * 60 * 60, updateAge: 24 * 60 * 60,
      cookieCache: { enabled: false } },
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"], disableIpTracking: true } },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 20 },
    plugins: [bearer({ requireSignature: true }), emailOTP({
      storeOTP: "hashed",
      allowedAttempts: 3,
      expiresIn: 300,
      rateLimit: { window: 60, max: 3 },
      async sendVerificationOTP({ email, otp, type }) {
        if (type !== "sign-in") throw new Error("Unsupported email action");
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${env.RESEND_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: env.MAIL_FROM, to: [email], subject: "Your Mixing Pal sign-in code",
            text: `Your Mixing Pal sign-in code is ${otp}. It expires in five minutes. If you did not request it, ignore this email.`,
            attachments: [{ filename: "mixing-pal.png", content: emailLogo, content_type: "image/png", content_id: "mixing-pal-logo" }],
            html: `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Your Mixing Pal sign-in code</title></head>
<body style="margin:0;padding:0;background-color:#0d070b;color:#eee5ea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">Your sign-in code expires in five minutes.</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#0d070b;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:480px;background-color:#191116;">
        <tr><td style="padding:32px 24px;">
          <table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 32px;">
            <tr><td style="padding-right:12px;"><img src="cid:mixing-pal-logo" width="44" height="44" alt="" style="display:block;border:0;"></td>
              <td style="color:#eee5ea;font-family:Impact,'Arial Narrow',Arial,sans-serif;font-size:20px;font-weight:700;letter-spacing:1px;">MIXING PAL</td></tr>
          </table>
          <h1 style="margin:0 0 12px;color:#eee5ea;font-family:Impact,'Arial Narrow',Arial,sans-serif;font-size:28px;line-height:1.2;font-weight:700;text-transform:uppercase;">Back to your session.</h1>
          <p style="margin:0 0 24px;color:#eee5ea;font-size:16px;line-height:1.5;">Enter this code in Mixing Pal to sign in.</p>
          <p style="margin:0 0 16px;padding:20px 12px;background-color:#83f700;text-align:center;font-family:'Courier New',monospace;font-size:36px;font-weight:700;letter-spacing:6px;line-height:1.25;color:#0d070b;">${otp}</p>
          <p style="margin:0 0 32px;color:#eee5ea;font-size:14px;line-height:1.5;">This code expires in five minutes.</p>
          <p style="margin:0;color:#ab9da5;font-size:14px;line-height:1.5;">If you didn’t request this code, you can ignore this email.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>` }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error("Could not send sign-in code");
        await response.body?.cancel();
      },
    })],
  });
}

export async function authenticate(request: Request, env: Env): Promise<string> {
  if (!request.headers.get("Authorization")?.startsWith("Bearer ")) {
    throw new ApiError(401, "sign_in_required", "Sign in to Mixing Pal to continue.");
  }
  const session = await auth(env).api.getSession({ headers: request.headers });
  if (!session?.user.emailVerified || await env.DB.prepare("SELECT 1 FROM deletion_jobs WHERE member_id = ? AND completed_at IS NULL")
    .bind(session.user.id).first()) {
    throw new ApiError(401, "sign_in_required", "Your session has ended. Sign in again.");
  }
  return session.user.id;
}
