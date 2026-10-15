# Gerador de Promoções Shopee

## Arquivos
- `index.html`: interface responsiva, formulário manual, arte em Canvas, PNG e preparação de mensagem para WhatsApp.
- `api/product.js`: função de backend para consultar a API de Afiliados Shopee.
- `README.md`: instruções de configuração e teste.

## Configuração na Vercel
Em **Project → Settings → Environment Variables**, configure:
- `SHOPEE_APP_ID`
- `SHOPEE_APP_SECRET`

Não coloque essas variáveis no HTML, no JavaScript do navegador, no GitHub ou em variáveis `NEXT_PUBLIC_*`. Depois de salvar as variáveis, faça um novo deploy.

## Como usar a busca automática
1. Abra o gerador.
2. Preencha seu link de afiliado no campo próprio — esse link será preservado.
3. Cole o link direto do produto Shopee no campo de busca automática.
4. Clique em **Buscar produto automaticamente**.
5. Confira os dados retornados antes de gerar a arte.

A busca atual requer um link direto que contenha os IDs da loja e do item. Links curtos de afiliado não são resolvidos automaticamente. O preço anterior não é estimado. Se o produto tiver uma faixa de preços, o preço promocional ficará vazio para confirmação manual. A imagem pode depender de permissões CORS do servidor da Shopee.

## Observação sobre a API
A função usa `productOfferV2` com `itemId` e `shopId`, assina o corpo JSON exato enviado e verifica os IDs na resposta. O esquema da API pode variar conforme a conta ou mudanças da Shopee. Se a API retornar erro GraphQL, confira a query e os tipos no [explorador oficial](https://open-api.affiliate.shopee.com.br/explorer).

## Testes
Sem credenciais válidas da sua conta não é possível confirmar uma chamada real à Shopee. Depois de publicar, teste com um link direto de produto e verifique os logs de Functions na Vercel. Um erro `502` pode indicar credenciais, assinatura, esquema GraphQL ou falha de rede; a mensagem retornada e os logs ajudam a distinguir esses casos.

## Compartilhamento
A arte é baixada separadamente para anexação manual no WhatsApp. O navegador não envia mensagens nem anexa automaticamente um arquivo local.
