// Vercel Serverless Function: /api/image?url=...
// Proxy simples de imagens de produtos da Shopee. Usado só quando a CDN da Shopee
// não permite desenhar a imagem no canvas por CORS (o que impediria gerar o PNG).
// Aceita apenas imagens HTTPS de domínios da Shopee.

const ALLOWED_SUFFIXES = ["shopee.com.br", "shopee.com", "susercontent.com", "shopeemobile.com"];
const MAX_BYTES = 6 * 1024 * 1024;

function isAllowedHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return ALLOWED_SUFFIXES.some((d) => h === d || h.endsWith("." + d));
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método não permitido." });
  }

  let target;
  try {
    target = new URL(String(req.query.url || ""));
  } catch {
    return res.status(400).json({ error: "URL de imagem inválida." });
  }

  if (target.protocol !== "https:" || !isAllowedHost(target.hostname)) {
    return res.status(400).json({ error: "Imagem fora dos domínios permitidos." });
  }

  try {
    // redirect: "manual" evita ser levado para fora dos domínios permitidos.
    const upstream = await fetch(target.href, {
      redirect: "manual",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ShopeePromoBot/1.0)" },
      signal: AbortSignal.timeout(8000)
    });

    const type = upstream.headers.get("content-type") || "";
    if (!upstream.ok || !type.toLowerCase().startsWith("image/")) {
      return res.status(502).json({ error: "A origem não retornou uma imagem." });
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (buffer.length > MAX_BYTES) {
      return res.status(413).json({ error: "Imagem muito grande." });
    }

    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.status(200).send(buffer);
  } catch {
    return res.status(502).json({ error: "Não foi possível baixar a imagem." });
  }
};
