/**
 * Neoteric Digital Corporate Email Template Generator
 * Produces clean, responsive, client-compatible HTML emails.
 */

export interface EmailTemplateOptions {
  recipientName: string;
  subject: string;
  preheader?: string;
  bodyHtml: string;
  callToAction?: {
    label: string;
    url: string;
  };
  footerNote?: string;
}

export function generateCorporateEmailHtml(options: EmailTemplateOptions): string {
  const logoUrl = process.env.FRONTEND_URL ? `${process.env.FRONTEND_URL}/logo.png` : 'http://localhost:3000/logo.png';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${options.subject}</title>
  <style>
    body { margin: 0; padding: 0; background-color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
    .container { max-width: 600px; margin: 30px auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05); }
    .header { padding: 28px 32px; background-color: #ffffff; border-bottom: 1px solid #f1f5f9; text-align: left; }
    .content { padding: 32px; color: #1e293b; font-size: 15px; line-height: 1.6; }
    .button { display: inline-block; padding: 12px 28px; background-color: #2563eb; color: #ffffff !important; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 14px; margin-top: 20px; }
    .footer { padding: 24px 32px; background-color: #f8fafc; border-top: 1px solid #f1f5f9; text-align: center; color: #64748b; font-size: 12px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header with Neoteric Digital Logo -->
    <div class="header">
      <table width="100%" border="0" cellspacing="0" cellpadding="0">
        <tr>
          <td>
            <img src="${logoUrl}" alt="Neoteric Digital" height="38" style="height: 38px; width: auto; display: block; border: 0;" />
          </td>
          <td align="right" style="font-family: monospace; font-size: 11px; color: #64748b; text-transform: uppercase;">
            Enterprise EMS
          </td>
        </tr>
      </table>
    </div>

    <!-- Main Content Body -->
    <div class="content">
      <p style="font-weight: 600; font-size: 16px; margin-bottom: 16px;">Hello ${options.recipientName},</p>
      ${options.bodyHtml}

      ${options.callToAction ? `
        <div style="margin: 28px 0; text-align: left;">
          <a href="${options.callToAction.url}" class="button" target="_blank">${options.callToAction.label}</a>
        </div>
      ` : ''}

      <p style="margin-top: 32px; color: #475569; font-size: 14px;">
        Warm regards,<br />
        <strong>Neoteric Digital Human Resources & Operations</strong>
      </p>
    </div>

    <!-- Official Corporate Footer -->
    <div class="footer">
      <p style="margin: 0 0 8px 0;">
        &copy; ${new Date().getFullYear()} <strong>Neoteric Digital Ltd.</strong> All rights reserved.
      </p>
      <p style="margin: 0; font-size: 11px; color: #94a3b8;">
        This is an official system transmission. Dhaka Office (UTC+6).<br />
        ${options.footerNote || 'Confidential & Proprietary Workforce Management System'}
      </p>
    </div>
  </div>
</body>
</html>
  `.trim();
}
