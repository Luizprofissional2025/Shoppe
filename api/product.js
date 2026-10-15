// Vercel Serverless Function: /api/product
// Resolve links (inclusive links curtos de afiliado), identifica shopId/itemId e
// consulta productOfferV2 na API oficial de Afiliados da Shopee.
// Variáveis necessárias na Vercel: SHOPEE_APP_ID e SHOPEE_APP_SECRET.

const { createHash } = require("node:crypto");

const SHOPEE_ENDPOINT = "https://open-api.affiliate.shopee.com.br/graphql";
const MAX_REDIRECTS = 8;
// Ordem importa: o primeiro é o que já recebia redirecionamento 302 nos testes reais.
const USER_AGENTS = [
  { name: "bot", value: "Mozilla/5.0 (compatible; ShopeePromoBot/1.0)" },
  { name: "curl", value: "curl/8.5.0" },
  { name: "preview", value: "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)" },
  { name: "mobile", value: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36" }
];

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// Aceita shopee.com.br, shopee.com, subdomínios (ex.: s.shopee.com.br) e shope.ee.
// Usa comparação exata de sufixo para evitar domínios como "shopee.com.br.evil.com".
function isShopeeHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return ["shopee.com.br", "shopee.com", "shope.ee"].some(
    (d) => h === d || h.endsWith("." + d)
  );
}

function parseHttpUrl(raw, base) {
  let url;
  try {
    url = new URL(raw, base);
  } catch {
    throw new Error("O link informado não é uma URL válida.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Use um link HTTP ou HTTPS.");
  }
  return url;
}

// Extrai shopId/itemId de uma URL da Shopee. Retorna null se não encontrar.
function extractProductIds(input, depth = 0) {
  let url;
  try {
    url = input instanceof URL ? input : new URL(input);
  } catch {
    return null;
  }

  const path = decodeURIComponent_safe(url.pathname);
  let m;

  // Link curto de afiliado após redirecionar: /opaanlp/{shopId}/{itemId}
  // Também cobre /product/{shopId}/{itemId} e /universal-link/product/{shopId}/{itemId}.
  m = path.match(/\/(?:opaanlp|product)\/(\d+)\/(\d+)(?:[/?#]|$)/i);
  if (m) return { shopId: m[1], itemId: m[2] };

  // /nome-do-produto-i.{shopId}.{itemId}
  m = path.match(/-i\.(\d+)\.(\d+)/i);
  if (m) return { shopId: m[1], itemId: m[2] };

  // Qualquer caminho terminando em /{shopId}/{itemId} (ex.: novos prefixos da Shopee).
  m = path.match(/\/(\d{3,})\/(\d{3,})\/?$/);
  if (m) return { shopId: m[1], itemId: m[2] };

  // IDs na query string.
  const q = url.searchParams;
  const shopId = q.get("shopid") || q.get("shop_id") || q.get("shopId");
  const itemId = q.get("itemid") || q.get("item_id") || q.get("itemId");
  if (shopId && itemId && /^\d+$/.test(shopId) && /^\d+$/.test(itemId)) {
    return { shopId, itemId };
  }

  // Parâmetros que carregam outra URL (redirect, url, deeplink...).
  if (depth < 2) {
    for (const value of q.values()) {
      if (/^https?:\/\//i.test(value)) {
        const nested = extractProductIds(value, depth + 1);
        if (nested) return nested;
      }
    }
  }
  return null;
}

function decodeURIComponent_safe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Procura IDs no HTML de uma página (canonical, og:url, redirecionamentos por JS/meta).
function extractIdsFromHtml(html, base) {
  const candidates = [];
  const patterns = [
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i,
    /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"']+)["']/i,
    /(?:window\.location(?:\.href)?|location\.href)\s*=\s*["']([^"']+)["']/i
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) candidates.push(m[1]);
  }
  for (const c of candidates) {
    try {
      const ids = extractProductIds(new URL(c.replace(/&amp;/g, "&"), base));
      if (ids) return { ids, next: c };
    } catch {
      /* ignora candidato inválido */
    }
  }
  return { ids: null, next: candidates[0] || null };
}

// Busca uma URL sem seguir redirecionamentos automaticamente.
function fetchHop(href, userAgent) {
  return fetch(href, {
    method: "GET",
    redirect: "manual",
    headers: {
      "User-Agent": userAgent,
      Accept: "text/html,application/xhtml+xml,*/*",
      "Accept-Language": "pt-BR,pt;q=0.9"
    },
    signal: AbortSignal.timeout(8000)
  });
}

// IDs escritos diretamente no HTML (links /opaanlp/x/y, /product/x/y ou -i.x.y).
function scanHtmlForIds(html) {
  let m = html.match(/\/(?:opaanlp|product)\/(\d+)\/(\d+)/i);
  if (m) return { shopId: m[1], itemId: m[2] };
  m = html.match(/-i\.(\d+)\.(\d+)/i);
  if (m) return { shopId: m[1], itemId: m[2] };
  return null;
}

// Segue os redirecionamentos manualmente (somente hosts da Shopee) até encontrar os IDs.
// A Shopee responde de forma diferente conforme o User-Agent (302 para bots/crawlers,
// página HTML para navegadores), então tentamos mais de um.
async function resolveProduct(rawUrl) {
  let current = parseHttpUrl(rawUrl);
  if (!isShopeeHost(current.hostname)) {
    throw new Error("O link precisa pertencer à Shopee (shopee.com.br ou s.shopee.com.br).");
  }

  const chain = [current.href];
  const notes = [];

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const direct = extractProductIds(current);
    if (direct) return { ids: direct, resolvedUrl: current.href, chain };
    if (hop === MAX_REDIRECTS) break;

    let nextUrl = null;

    for (const ua of USER_AGENTS) {
      let response;
      try {
        response = await fetchHop(current.href, ua.value);
      } catch (e) {
        notes.push(`${ua.name}: ${e && e.name === "TimeoutError" ? "timeout" : "falha de rede"}`);
        continue;
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location) {
          nextUrl = parseHttpUrl(location, current);
          break;
        }
      }

      const html = (await response.text().catch(() => "")).slice(0, 400000);
      const found = extractIdsFromHtml(html, current);
      const scanned = found.ids || scanHtmlForIds(html);
      if (scanned) return { ids: scanned, resolvedUrl: current.href, chain };

      if (found.next) {
        const candidate = parseHttpUrl(found.next, current);
        if (candidate.href !== current.href) {
          nextUrl = candidate;
          break;
        }
      }
      const title = (html.match(/<title[^>]*>([^<]{0,80})/i) || [])[1];
      notes.push(`${ua.name}: HTTP ${response.status}${title ? ` "${title.trim()}"` : ""}`);
    }

    if (!nextUrl) break;
    if (!isShopeeHost(nextUrl.hostname)) {
      throw new Error("O link redirecionou para um domínio que não é da Shopee.");
    }
    current = nextUrl;
    chain.push(current.href);
  }

  const error = new Error(
    "Não consegui encontrar o ID da loja e do produto nesse link, nem seguindo os redirecionamentos."
  );
  error.chain = chain;
  error.notes = notes;
  throw error;
}

function asFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function sendError(res, status, error, details, extra = {}) {
  return res.status(status).json({ error, details, ...extra });
}

// Extrai a primeira mensagem de erro GraphQL/HTTP da resposta da Shopee, sem segredos.
function describeProviderError(data) {
  if (!data || !Array.isArray(data.errors) || data.errors.length === 0) return null;
  const first = data.errors[0] || {};
  const ext = first.extensions || {};
  return {
    code: ext.code ?? first.code ?? null,
    message: String(ext.message || first.message || "Erro GraphQL sem mensagem.").slice(0, 500)
  };
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

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = null;
    }
  }
  const productUrl = body && typeof body.productUrl === "string" ? body.productUrl.trim() : null;
  if (!productUrl || productUrl.length > 2048) {
    return sendError(res, 400, "Link de afiliado inválido.", "Envie o link no campo productUrl.");
  }

  let ids;
  let resolvedProductUrl;
  try {
    const resolved = await resolveProduct(productUrl);
    ids = resolved.ids;
    resolvedProductUrl = resolved.resolvedUrl;
  } catch (error) {
    const timedOut = error && error.name === "TimeoutError";
    const chain =
      (error && error.chain ? ` Caminho: ${error.chain.join(" → ")}.` : "") +
      (error && error.notes && error.notes.length ? ` Respostas: ${error.notes.join("; ")}.` : "");
    return sendError(
      res,
      400,
      "Não foi possível identificar o produto pelo link informado.",
      timedOut
        ? "A Shopee demorou demais para resolver o link curto. Tente novamente."
        : (error.message || "Link inválido.") + chain
    );
  }

  // A API da Shopee define itemId e shopId como Int64.
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

  // Os IDs vão escritos direto na consulta (sem variáveis), como nos exemplos da
  // documentação da Shopee: o erro 10010 "wrong type" vinha do tipo das variáveis.
  // IDs contêm apenas dígitos (validado acima), então a interpolação é segura.
  const buildQuery = (idLiteral) => `
    query {
      productOfferV2(itemId: ${idLiteral(ids.itemId)}, shopId: ${idLiteral(ids.shopId)}, page: 1, limit: 10) {
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

  // Tentativa 1: IDs numéricos. Tentativa 2 (só se a Shopee acusar tipo errado): IDs entre aspas.
  const variants = [(v) => v, (v) => `"${v}"`];

  async function callShopee(idLiteral) {
    const payload = JSON.stringify({ query: buildQuery(idLiteral) });
    // Assinatura oficial: SHA256(AppId + Timestamp + Payload + Secret), sobre o corpo EXATO enviado.
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = sha256(appId + timestamp + payload + secret);
    const authorization = `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`;
    const response = await fetch(SHOPEE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: payload,
      signal: AbortSignal.timeout(15000)
    });
    const json = await response.json().catch(() => null);
    return { apiResponse: response, data: json };
  }

  try {
    let result = await callShopee(variants[0]);
    if (String((describeProviderError(result.data) || {}).code) === "10010") {
      result = await callShopee(variants[1]);
    }
    const { apiResponse, data } = result;

    // Erros GraphQL podem vir com HTTP 200 ou com 4xx; em ambos os casos expomos
    // código e mensagem do provedor (nunca App ID, segredo ou assinatura).
    const providerError = describeProviderError(data);
    if (providerError) {
      return sendError(res, 502, "A Shopee retornou um erro na consulta.", providerError.message, {
        code: providerError.code,
        providerStatus: apiResponse.status
      });
    }

    if (!apiResponse.ok) {
      return sendError(
        res,
        502,
        "A API da Shopee recusou a requisição.",
        `A Shopee respondeu com HTTP ${apiResponse.status}.`,
        { providerStatus: apiResponse.status }
      );
    }

    const connection = data && data.data && data.data.productOfferV2;
    const nodes = connection && Array.isArray(connection.nodes) ? connection.nodes : [];
    const node = nodes.find(
      (n) => String(n.itemId) === ids.itemId && String(n.shopId) === ids.shopId
    );

    if (!node) {
      return sendError(
        res,
        404,
        "A Shopee não retornou uma oferta correspondente a esse produto.",
        `IDs identificados: loja ${ids.shopId}, produto ${ids.itemId}. O produto pode não participar do Programa de Afiliados.`
      );
    }

    const price = asFiniteNumber(node.priceMin);
    const product = {
      productId: String(node.itemId),
      name: node.productName || "",
      description: "",
      price,
      // A API não fornece preço anterior nesta consulta; não inventamos.
      oldPrice: null,
      imageUrl:
        typeof node.imageUrl === "string" && node.imageUrl.startsWith("https://")
          ? node.imageUrl
          : "",
      shopName: node.shopName || "",
      priceMax: asFiniteNumber(node.priceMax),
      productUrl: node.productLink || resolvedProductUrl || productUrl
    };

    // `product` é o formato lido pelo index.html; os campos na raiz mantêm
    // compatibilidade com a versão anterior da resposta.
    return res.status(200).json({
      product,
      ...product,
      // Preserva exatamente o link que o usuário forneceu para manter o tracking.
      affiliateUrl: productUrl
    });
  } catch (error) {
    const timedOut = error && error.name === "TimeoutError";
    return sendError(
      res,
      502,
      timedOut ? "A consulta à Shopee demorou demais." : "Não foi possível conectar à API da Shopee.",
      "Confira os logs da função /api/product na Vercel."
    );
  }
};
