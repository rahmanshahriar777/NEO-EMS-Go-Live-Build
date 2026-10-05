/**
 * Minimal in-process fake SMTP server for worker email tests.
 *
 * Speaks just enough RFC 5321 (greeting → EHLO → MAIL/RCPT → DATA → QUIT)
 * for the worker's nodemailer-based sendSmtp client. Captures every
 * message's envelope + raw DATA so tests can assert recipients, subjects,
 * bodies, and MIME attachments without touching a real relay.
 */
import net from 'node:net';

export class FakeSmtpServer {
  private server = net.createServer();
  connections = 0;
  received: Array<{ mailFrom: string; rcptTo: string; data: string }> = [];

  async start(): Promise<number> {
    this.server.on('connection', (socket) => {
      this.connections += 1;
      socket.write('220 fake-smtp ESMTP\r\n');
      let buffer = '';
      let dataMode = false;
      let mailFrom = '';
      let rcptTo = '';
      let data = '';
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let idx: number;
        while ((idx = buffer.indexOf('\r\n')) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (dataMode) {
            if (line === '.') {
              dataMode = false;
              this.received.push({ mailFrom, rcptTo, data });
              data = '';
              socket.write('250 OK: queued\r\n');
            } else {
              data += line + '\r\n';
            }
            continue;
          }
          const upper = line.toUpperCase();
          if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
            socket.write('250 hello\r\n');
          } else if (upper.startsWith('MAIL FROM:')) {
            mailFrom = line.slice('MAIL FROM:'.length).trim();
            socket.write('250 OK\r\n');
          } else if (upper.startsWith('RCPT TO:')) {
            rcptTo = line.slice('RCPT TO:'.length).trim();
            socket.write('250 OK\r\n');
          } else if (upper === 'DATA') {
            dataMode = true;
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          } else if (upper === 'QUIT') {
            socket.write('221 Bye\r\n');
            socket.end();
          } else if (upper === 'RSET') {
            socket.write('250 OK\r\n');
          } else {
            socket.write('502 command not implemented\r\n');
          }
        }
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return (this.server.address() as net.AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}
