/** A rendered email: subject + plain text + HTML (spec 13 §3.1). */
export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Every variable goes through this before it reaches HTML. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

const FOOTER_TEXT = "If you didn't request this, you can ignore this email.";

/** Plain-text body: paragraphs separated by blank lines. */
export function textBody(paragraphs: readonly string[]): string {
  return [...paragraphs, FOOTER_TEXT, '— Nile'].join('\n\n');
}

/** Minimal, inline-styled HTML (email clients ignore <style> blocks). Paragraphs must be escaped already. */
export function htmlBody(title: string, paragraphsHtml: readonly string[]): string {
  const body = paragraphsHtml.map((p) => `<p style="margin:0 0 16px">${p}</p>`).join('\n');
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#1a1a1a;background:#ffffff;margin:0;padding:24px">
<div style="max-width:560px;margin:0 auto">
${body}
<p style="margin:24px 0 0;font-size:13px;color:#666666">${escapeHtml(FOOTER_TEXT)}<br>— Nile</p>
</div>
</body>
</html>`;
}

/** The OTP, large and spaced so it is easy to read and copy. */
export function codeHtml(code: string): string {
  return `<strong style="font-size:28px;letter-spacing:6px">${escapeHtml(code)}</strong>`;
}
