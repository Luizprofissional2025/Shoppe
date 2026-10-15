// Vercel Serverless Function: /api/product
// Consults the Shopee Affiliate Open API from the server only.
// Keep SHOPEE_APP_ID and SHOPEE_APP_SECRET in Vercel environment variables.
import { createHash } from "node:crypto";

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
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error("Use um link direto de produto do domínio shopee.com.br.");
  }

  let match = url.pathname.match(/\/product\/(\d+)\/(\d+)/i);
  if (!match) match = url.pathname.match(/-i\.(\d+)\.(\d+)/i);

  let shopId;
  let itemId;

  if (match) {
    shopId = match[1];
    itemId = match[2];
  } else {
    shopId = url.searchParams.get("shopid") || url.searchParams.get("shop_id");
    itemId = url.searchParams.get("itemid") || url.searchParams.get("item_id");
  }

  if (!shopId || !itemId || !/^\d+$/.test(shopId) || !/^\d+$/.test(itemId)) {
    throw new Error(
      "Não consegui identificar a loja e o produto nesse link. Use o link direto do produto, não um link curto de afiliado."
    );
  }

  // GraphQL Int64 is used by the public product-offer schema. JSON numbers must
  // still be safe integers in JavaScript, otherwise exact ID matching is unsafe.
  const shopNumber = Number(shopId);
  const itemNumber = Number(itemId);
  if (!Number.isSafeInteger(shopNumber) || !Number.isSafeInteger(itemNumber)) {
    throw new Error("Os identificadores desse link excedem o limite numérico seguro para esta versão.");
  }

  return { shopId: shopNumber, itemId: itemNumber };
}

function parsePrice(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método não permitido. Use POST." });
  }

  const appId = process.env.SHOPEE_APP_ID;
  const secret = process.env.SHOPEE_APP_SECRET;
  if (!appId || !secret) {
    return res.status(503).json({
      error: "A integração com a Shopee ainda não está configurada.",
      details: "Cadastre SHOPEE_APP_ID e SHOPEE_APP_SECRET nas variáveis de ambiente da Vercel e faça um novo deploy."
    });
  }

  const productUrl = req.body && req.body.productUrl;
  if (typeof productUrl !== "string" || productUrl.length > 2048) {
    return res.status(400).json({ error: "Informe um link de produto válido." });
  }

  let ids;
  try {
    const url = new URL(productUrl);
    if (!["https:", "http:"].includes(url.protocol)) {
      return res.status(400).json({ error: "O link precisa usar HTTP ou HTTPS." });
    }
    ids = extractProductIds(url.href);
  } catch (error) {
    return res.status(400).json({
      error: error.message || "Link inválido.",
      details: "A busca automática exige um link direto de produto com identificadores da loja e do item."
    });
  }

  // Verify these arguments and scalar types in your account's Explorer if the
  // schema changes. The API's public product-offer schema documents itemId/shopId
  // as Int64 and supports querying productOfferV2 by those identifiers.
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
        pageInfo { page limit hasNextPage }
      }
    }
  `;

  const payload = JSON.stringify({
    query,
    variables: { itemId: ids.itemId, shopId: ids.shopId, page: 1, limit: 10 }
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
      return res.status(502).json({
        error: "A API da Shopee recusou a requisição.",
        details: `A Shopee respondeu com HTTP ${apiResponse.status}. Confira os logs e o acesso da API.`
      });
    }

    if (Array.isArray(data?.errors) && data.errors.length) {
      const firstError = data.errors[0];
      return res.status(502).json({
        error: "A Shopee retornou um erro na consulta.",
        details: String(firstError?.message || "Confira a query e os tipos dos campos no Explorer.").slice(0, 300),
        code: firstError?.extensions?.code ?? null
      });
    }

    const connection = data?.data?.productOfferV2;
    const nodes = Array.isArray(connection?.nodes) ? connection.nodes : [];
    const product = nodes.find(node =>
      String(node?.itemId) === String(ids.itemId) &&
      String(node?.shopId) === String(ids.shopId)
    );

    if (!product) {
      return res.status(404).json({
        error: "A Shopee não retornou uma oferta correspondente a esse produto.",
        details: "Confirme se o produto está disponível para divulgação pela API de Afiliados. Você ainda pode preencher os dados manualmente."
      });
    }

    const min = parsePrice(product.priceMin);
    const max = parsePrice(product.priceMax);
    const samePrice = min !== null && max !== null && min === max;
    const priceRange = min !== null && max !== null && min !== max;

    return res.status(200).json({
      name: typeof product.productName === "string" ? product.productName : "",
      description: "",
      // Only fill the price automatically when the API returns a single price.
      price: samePrice ? min : null,
      priceRange,
      oldPrice: null,
      imageUrl: typeof product.imageUrl === "string" &&
        /^https:\/\//i.test(product.imageUrl) ? product.imageUrl : "",
      // Keep the user's affiliate URL in the browser; these are informational.
      productUrl: typeof product.productLink === "string" ? product.productLink : "",
      offerUrl: typeof product.offerLink === "string" ? product.offerLink : "",
      shopName: typeof product.shopName === "string" ? product.shopName : ""
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError";
    return res.status(502).json({
      error: timedOut
        ? "A consulta à Shopee demorou demais."
        : "Não foi possível conectar à API da Shopee.",
      details: "Tente novamente e confira os logs da função na Vercel se o problema continuar."
    });
  }
}
