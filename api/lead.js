/**
 * POST /api/lead
 * Recebe dados do formulário e envia para ActiveCampaign.
 * Variáveis de ambiente necessárias no painel Vercel:
 *   ACTIVECAMPAIGN_URL  → ex: https://sua-conta.api-us1.com
 *   ACTIVECAMPAIGN_KEY  → chave de API do ActiveCampaign
 *
 * IDs de campos customizados no ActiveCampaign (ajustar conforme sua conta):
 *   FIELD_ID_SEGMENT  → ID do campo "Segmento da Empresa"
 *   FIELD_ID_REVENUE  → ID do campo "Faturamento Mensal"
 *   FIELD_ID_UTM_SOURCE, etc.
 */

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    name, email, phone,
    company_segment, monthly_revenue,
    utm_source, utm_medium, utm_campaign, utm_term, utm_content
  } = req.body || {};

  if (!name || !email || !phone) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes' });
  }

  const AC_URL = process.env.ACTIVECAMPAIGN_URL;
  const AC_KEY = process.env.ACTIVECAMPAIGN_KEY;

  if (!AC_URL || !AC_KEY) {
    console.error('[lead] ActiveCampaign env vars não configuradas');
    return res.status(500).json({ error: 'Integração não configurada' });
  }

  const nameParts = name.trim().split(/\s+/);
  const firstName = nameParts[0];
  const lastName  = nameParts.slice(1).join(' ') || '';

  /* ── Monta os fieldValues com os IDs dos campos customizados ── *
   * Para descobrir os IDs: GET /api/3/fields na sua conta AC.
   * Substitua os números abaixo pelos IDs corretos.              */
  const fieldValues = [
    { field: process.env.FIELD_ID_SEGMENT || '1', value: company_segment || '' },
    { field: process.env.FIELD_ID_REVENUE || '2', value: monthly_revenue || '' },
    { field: process.env.FIELD_ID_UTM_SOURCE   || '3', value: utm_source   || '' },
    { field: process.env.FIELD_ID_UTM_MEDIUM   || '4', value: utm_medium   || '' },
    { field: process.env.FIELD_ID_UTM_CAMPAIGN || '5', value: utm_campaign || '' },
    { field: process.env.FIELD_ID_UTM_TERM     || '6', value: utm_term     || '' },
    { field: process.env.FIELD_ID_UTM_CONTENT  || '7', value: utm_content  || '' },
  ].filter(f => f.value);

  try {
    /* ── 1. Cria ou atualiza contato ── */
    const syncRes = await fetch(`${AC_URL}/api/3/contact/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Token': AC_KEY,
      },
      body: JSON.stringify({
        contact: { email, firstName, lastName, phone, fieldValues }
      }),
    });

    if (!syncRes.ok) {
      const body = await syncRes.text();
      console.error('[lead] AC sync error:', body);
      return res.status(502).json({ error: 'Erro no ActiveCampaign' });
    }

    const syncData = await syncRes.json();
    const contactId = syncData?.contact?.id;

    /* ── 2. Adiciona tag "LP Agente IA" ao contato ── */
    if (contactId && process.env.ACTIVECAMPAIGN_TAG_ID) {
      await fetch(`${AC_URL}/api/3/contactTags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Api-Token': AC_KEY },
        body: JSON.stringify({ contactTag: { contact: contactId, tag: process.env.ACTIVECAMPAIGN_TAG_ID } }),
      }).catch(err => console.warn('[lead] tag error:', err));
    }

    /* ── 3. Adiciona a lista (opcional) ── */
    if (contactId && process.env.ACTIVECAMPAIGN_LIST_ID) {
      await fetch(`${AC_URL}/api/3/contactLists`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Api-Token': AC_KEY },
        body: JSON.stringify({ contactList: { list: process.env.ACTIVECAMPAIGN_LIST_ID, contact: contactId, status: 1 } }),
      }).catch(err => console.warn('[lead] list error:', err));
    }

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('[lead] unexpected error:', err);
    return res.status(500).json({ error: 'Erro interno' });
  }
};
