/**
 * POST /api/lead
 *
 * Variáveis de ambiente (Vercel → Settings → Environment Variables):
 *
 *  ActiveCampaign (obrigatórias):
 *    ACTIVECAMPAIGN_URL   → https://sua-conta.api-us1.com
 *    ACTIVECAMPAIGN_KEY   → chave de API
 *
 *  ActiveCampaign (opcionais):
 *    ACTIVECAMPAIGN_LIST_ID  → ID da lista para inscrever o contato
 *    FIELD_ID_SEGMENT        → ID campo customizado "Segmento"
 *    FIELD_ID_REVENUE        → ID campo customizado "Faturamento"
 *    FIELD_ID_UTM_SOURCE … FIELD_ID_UTM_CONTENT
 *
 *  Clint CRM (opcionais):
 *    CRM_API_URL  → endpoint do CRM que recebe o lead
 *    CRM_API_KEY  → chave Bearer para o CRM
 */

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    name, email, phone,
    company_segment, monthly_revenue,
    utm_source, utm_medium, utm_campaign, utm_term, utm_content,
  } = req.body || {};

  /* ── Validação básica ── */
  if (!name || !email || !phone || !company_segment || !monthly_revenue) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes' });
  }

  const AC_URL = process.env.ACTIVECAMPAIGN_URL;
  const AC_KEY = process.env.ACTIVECAMPAIGN_KEY;

  if (!AC_URL || !AC_KEY) {
    console.error('[lead] ACTIVECAMPAIGN_URL ou ACTIVECAMPAIGN_KEY não configurados');
    return res.status(500).json({ error: 'Integração não configurada' });
  }

  const [firstName, ...rest] = name.trim().split(/\s+/);
  const lastName = rest.join(' ') || '';

  /* ── Campos customizados (apenas os que tiverem FIELD_ID configurado) ── */
  const fieldValues = [
    [process.env.FIELD_ID_SEGMENT,      company_segment],
    [process.env.FIELD_ID_REVENUE,      monthly_revenue],
    [process.env.FIELD_ID_UTM_SOURCE,   utm_source],
    [process.env.FIELD_ID_UTM_MEDIUM,   utm_medium],
    [process.env.FIELD_ID_UTM_CAMPAIGN, utm_campaign],
    [process.env.FIELD_ID_UTM_TERM,     utm_term],
    [process.env.FIELD_ID_UTM_CONTENT,  utm_content],
  ]
    .filter(([fieldId, value]) => fieldId && value)
    .map(([field, value]) => ({ field, value }));

  const log = { ac: false, tag: false, list: false, crm: false };

  try {
    /* ────────────────────────────────────────────────
       1. Criar / atualizar contato no ActiveCampaign
    ──────────────────────────────────────────────── */
    const syncRes = await fetch(`${AC_URL}/api/3/contact/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Api-Token': AC_KEY },
      body: JSON.stringify({
        contact: { email, firstName, lastName, phone, fieldValues },
      }),
    });

    if (!syncRes.ok) {
      const body = await syncRes.text();
      console.error('[lead] AC sync error:', syncRes.status, body);
      return res.status(502).json({ error: 'Erro ao registrar contato no ActiveCampaign' });
    }

    const { contact } = await syncRes.json();
    const contactId = contact?.id;
    log.ac = true;

    /* ────────────────────────────────────────────────
       2. Aplicar tag "agente-de-ia" (busca ou cria)
    ──────────────────────────────────────────────── */
    if (contactId) {
      try {
        const tagId = await findOrCreateTag(AC_URL, AC_KEY, 'agente-de-ia');
        if (tagId) {
          const tagRes = await fetch(`${AC_URL}/api/3/contactTags`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Api-Token': AC_KEY },
            body: JSON.stringify({
              contactTag: { contact: String(contactId), tag: String(tagId) },
            }),
          });
          log.tag = tagRes.ok;
          if (!tagRes.ok) console.warn('[lead] tag apply status:', tagRes.status);
        }
      } catch (e) {
        console.warn('[lead] tag step failed (non-fatal):', e.message);
      }
    }

    /* ────────────────────────────────────────────────
       3. Inscrever em lista (se ACTIVECAMPAIGN_LIST_ID)
    ──────────────────────────────────────────────── */
    if (contactId && process.env.ACTIVECAMPAIGN_LIST_ID) {
      try {
        await fetch(`${AC_URL}/api/3/contactLists`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Api-Token': AC_KEY },
          body: JSON.stringify({
            contactList: {
              list: process.env.ACTIVECAMPAIGN_LIST_ID,
              contact: contactId,
              status: 1,
            },
          }),
        });
        log.list = true;
      } catch (e) {
        console.warn('[lead] list step failed (non-fatal):', e.message);
      }
    }

    /* ────────────────────────────────────────────────
       4. Enviar para o CRM (se CRM_API_URL configurado)
    ──────────────────────────────────────────────── */
    if (process.env.CRM_API_URL) {
      try {
        const crmRes = await fetch(process.env.CRM_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(process.env.CRM_API_KEY && {
              Authorization: `Bearer ${process.env.CRM_API_KEY}`,
            }),
          },
          body: JSON.stringify({
            name, email, phone,
            company_segment, monthly_revenue,
            utm_source:   utm_source   || '',
            utm_medium:   utm_medium   || '',
            utm_campaign: utm_campaign || '',
            utm_term:     utm_term     || '',
            utm_content:  utm_content  || '',
            source: 'lp-agente-ia',
          }),
        });
        log.crm = crmRes.ok;
        if (!crmRes.ok) console.warn('[lead] CRM status:', crmRes.status, await crmRes.text());
      } catch (e) {
        console.warn('[lead] CRM step failed (non-fatal):', e.message);
      }
    }

    console.info('[lead] ok', { email, log });
    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('[lead] unexpected error:', err);
    return res.status(500).json({ error: 'Erro interno no servidor' });
  }
};

/* ──────────────────────────────────────────────────────
   Helper: Busca tag por nome no AC; cria se não existir.
────────────────────────────────────────────────────── */
async function findOrCreateTag(acUrl, acKey, tagName) {
  /* Busca */
  const searchRes = await fetch(
    `${acUrl}/api/3/tags?search=${encodeURIComponent(tagName)}&limit=50`,
    { headers: { 'Api-Token': acKey } }
  );
  if (searchRes.ok) {
    const { tags = [] } = await searchRes.json();
    const found = tags.find(t => t.tag === tagName);
    if (found) return found.id;
  }

  /* Cria */
  const createRes = await fetch(`${acUrl}/api/3/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Api-Token': acKey },
    body: JSON.stringify({
      tag: { tag: tagName, tagType: 'contact', description: 'LP — Agente de IA para Vendas' },
    }),
  });
  if (!createRes.ok) {
    throw new Error(`Falha ao criar tag "${tagName}": ${createRes.status}`);
  }
  const { tag } = await createRes.json();
  return tag?.id;
}
