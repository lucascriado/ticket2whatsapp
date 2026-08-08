const { ImapFlow } = require('imapflow');

function makeClient() {
  return new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: process.env.TICKET_EMAIL ?? '',
      pass: process.env.GMAIL_APP_PASSWORD ?? '',
    },
    logger: false,
  });
}

async function getLastUid() {
  const client = makeClient();
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const status = await client.status('INBOX', { uidNext: true });
    return (status.uidNext ?? 1) - 1;
  } finally {
    lock.release();
    await client.logout();
  }
}

function extractCode(msg) {
  const from = msg.envelope?.from?.[0]?.address ?? '';
  if (!from.includes('ticket.com.br') && !from.includes('edenred.com')) return null;

  const rawBuf =
    msg.bodyParts?.get('1') ??
    msg.bodyParts?.get('TEXT') ??
    Buffer.alloc(0);

  let raw = rawBuf.toString('utf8');

  // tenta base64 primeiro; se falhar mantém o raw original
  const b64 = raw.replace(/\s/g, '');
  if (/^[A-Za-z0-9+/]+=*$/.test(b64) && b64.length > 20) {
    try { raw = Buffer.from(b64, 'base64').toString('utf8'); } catch { /* mantém raw */ }
  }

  const decoded = raw
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  const text = decoded.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  return text.match(/\b(\d{6})\b/)?.[1] ?? null;
}

async function fetchVerificationCode(minUid = 0, timeoutMs = 150000) {
  const deadline = Date.now() + timeoutMs;
  let iteration = 0;

  // Uma conexão nova por tentativa: mantendo a mesma sessão IMAP aberta, o search
  // continua respondendo sobre o retrato da caixa de quando ela foi aberta, então
  // o e-mail do código — que chega DEPOIS — nunca aparecia e o loop girava em vazio.
  while (Date.now() < deadline) {
    iteration++;
    const client = makeClient();
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ uid: `${minUid + 1}:*` }, { uid: true });
      const novos = uids.filter((uid) => uid > minUid);
      console.log(`[Gmail] iter=${iteration} novos=${novos.length}`);

      for (const uid of novos) {
        const msg = await client.fetchOne(uid, { bodyParts: ['1', 'TEXT'], envelope: true }, { uid: true });
        const code = extractCode(msg);
        if (code) {
          console.log(`[Gmail] Código de verificação recebido (uid=${uid})`);
          return code;
        }
      }
    } finally {
      lock.release();
      await client.logout();
    }

    await new Promise((r) => setTimeout(r, 5000));
  }

  throw new Error(`Código de verificação não encontrado no Gmail após ${Math.round(timeoutMs / 1000)}s`);
}

module.exports = { getLastUid, fetchVerificationCode };
