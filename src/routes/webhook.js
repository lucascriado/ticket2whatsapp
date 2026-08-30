const { Router } = require('express');
const { getCardBalance, getStatement } = require('../services/ticket');
const { sendMessage } = require('../services/evolution');

const router = Router();
const processedIds = new Set();

// Quem pode consultar o cartão. Sem a variável o bot responde a qualquer um —
// aceitável enquanto a instância roda no número pessoal, perigoso quando ela
// passa para um número dedicado, que acaba sendo compartilhado.
const PERMITIDOS = (process.env.ALLOWED_NUMBERS ?? '')
  .split(',')
  .map((n) => n.replace(/\D/g, ''))
  .filter(Boolean);

function autorizado(jid) {
  if (!PERMITIDOS.length) return true;
  return PERMITIDOS.includes(jid.split('@')[0].replace(/\D/g, ''));
}

function formatStatement(items) {
  if (!items.length) return '*🧾 Extrato Ticket Restaurante*\n\nNenhuma movimentação encontrada.';

  const lines = items.map((item) => {
    const date = new Date(item.date);
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');

    const isCredit = item.type === 'Recharge';
    const emoji = isCredit ? '🟢' : '🔴';
    const abs = Math.abs(item.value ?? 0);
    const valueNum = abs.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const valueStr = `R$ ${valueNum}`.padStart(12);
    const desc = (item.description ?? '').trim();

    return `${emoji} ${day}/${month}  ${valueStr}  ${desc}`;
  });

  return `*🧾 Extrato Ticket Restaurante*\n\`\`\`\n${lines.join('\n')}\n\`\`\``;
}

router.post('/', async (req, res) => {
  res.sendStatus(200);

  const event = req.body;

  if (event.event !== 'messages.upsert') return;

  const key = event.data?.key ?? {};
  const messageId = key.id;
  const rawJid = key.remoteJid ?? '';

  const remoteJid = (rawJid.endsWith('@lid') && key.remoteJidAlt
    ? key.remoteJidAlt
    : rawJid).trim();

  const text = (
    event.data?.message?.conversation ??
    event.data?.message?.extendedTextMessage?.text ??
    ''
  ).trim().toLowerCase();

  if (!remoteJid || remoteJid.endsWith('@lid')) return;
  if (text !== '/ticket saldo' && text !== '/ticket extrato') return;

  if (!autorizado(remoteJid)) {
    console.warn(`[Webhook] Recusado: ${remoteJid} fora de ALLOWED_NUMBERS`);
    return;
  }

  console.log(`[Webhook] id=${messageId} from=${remoteJid} comando="${text}"`);

  if (messageId) {
    if (processedIds.has(messageId)) return;
    processedIds.add(messageId);
    setTimeout(() => processedIds.delete(messageId), 5000);
  }

  if (text === '/ticket saldo') {
    try {
      const balance = await getCardBalance();
      const formatted = balance.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
      await sendMessage(remoteJid, `Saldo Ticket Restaurante: ${formatted}`);
    } catch (err) {
      console.error('[Webhook] Erro saldo:', err.message);
      try { await sendMessage(remoteJid, 'Erro ao consultar saldo. Tente novamente.'); } catch {}
    }
    return;
  }

  if (text === '/ticket extrato') {
    try {
      const items = await getStatement(15);
      await sendMessage(remoteJid, formatStatement(items));
    } catch (err) {
      console.error('[Webhook] Erro extrato:', err.message);
      try { await sendMessage(remoteJid, 'Erro ao consultar extrato. Tente novamente.'); } catch {}
    }
  }
});

module.exports = router;
