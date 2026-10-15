// Vercel Serverless Function: /api/product
// Busca uma oferta na API oficial de Afiliados da Shopee.
// Variáveis necessárias na Vercel: SHOPEE_APP_ID e SHOPEE_APP_SECRET.

const { createHash } = require("node:crypto");

const SHOPEE_ENDPOINT = "https://open-api.affiliate.shopee.com.br/graphql";
const ALLOWED_HOSTS = new Set([
  "shopee.com.br",
  "www.shopee.com.br",
  "shopee.com",
  "www.shopee.com"
]);

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function extractProductIds(rawUrl) {
  const url = new URL(rawUrl);
  const host = url.hostname.toLowerCase();

  if (!ALLOWED_HOSTS.has(host)) {
    throw new Error(
      "O link precisa ser de um produto em shopee.com.br ou shopee.com. Links curtos de afiliado precisam ser resolvidos antes da consulta."
    );
  }

  // https://shopee.com.br/product/{shopId}/{itemId}
  let match = url.pathname.match(/\/product\/(\d+)\/(\d+)/i);
  if (match) {
    return { shopId: match[1], itemId: match[2] };
  }

  // https://shopee.com.br/nome-do-produto-i.{shopId}.{itemId}
  match = url.pathname.match(/-i\.(\d+)\.(\d+)/i);
  if (match) {
    return { shopId: match[1], itemId: match[2] };
  }

  // Alguns links incluem os IDs na query string.
  const shopId = url.searchParams.get("shopid") || url.searchParams.get("shop_id");
  const itemId = url.searchParams.get("itemid") || url.searchParams.get("item_id");

  if (shopId && itemId && /^\d+$/.test(shopId) && /^\d+$/.test(itemId)) {
    return { shopId, itemId };
  }

  throw new Error(
    "Não consegui identificar a loja e o produto nesse link. Use um link de produto da Shopee que contenha os IDs; links curtos de afiliado ainda não são resolvidos automaticamente."
  );
}


const SHORT_LINK_HOSTS = new Set([
  "s.shopee.com.br",
  "shope.ee",
  "s.shopee.co.id",
  "s.shopee.com"
]);

async function resolveProductUrl(rawUrl) {
  let current = new URL(rawUrl);
  if (!["http:", "https:"].includes(current.protocol)) throw new Error("Use um link HTTP ou HTTPS.");
  let host = current.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host) && !SHORT_LINK_HOSTS.has(host)) throw new Error("O link precisa pertencer à Shopee.");

  for (let i = 0; i < 6; i++) {
    host = current.hostname.toLowerCase();
    if (ALLOWED_HOSTS.has(host)) return current.href;
    if (!SHORT_LINK_HOSTS.has(host)) throw new Error("O link redirecionou para um domínio que não é da Shopee.");

    const response = await fetch(current.href, {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ShopeePromoBot/1.0)" },
      signal: AbortSignal.timeout(10000)
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("A Shopee retornou um redirecionamento sem destino.");
      current = new URL(location, current);
      if (!["http:", "https:"].includes(current.protocol)) throw new Error("O link redirecionou para um protocolo inválido.");
      host = current.hostname.toLowerCase();
      if (!ALLOWED_HOSTS.has(host) && !SHORT_LINK_HOSTS.has(host)) throw new Error("O link redirecionou para um domínio que não é da Shopee.");
      continue;
    }

    const html = await response.text().catch(() => "");
    const meta = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^;]+;\s*url=([^"']+)/i);
    const js = html.match(/(?:window\.location(?:\.href)?|location\.href)\s*=\s*["']([^"']+)["']/i);
    const target = (meta && meta[1]) || (js && js[1]);
    if (target) {
      current = new URL(target, current);
      host = current.hostname.toLowerCase();
      if (!ALLOWED_HOSTS.has(host) && !SHORT_LINK_HOSTS.has(host)) throw new Error("O link redirecionou para um domínio que não é da Shopee.");
      continue;
    }
    throw new Error("Não foi possível resolver automaticamente esse link curto. Tente um link completo do produto Shopee.");
  }
  throw new Error("O link curto excedeu o limite de redirecionamentos.");
}

function asFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function sendError(res, status, error, details, extra = {}) {
  return res.status(status).json({ error, details, ...extra });
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendError(res, 405, "Método não permitido.", "Use POST.");
  }

  const appId = process.env.SHOPEE_APP_ID;
  const secret = process.env.SHOPEE_APP_SECRET;

  if (!appId || !secret) {
    return sendError(
      res,
      503,
      "A integração não está configurada.",
      "Verifique se SHOPEE_APP_ID e SHOPEE_APP_SECRET estão definidas nas variáveis de ambiente da Vercel."
    );
  }

  const productUrl = req.body && req.body.productUrl;
  if (typeof productUrl !== "string" || productUrl.length > 2048) {
    return sendError(
      res,
      400,
      "Link de afiliado inválido.",
      "Envie o link no campo productUrl."
    );
  }

  let ids;
  let resolvedProductUrl;
  try {
    resolvedProductUrl = await resolveProductUrl(productUrl);
    ids = extractProductIds(resolvedProductUrl);
  } catch (error) {
    return sendError(
      res,
      400,
      "Não foi possível identificar o produto pelo link informado.",
      error.message || "Link inválido."
    );
  }

  // A API da Shopee define itemId e shopId como Int64.
  // Mantemos os IDs como dígitos e os enviamos como valores numéricos JSON.
  const shopIdNumber = Number(ids.shopId);
  const itemIdNumber = Number(ids.itemId);
  if (!Number.isSafeInteger(shopIdNumber) || !Number.isSafeInteger(itemIdNumber)) {
    return sendError(
      res,
      400,
      "Identificadores de produto inválidos.",
      "Os IDs extraídos não podem ser representados com segurança pelo JavaScript."
    );
  }

  const query = `
    query ProductOffer($itemId: Int64, $shopId: Int64, $page: Int, $limit: Int) {
      productOfferV2(itemId: $itemId, shopId: $shopId, page: $page, limit: $limit) {
        nodes {
          itemId
          productName
          productLink
          offerLink
          imageUrl
          priceMin
          priceMax
          priceDiscountRate
          shopId
          shopName
        }
        pageInfo {
          page
          limit
          hasNextPage
        }
      }
    }
  `;

  const payload = JSON.stringify({
    query,
    variables: {
      itemId: itemIdNumber,
      shopId: shopIdNumber,
      page: 1,
      limit: 1
    }
  });

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = sha256(appId + timestamp + payload + secret);
  const authorization =
    `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`;

  try {
    const apiResponse = await fetch(SHOPEE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authorization
      },
      body: payload,
      signal: AbortSignal.timeout(15000)
    });

    const data = await apiResponse.json().catch(() => null);

    if (!apiResponse.ok) {
      return sendError(
        res,
        502,
        "A API da Shopee recusou a requisição.",
        `A Shopee respondeu com HTTP ${apiResponse.status}.`,
        { providerStatus: apiResponse.status }
      );
    }

    if (data && Array.isArray(data.errors) && data.errors.length > 0) {
      const firstError = data.errors[0] || {};
      const extensions = firstError.extensions || {};
      const providerCode = extensions.code ?? firstError.code ?? null;
      const providerMessage = String(
        extensions.message || firstError.message || "Erro GraphQL sem mensagem."
      ).slice(0, 500);

      // Mantém o código/mensagem do provedor para que o próximo diagnóstico
      // não esconda a causa original. Nunca retorna App ID, segredo ou assinatura.
      return sendError(
        res,
        502,
        "A Shopee retornou um erro na consulta.",
        providerMessage,
        { code: providerCode }
      );
    }

    const connection = data && data.data && data.data.productOfferV2;
    const nodes = connection && Array.isArray(connection.nodes) ? connection.nodes : [];
    const product = nodes.find((node) =>
      String(node.itemId) === ids.itemId &&
      String(node.shopId) === ids.shopId
    );

    if (!product) {
      return sendError(
        res,
        404,
        "A Shopee não retornou uma oferta correspondente a esse produto.",
        "Confirme se o produto está disponível na API de Afiliados e se os IDs do link correspondem ao produto."
      );
    }

    const price = asFiniteNumber(product.priceMin);

    // Não inventamos preço anterior: a API não fornece um campo de preço antigo
    // nesta consulta. priceMax é o limite superior da faixa, não preço anterior.
    return res.status(200).json({
      name: product.productName || "",
      description: "",
      price,
      oldPrice: null,
      imageUrl:
        typeof product.imageUrl === "string" && product.imageUrl.startsWith("https://")
          ? product.imageUrl
          : "",
      // Preserva exatamente o link que o usuário forneceu para manter o tracking.
      affiliateUrl: productUrl,
      productUrl: product.productLink || resolvedProductUrl || productUrl,
      shopName: product.shopName || "",
      priceMax: asFiniteNumber(product.priceMax)
    });
  } catch (error) {
    const timedOut = error && error.name === "TimeoutError";
    return sendError(
      res,
      502,
      timedOut
        ? "A consulta à Shopee demorou demais."
        : "Não foi possível conectar à API da Shopee.",
      "Confira os logs da função /api/product na Vercel. A mensagem interna não é exposta para evitar revelar dados sensíveis."
    );
  }
};
