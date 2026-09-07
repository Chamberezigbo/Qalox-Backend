/**
 * Wraps email body content in a branded card: the school's own color as a
 * header band, their logo, a light gray page background around a centered
 * white card, and a small "Sent by X via Qalox" footer.
 *
 * Table layout + inline styles throughout, not flexbox/grid or a <style>
 * block — most email clients (Outlook especially) strip <style> tags and
 * don't reliably support modern CSS layout, but table-based HTML with
 * inline styles renders consistently everywhere.
 */

/** The colored band at the top — this is most of what makes an email feel branded rather than generic. */
function headerBand({ schoolName, logoUrl, color }) {
  return `
    <tr><td style="background:${color};padding:24px 28px;text-align:center;">
      ${
        logoUrl
          ? `<img src="${logoUrl}" alt="${schoolName}" width="56" height="56" style="border-radius:8px;display:block;margin:0 auto 8px;">`
          : ""
      }
      <p style="margin:0;color:#ffffff;font-size:16px;font-weight:bold;">${schoolName}</p>
    </td></tr>`;
}

/** Whatever the specific email needs to say — a receipt, a reminder, anything. */
function bodySection({ title, bodyHtml, color }) {
  return `
    <tr><td style="padding:28px;">
      ${title ? `<h2 style="margin:0 0 16px;color:${color};font-size:18px;">${title}</h2>` : ""}
      ${bodyHtml}
    </td></tr>`;
}

function footer(schoolName) {
  return `
    <tr><td style="padding:16px 28px;border-top:1px solid #eee;text-align:center;">
      <p style="margin:0;color:#9ca3af;font-size:11px;">Sent by ${schoolName} via Qalox</p>
    </td></tr>`;
}

/**
 * @param {Object} params
 * @param {String} params.schoolName
 * @param {String|null} [params.logoUrl]
 * @param {String|null} [params.brandColor] hex, e.g. "#1a237e" — falls back to Qalox's own color when a school hasn't set one
 * @param {String} [params.title] shown as a heading above the body content
 * @param {String} params.bodyHtml the email-specific content
 * @returns {String} full HTML document body
 */
function brandedEmail({ schoolName, logoUrl, brandColor, title, bodyHtml }) {
  const color = brandColor || "#1a237e";
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 0;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0"
        style="background:#ffffff;border-radius:12px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">
        ${headerBand({ schoolName, logoUrl, color })}
        ${bodySection({ title, bodyHtml, color })}
        ${footer(schoolName)}
      </table>
    </td></tr>
  </table>`;
}

module.exports = { brandedEmail };
