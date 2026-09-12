import { betterAuth } from "better-auth";
import { bearer, emailOTP } from "better-auth/plugins";
import { ApiError, Env } from "./env";

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
            text: `Your Mixing Pal sign-in code is ${otp}. It expires in five minutes. If you did not request it, ignore this email.` }),
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
  if (!session?.user.emailVerified) {
    throw new ApiError(401, "sign_in_required", "Your session has ended. Sign in again.");
  }
  return session.user.id;
}
