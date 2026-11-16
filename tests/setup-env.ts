// Tests never use the shell's payment, mail or Tailscale settings: a developer's real keys must not turn a test app live.
for (const k of Object.keys(process.env)) {
  if (/^(STRIPE_|SMTP_)/.test(k) || k === 'EMAIL_TRANSPORT' || k === 'JT_PUBLIC_URL' || k.startsWith('JT_TAILSCALE_')) delete process.env[k];
}
