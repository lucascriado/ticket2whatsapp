const { Router } = require('express');
const { getCardBalance, getStatement } = require('../services/ticket');
const { sendMessage, parseIncoming } = require('../services/wa');

const router = Router();
const processedIds = new Set();

// Quem pode consultar o cartão. Sem a variável o bot responde a qualquer um —
// aceitável enquanto a instância roda no número pessoal, perigoso quando ela
// passa para um número dedicado, que acaba sendo compartilhado.
const PERMITIDOS = (process.env.ALLOWED_NUMBERS ?? '')
  .split(',')
  .map((n) => n.replace(/\D/g, ''))
  .filter(Boolean);

// O remoteJid identifica a *conversa*, não quem digitou. Quando o comando sai
// do próprio WhatsApp da instância, o remoteJid é o do destinatário — por isso
// o dono precisa ser liberado pelo fromMe, senão fica bloqueado no próprio bot
// ao consultar dentro do chat de outra pessoa.
function autorizado(jid, fromMe) {
  if (fromMe) return true;
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

  // Ligar temporariamente durante a migração: imprime o evento cru uma vez por
  // entrega, que é como se confere a FORMA do payload do provider novo contra
  // um evento real, em vez de contra a documentação.
  if (process.env.WA_LOG_RAW_EVENT === 'true') {
    console.log('[Webhook] evento cru:', JSON.stringify(event));
  }

  const msg = parseIncoming(event);
  if (!msg) return;

  const { messageId, chatJid, senderJid, text } = msg;

  if (!chatJid) return;
  if (text !== '/ticket saldo' && text !== '/ticket extrato') return;

  const fromMe = msg.fromMe;

  if (!autorizado(senderJid, fromMe)) {
    console.warn(
      `[Webhook] Recusado: ${senderJid} fora de ALLOWED_NUMBERS (chat=${chatJid})`,
    );
    return;
  }

  console.log(
    `[Webhook] id=${messageId} chat=${chatJid} de=${senderJid} fromMe=${fromMe} comando="${text}"`,
  );

  if (messageId) {
    if (processedIds.has(messageId)) return;
    processedIds.add(messageId);
    setTimeout(() => processedIds.delete(messageId), 5000);
  }

  if (text === '/ticket saldo') {
    try {
      const balance = await getCardBalance();
      const formatted = balance.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
      await sendMessage(chatJid, `Saldo Ticket Restaurante: ${formatted}`);
    } catch (err) {
      console.error('[Webhook] Erro saldo:', err.message);
      try { await sendMessage(chatJid, 'Erro ao consultar saldo. Tente novamente.'); } catch {}
    }
    return;
  }

  if (text === '/ticket extrato') {
    try {
      const items = await getStatement(15);
      await sendMessage(chatJid, formatStatement(items));
    } catch (err) {
      console.error('[Webhook] Erro extrato:', err.message);
      try { await sendMessage(chatJid, 'Erro ao consultar extrato. Tente novamente.'); } catch {}
    }
  }
});

module.exports = router;
