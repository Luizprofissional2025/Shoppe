// api/product.js
// Função de servidor da Vercel para consultar a API de Afiliados da Shopee.
// As credenciais ficam exclusivamente nas variáveis de ambiente.

const { createHash } = require("node:crypto");

const SHOPEE_ENDPOINT =
  "https://open-api.affiliate.shopee.com.br/graphql";

function sha256(value) {
  return createHash("sha256")
    .update(value, "utf8")
    .digest("hex");
}

// Extrai os identificadores de um link direto de produto.
function extractProductIds(rawUrl) {
  const url = new URL(rawUrl);
  const host = url.hostname.toLowerCase();

  const allowedHosts = [
    "shopee.com.br",
    "www.shopee.com.br",
    "shopee.com",
    "www.shopee.com"
  ];

  if (!allowedHosts.includes(host)) {
    throw new Error(
      "Use um link direto de produto do domínio shopee.com.br."
    );
  }

  // Formato: /product/{shopId}/{itemId}
  let match = url.pathname.match(
    /\/product\/(\d+)\/(\d+)/i
  );

  if (match) {
    return {
      shopId: Number(match[1]),
      itemId: Number(match[2])
    };
  }

  // Formato: /nome-do-produto-i.{shopId}.{itemId}
  match = url.pathname.match(/-i\.(\d+)\.(\d+)/i);

  if (match) {
    return {
      shopId: Number(match[1]),
      itemId: Number(match[2])
    };
  }

  // Também tenta identificar os IDs na query string.
  const shopId =
    url.searchParams.get("shopid") ||
    url.searchParams.get("shop_id");

  const itemId =
    url.searchParams.get("itemid") ||
    url.searchParams.get("item_id");

  if (
    shopId &&
    itemId &&
    /^\d+$/.test(shopId) &&
    /^\d+$/.test(itemId)
  ) {
    return {
      shopId: Number(shopId),
      itemId: Number(itemId)
    };
  }

  throw new Error(
    "Não consegui identificar o produto nesse link. " +
    "Cole o link direto do produto, não um link curto de afiliado."
  );
}

function asFiniteNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number) && number >= 0
    ? number
    : null;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  // Aceita somente POST.
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return res.status(405).json({
      error: "Método não permitido. Use POST."
    });
  }

  // Lê as credenciais somente no servidor.
  const appId = process.env.SHOPEE_APP_ID;
  const secret = process.env.SHOPEE_APP_SECRET;

  if (!appId || !secret) {
    return res.status(503).json({
      error: "A integração ainda não está configurada.",
      details:
        "Cadastre SHOPEE_APP_ID e SHOPEE_APP_SECRET " +
        "nas variáveis de ambiente da Vercel e faça um novo deploy."
    });
  }

  const productUrl =
    req.body && req.body.productUrl;

  if (
    typeof productUrl !== "string" ||
    productUrl.length > 2048
  ) {
    return res.status(400).json({
      error: "Informe um link de produto válido."
    });
  }

  // Valida o link e extrai os IDs.
  let ids;

  try {
    const parsedUrl = new URL(productUrl);

    if (
      !["https:", "http:"].includes(parsedUrl.protocol)
    ) {
      return res.status(400).json({
        error: "O link precisa usar HTTP ou HTTPS."
      });
    }

    ids = extractProductIds(parsedUrl.href);
  } catch (error) {
    return res.status(400).json({
      error: error.message || "Link inválido.",
      details:
        "A busca automática precisa de um link direto " +
        "de produto que contenha os identificadores da loja e do item."
    });
  }

  // Consulta GraphQL para localizar a oferta do produto.
  const query = `
    query ProductOffer(
      $itemId: Int,
      $shopId: Int,
      $page: Int,
      $limit: Int
    ) {
      productOfferV2(
        itemId: $itemId,
        shopId: $shopId,
        page: $page,
        limit: $limit
      ) {
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
      itemId: ids.itemId,
      shopId: ids.shopId,
      page: 1,
      limit: 1
    }
  });

  // Assinatura da requisição.
  const timestamp = Math.floor(
    Date.now() / 1000
  ).toString();

  const signature = sha256(
    appId + timestamp + payload + secret
  );

  const authorization =
    `SHA256 Credential=${appId}, ` +
    `Timestamp=${timestamp}, ` +
    `Signature=${signature}`;

  try {
    const apiResponse = await fetch(
      SHOPEE_ENDPOINT,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authorization
        },
        body: payload,
        signal: AbortSignal.timeout(15000)
      }
    );

    const data = await apiResponse
      .json()
      .catch(() => null);

    if (!apiResponse.ok) {
      return res.status(502).json({
        error: "A API da Shopee recusou a requisição.",
        details:
          `A Shopee respondeu com HTTP ${apiResponse.status}. ` +
          "Confira o acesso à API e as credenciais na Vercel."
      });
    }

    if (
      data &&
      Array.isArray(data.errors) &&
      data.errors.length
    ) {
      return res.status(502).json({
        error: "A Shopee retornou um erro na consulta.",
        details: String(
          data.errors[0].message ||
          "Confira a query e o acesso à API."
        ).slice(0, 300)
      });
    }

    const product =
      data &&
      data.data &&
      data.data.productOfferV2 &&
      Array.isArray(
        data.data.productOfferV2.nodes
      )
        ? data.data.productOfferV2.nodes[0]
        : null;

    if (!product) {
      return res.status(404).json({
        error:
          "A Shopee não retornou uma oferta para esse produto.",
        details:
          "Confirme se o produto está disponível " +
          "para divulgação pela API de Afiliados."
      });
    }

    const price = asFiniteNumber(
      product.priceMin
    );

    const discountRate = asFiniteNumber(
      product.priceDiscountRate
    );

    let oldPrice = null;

    // O preço anterior é uma estimativa baseada no desconto.
    if (
      price !== null &&
      discountRate !== null &&
      discountRate > 0 &&
      discountRate < 100
    ) {
      oldPrice =
        Math.round(
          (price / (1 - discountRate / 100)) * 100
        ) / 100;
    }

    return res.status(200).json({
      name: product.productName || "",
      description: "",
      price,
      oldPrice,

      imageUrl:
        typeof product.imageUrl === "string" &&
        product.imageUrl.startsWith("https://")
          ? product.imageUrl
          : "",

      affiliateUrl:
        product.offerLink ||
        product.productLink ||
        productUrl,

      productUrl:
        product.productLink || productUrl,

      shopName: product.shopName || ""
    });
  } catch (error) {
    const timedOut =
      error && error.name === "TimeoutError";

    return res.status(502).json({
      error: timedOut
        ? "A consulta à Shopee demorou demais."
        : "Não foi possível conectar à API da Shopee.",

      details:
        "Tente novamente. Se o problema continuar, " +
        "confira os logs da função na Vercel."
    });
  }
};
