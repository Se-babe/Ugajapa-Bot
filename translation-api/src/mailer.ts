import nodemailer, { Transporter } from "nodemailer";

const GMAIL_USER = process.env.GMAIL_USER || "";
const GMAIL_APP_PASSWORD = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM_EMAIL =
  process.env.RESEND_FROM_EMAIL || "UgaJapa Connect <onboarding@resend.dev>";

const gmailAvailable = Boolean(GMAIL_USER && GMAIL_APP_PASSWORD);
const resendAvailable = Boolean(RESEND_API_KEY);

export function isEmailConfigured(): boolean {
  return gmailAvailable || resendAvailable;
}

let gmailTransport: Transporter | null = null;
function getGmailTransport(): Transporter {
  if (!gmailTransport) {
    gmailTransport = nodemailer.createTransport({
      service: "gmail",
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
      // Some PaaS hosts (e.g. Render) block outbound SMTP entirely for
      // anti-abuse reasons — without these, a blocked connection hangs the
      // request indefinitely instead of failing fast so we can fall back.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
    });
  }
  return gmailTransport;
}

function verificationEmailHtml(code: string): string {
  return (
    `<div style="font-family:sans-serif;max-width:420px;margin:0 auto;">` +
    `<h2 style="color:#1e3a5f;">Verify your email</h2>` +
    `<p>Use this code to finish creating your UgaJapa Connect account:</p>` +
    `<p style="font-size:32px;font-weight:700;letter-spacing:6px;color:#1e3a5f;">${code}</p>` +
    `<p style="color:#6b7785;font-size:13px;">This code expires in 15 minutes. If you didn't request this, you can ignore this email.</p>` +
    `</div>`
  );
}

async function sendViaGmail(to: string, code: string): Promise<void> {
  await getGmailTransport().sendMail({
    from: `UgaJapa Connect <${GMAIL_USER}>`,
    to,
    subject: "Your UgaJapa Connect verification code",
    html: verificationEmailHtml(code),
  });
}

async function sendViaResend(to: string, code: string): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to,
      subject: "Your UgaJapa Connect verification code",
      html: verificationEmailHtml(code),
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
}

/**
 * Sends the verification code by email. Tries Gmail SMTP first (if
 * configured), and falls through to Resend (if configured) if Gmail fails
 * or times out — some hosts block outbound SMTP entirely, so a working
 * fallback matters, not just a priority order. In non-production
 * environments with neither configured, falls back to logging the code to
 * the console. In production, if every configured provider fails, that's a
 * hard error: silently "succeeding" without actually notifying the real
 * inbox owner would defeat the point of verification.
 */
export async function sendVerificationEmail(
  to: string,
  code: string
): Promise<void> {
  const errors: string[] = [];

  if (gmailAvailable) {
    try {
      await sendViaGmail(to, code);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[mailer] Gmail SMTP failed, trying next provider: ${msg}`);
      errors.push(`gmail: ${msg}`);
    }
  }

  if (resendAvailable) {
    try {
      await sendViaResend(to, code);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[mailer] Resend failed: ${msg}`);
      errors.push(`resend: ${msg}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`All configured email providers failed — ${errors.join("; ")}`);
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "No email provider configured (GMAIL_USER/GMAIL_APP_PASSWORD or RESEND_API_KEY) — cannot send verification emails"
    );
  }
  console.log(`[dev] Verification code for ${to}: ${code}`);
}
