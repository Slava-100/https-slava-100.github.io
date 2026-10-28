// SOCKS5 CONNECT bridge for SSH ProxyCommand.
// Usage: node tools/socks-bridge.js <host> <port>
// Connects to a local SOCKS5 proxy (127.0.0.1:10808) and pipes stdin/stdout.
const net = require('net');

const host = process.argv[2];
const port = parseInt(process.argv[3], 10);
const proxyHost = process.env.SOCKS_PROXY_HOST || '127.0.0.1';
const proxyPort = parseInt(process.env.SOCKS_PROXY_PORT || '10808', 10);

if (!host || !port) {
  console.error('usage: node socks-bridge.js <host> <port>');
  process.exit(64);
}

const sock = net.connect(proxyPort, proxyHost);
let buf = Buffer.alloc(0);
let state = 0;

sock.on('connect', () => {
  sock.write(Buffer.from([5, 1, 0])); // greeting: no auth
});

sock.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);

  if (state === 0) {
    if (buf.length < 2) return;
    if (buf[0] !== 5 || buf[1] !== 0) {
      console.error('socks: no acceptable auth method');
      process.exit(2);
    }
    buf = buf.slice(2);
    state = 1;
    const name = Buffer.from(host);
    const p = Buffer.alloc(2);
    p.writeUInt16BE(port);
    sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, p]));
    return;
  }

  if (state === 1) {
    if (buf.length < 4) return;
    const rep = buf[1];
    const atyp = buf[3];
    let len = 4;
    if (atyp === 1) len += 4;
    else if (atyp === 4) len += 16;
    else if (atyp === 3) {
      if (buf.length < 5) return;
      len += 1 + buf[4];
    }
    len += 2;
    if (buf.length < len) return;
    if (rep !== 0) {
      console.error('socks: connect failed, code ' + rep);
      process.exit(3);
    }
    const rest = buf.slice(len);
    state = 2;
    if (rest.length) process.stdout.write(rest);
    sock.pipe(process.stdout);
    process.stdin.pipe(sock);
  }
});

sock.on('error', (err) => {
  if (err.code === 'EPIPE' || err.code === 'ECONNRESET') return;
  console.error('socks error: ' + err.message);
  process.exit(1);
});

process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') process.exit(0);
});

process.stdin.on('error', () => {});
process.stdin.on('end', () => sock.end());
