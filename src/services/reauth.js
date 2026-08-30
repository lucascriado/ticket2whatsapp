const puppeteer = require('puppeteer');
const { getLastUid, fetchVerificationCode } = require('./gmail');

// We use jwt.ms as redirect_uri so the B2C template's bot-check
// (which blocks 'portal-usuario' URIs) never fires.
const REDIRECT_URI = 'https://jwt.ms/';
const B2C_TENANT = process.env.B2C_TENANT ?? '';
const B2C_POLICY = process.env.B2C_POLICY ?? '';
const CLIENT_ID = process.env.B2C_CLIENT_ID ?? '';
const AUTHORIZE_URL = `https://ticketmobile.b2clogin.com/${B2C_TENANT}/oauth2/v2.0/authorize`;
const MFA_EMAIL_RADIO = '#extension_mfaByPhoneOrEmail-Login_email';

// O portal trocou o login de e-mail para CPF: o campo #login do template antigo
// deixou de existir e virou #signInName, com name="CPF" e pattern que só aceita
// 11 dígitos ou o formato 000.000.000-00. Manter #login como fallback caso a
// conta ainda caia no template velho.
const LOGIN_FIELD = '#signInName, #login';

async function reauth() {
  console.log('[Reauth] Iniciando login automático via Puppeteer...');

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const page = await browser.newPage();

  // Sem isso o B2C detecta a automação (navigator.webdriver, UA "HeadlessChrome")
  // e engole o submit do login: o clique em #next não dispara requisição nenhuma
  // e o fluxo trava esperando #VerificationCode até dar timeout.
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  );
  await page.setViewport({ width: 1366, height: 768 });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = { runtime: {} };
  });

  const params = new URLSearchParams({
    p: B2C_POLICY,
    client_id: CLIENT_ID,
    response_type: 'id_token',
    redirect_uri: REDIRECT_URI,
    scope: 'openid',
    nonce: 'defaultNonce',
    prompt: 'login',
  });

  let idToken = null;
  let ssoCookie = null;

  try {
    await page.goto(`${AUTHORIZE_URL}?${params}`, { waitUntil: 'networkidle2' });

    // Preenche o identificador no campo customizado do template. Hoje é o CPF;
    // TICKET_EMAIL fica como fallback para o template antigo.
    const identificador = process.env.TICKET_CPF || process.env.TICKET_EMAIL || '';
    if (!identificador) throw new Error('TICKET_CPF ausente — o login do portal exige CPF');

    await page.waitForSelector(LOGIN_FIELD, { timeout: 20000 });
    await page.type(LOGIN_FIELD, identificador, { delay: 50 });

    // Preenche senha (injetada pelo B2C no #api)
    await page.waitForSelector('#password', { timeout: 20000 });
    await page.type('#password', process.env.TICKET_PASSWORD ?? '', { delay: 50 });

    // Clica no botão next (injetado pelo B2C)
    await page.waitForSelector('#next', { timeout: 10000 });
    await page.click('#next');

    // Aguarda ou o botão de seleção de MFA ou o campo de código direto
    const lastUid = await getLastUid();
    const mfaOptionVisible = await Promise.race([
      page.waitForFunction(
        () => Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim().includes('Por e-mail')),
        { timeout: 15000 },
      ).then(() => true),
      page.waitForSelector('#VerificationCode', { timeout: 15000 }).then(() => false),
    ]).catch(async () => {
      const url = page.url();
      const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) ?? '');
      console.error(`[Reauth] Nenhum seletor de MFA encontrado. url=${url} body="${bodyText}"`);
      throw new Error('Página de MFA não reconhecida');
    });

    if (mfaOptionVisible) {
      // O "Por e-mail" do template é um <button type="submit">: clicar nele envia o
      // form com o radio de MFA ainda vazio, e o B2C só re-renderiza a mesma tela —
      // nenhum e-mail é disparado e o fluxo trava esperando #VerificationCode.
      // Quem de fato seleciona a opção é o radio do B2C; setEmailMFA() (do template)
      // marca o radio e submete pelo #continue.
      await page.waitForSelector(MFA_EMAIL_RADIO, { timeout: 30000 });

      const via = await page.evaluate((radioSel) => {
        try {
          // eval direto: a função é global no escopo da página, mas não em window
          eval('setEmailMFA()');
          return 'setEmailMFA';
        } catch {
          const radio = document.querySelector(radioSel);
          if (!radio) return null;
          radio.checked = true;
          radio.dispatchEvent(new Event('change', { bubbles: true }));
          document.getElementById('continue')?.click();
          return 'radio+continue';
        }
      }, MFA_EMAIL_RADIO);

      if (!via) throw new Error('Não foi possível selecionar o MFA por e-mail');
      console.log(`[Reauth] MFA por e-mail solicitado (via ${via}), aguardando código no Gmail...`);
    } else {
      console.log('[Reauth] Campo de código já visível (MFA enviado automaticamente), aguardando código no Gmail...');
    }

    await page.waitForSelector('#VerificationCode', { timeout: 60000 }).catch(async (err) => {
      const url = page.url();
      const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) ?? '');
      console.error(`[Reauth] #VerificationCode não apareceu. url=${url} body="${bodyText}"`);
      throw err;
    });

    const code = await fetchVerificationCode(lastUid);
    console.log(`[Reauth] Código recebido: ${code}`);

    await page.type('#VerificationCode', code);

    await page.waitForSelector('#signinEmailVerificationControl_but_verify_code', { timeout: 5000 });
    await page.click('#signinEmailVerificationControl_but_verify_code');

    try {
      await page.waitForSelector('#continue:not(.d-none)', { timeout: 15000 });
      await page.evaluate(() => document.getElementById('continue').click());
    } catch {
      // skipSteps() já clicou ou o redirect aconteceu antes
    }

    // Aguarda redirect para jwt.ms com o token no fragment
    const finalUrl = await page.waitForFunction(
      () => {
        const href = window.location.href;
        if (href.startsWith('https://jwt.ms') && href.includes('id_token')) return href;
        return false;
      },
      { timeout: 30000 },
    ).then((handle) => handle.jsonValue()).catch(async (err) => {
      const url = page.url();
      const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) ?? '');
      console.error(`[Reauth] Redirect para jwt.ms não ocorreu. url=${url} body="${bodyText}"`);
      throw err;
    });

    const fragment = finalUrl.split('#')[1] ?? '';
    idToken = new URLSearchParams(fragment).get('id_token');

    if (!idToken) throw new Error('id_token não encontrado na URL de redirect');

    // Extrai o cookie SSO do B2C
    const cookies = await page.cookies('https://ticketmobile.b2clogin.com');
    const sso = cookies.find((c) => c.name.startsWith('x-ms-cpim-sso'));
    if (sso) ssoCookie = `${sso.name}=${sso.value}`;

  } finally {
    await browser.close();
  }

  console.log('[Reauth] Login automático concluído.');
  return { idToken, ssoCookie };
}

module.exports = { reauth };
