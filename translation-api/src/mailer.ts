import nodemailer, { Transporter } from "nodemailer";

const GMAIL_USER = process.env.GMAIL_USER || "";
const GMAIL_APP_PASSWORD = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM_EMAIL =
  process.env.RESEND_FROM_EMAIL || "UgaJapa Connect <onboarding@resend.dev>";

type Provider = "gmail" | "resend" | "none";

function activeProvider(): Provider {
  if (GMAIL_USER && GMAIL_APP_PASSWORD) return "gmail";
  if (RESEND_API_KEY) return "resend";
  return "none";
}

export function isEmailConfigured(): boolean {
  return activeProvider() !== "none";
}

let gmailTransport: Transporter | null = null;
function getGmailTransport(): Transporter {
  if (!gmailTransport) {
    gmailTransport = nodemailer.createTransport({
      service: "gmail",
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
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
 * GMAIL_USER/GMAIL_APP_PASSWORD are set), then Resend (if RESEND_API_KEY is
 * set). In non-production environments with neither configured, falls back
 * to logging the code to the console — useful for local development. In
 * production, a missing provider is a hard error: silently "succeeding"
 * without actually notifying the real inbox owner would defeat the point
 * of verification.
 */
export async function sendVerificationEmail(
  to: string,
  code: string
): Promise<void> {
  const provider = activeProvider();

  if (provider === "gmail") {
    await sendViaGmail(to, code);
    return;
  }

  if (provider === "resend") {
    await sendViaResend(to, code);
    return;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "No email provider configured (GMAIL_USER/GMAIL_APP_PASSWORD or RESEND_API_KEY) — cannot send verification emails"
    );
  }
  console.log(`[dev] Verification code for ${to}: ${code}`);
}
