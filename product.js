// Vercel Function placeholder for the Shopee Affiliate API.
// This endpoint intentionally does NOT guess Shopee's signing/authentication scheme.
// Once you have official API documentation, implement the request here.
// Never expose secrets in index.html or variables prefixed with NEXT_PUBLIC_.

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST." });
  }

  const { productUrl } = req.body || {};
  if (typeof productUrl !== "string" || !/^https?:\/\//i.test(productUrl)) {
    return res.status(400).json({ error: "Informe um link de produto válido." });
  }

  // Check that required server-side environment variables exist without returning their values.
  const hasAppId = Boolean(process.env.SHOPEE_APP_ID);
  const hasSecret = Boolean(process.env.SHOPEE_APP_SECRET);

  if (!hasAppId || !hasSecret) {
    return res.status(503).json({
      error: "A integração com a Shopee ainda não foi configurada.",
      details: "Adicione as variáveis privadas na Vercel e implemente a autenticação conforme a documentação oficial da API."
    });
  }

  // TODO: implement the official Shopee Affiliate API request and signature here.
  // The exact endpoint, payload, and signing method must come from the documentation for your account.
  return res.status(501).json({
    error: "As credenciais foram configuradas, mas a chamada da API ainda não foi implementada.",
    details: "Envie a documentação oficial da API (sem chaves ou tokens) para concluir esta função."
  });
}
