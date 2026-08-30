# vr-ticket-for-whatsapp

Bot pessoal que consulta saldo e extrato do Ticket Restaurante pelo WhatsApp.
Autentica por OAuth2 no Azure B2C, renova o token sozinho e, quando o silent
renewal falha, refaz o login por Puppeteer lendo o código de MFA no Gmail.

- **Repositório:** `git@github.com:lucascriado/vr-ticket-for-whatsapp.git` (público)
- **Produção:** <https://vr-ticket-for-whatsapp.lucascriado.com>
- **Local:** `C:\www\vr-ticket-for-whatsapp`

## Rotas

| Rota | O que faz |
| --- | --- |
| `GET /card/balance` | saldo do cartão |
| `POST /webhook` | recebe as mensagens da Evolution |

`/` responde **404 por design** — não há rota na raiz.

## Estrutura

```
src/
  index.js  app.js
  routes/    card.js  webhook.js
  services/  ticket.js  token.js  reauth.js  gmail.js  evolution.js
  jobs/      tokenRefresh.js (30 min)  midnightReauth.js (00:00)
```

## Deploy

Coolify, aplicação **`bth92c5leaajws7jhmbbrnba`**, porta **3000**, push na
`main` dispara o deploy pelo GitHub App.

> **Build pack tem de ser `dockerfile`, nunca `railpack`.** O `Dockerfile`
> instala as ~30 bibliotecas de sistema que o Chrome do Puppeteer exige
> (`libnss3`, `libgbm1`, `libatk*`, `libgtk-3-0`…). Com railpack o container
> sobe e morre.

## Variáveis

Credenciais do Ticket, senha de app do Gmail, Azure B2C e Evolution. Todas
gravadas no Coolify. Três coisas que já custaram tempo:

- **`EVOLUTION_URL` e `WEBHOOK_URL` usam `.com`**, não o `.com.br` que aparece
  em `.env` antigos. O padrão do ambiente é `.com`.
- **`EVOLUTION_API_KEY` precisa ser a `AUTHENTICATION_API_KEY` do serviço da
  Evolution no Coolify.** A que circulava no `.env` era da instância anterior
  ao reset da VPS e devolvia 401.
- **Não existe `TICKET_CARD_ID`.** Nenhuma linha lê essa variável —
  `services/ticket.js` resolve o cartão em tempo de execução pela API da
  carteira, pegando o de `product.type === 'TRE'`. Ela foi removida do ambiente
  e do `.env.example` em 30/08/2026.

## O login do portal mudou (30/08/2026)

O portal do Ticket foi reformado e quebrou o reauth em dois pontos. Corrigido
nos commits `424b0d8` e `fc25def`:

1. **O login deixou de ser e-mail e passou a ser CPF.** O campo `#login` do
   template antigo virou `#signInName`, com `name="CPF"` e um `pattern` que só
   aceita 11 dígitos ou `000.000.000-00`. Daí a variável **`TICKET_CPF`**;
   `TICKET_EMAIL` ficou só como fallback do template velho.
2. **Os botões do controle de verificação foram renomeados** de
   `signinEmailVerificationControl_*` para `signinCpfVerificationControl_*`. O
   código agora mira em `button.verifyCode` — a classe é âncora mais estável
   que o id — com os dois ids como reserva, e espera `{ visible: true }`,
   porque o botão só aparece depois que o código é digitado.

### Como diagnosticar se quebrar de novo

Foi o que destravou as duas descobertas: rodar um script Puppeteer **dentro do
container**, abrindo a mesma URL do B2C e despejando o DOM — seletores
presentes, atributos do campo, lista de botões com id, texto e visibilidade.
Adivinhar seletor não funciona; o erro `waitForSelector failed` não diz o que
existe na página.

O fluxo completo, quando saudável, aparece assim nos logs:

```
[Reauth] MFA por e-mail solicitado (via radio+continue)
[Gmail]  Código de verificação recebido (uid=...)
[Reauth] Login automático concluído.
[Ticket] Cartao resolvido: ...
```

## Dependência da Evolution

O bot registra o webhook na Evolution no boot. Se a Evolution estiver fora, o
log mostra `[Evolution] Webhook não registrado` com o código HTTP — **526**
significa problema de certificado no domínio dela, **404** significa que a
instância do `EVOLUTION_INSTANCE` não existe (é preciso criar e parear lendo o
QR code no celular), e **401** significa chave errada.

O `services/evolution.js` só envia texto e registra o webhook — não marca
mensagens como lidas nem altera presença.
