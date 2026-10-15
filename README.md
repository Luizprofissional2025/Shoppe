# Gerador de Promoções Shopee — projeto inicial

## O que já funciona
- Interface responsiva em `index.html` (HTML, CSS e JavaScript no mesmo arquivo).
- Formulário para link, nome, preços e foto.
- Geração da arte promocional no navegador.
- Download da arte em PNG.
- Compartilhamento pelo navegador/WhatsApp, com confirmação manual.

## Limitação conhecida
A Shopee não é consultada automaticamente ainda. A integração depende da documentação e do método de autenticação disponibilizados para a sua conta de afiliado. `api/product.js` é um endpoint seguro inicial, mas permanece intencionalmente incompleto para não inventar o esquema de assinatura da API.

## Publicar na Vercel
1. Extraia o ZIP.
2. Envie o conteúdo da pasta para um repositório GitHub.
3. Na Vercel, selecione **Add New → Project**, importe esse repositório e clique em **Deploy**.
4. Abra **Project → Settings → Environment Variables**.
5. Adicione:
   - `SHOPEE_APP_ID` — o App ID, se exigido pela documentação da API.
   - `SHOPEE_APP_SECRET` — o segredo/chave privada exigido pela documentação.
6. Marque os ambientes necessários (comece por Preview para testes) e salve.
7. Faça um novo deploy para que as variáveis estejam disponíveis na função.

**Segurança:** não use prefixo `NEXT_PUBLIC_` em segredos. Nunca coloque o segredo em `index.html`, JavaScript do navegador, GitHub ou mensagens públicas. Como o App ID pode ser tratado como identificador público ou privado dependendo da integração, mantenha-o no servidor também por simplicidade.

## Testar localmente (opcional)
Requer Node.js e Vercel CLI:
```bash
npm i -g vercel
vercel dev
```
O endpoint estará disponível em `/api/product`, mas responderá que a integração não foi implementada até adicionarmos a chamada oficial da API.

## Próximo passo para concluir a integração
Envie o link da documentação oficial da API de afiliados da Shopee ou um exemplo de requisição sem credenciais, assinaturas ou tokens. Não compartilhe segredos ativos. Se a chave já foi publicada em uma conversa, considere rotacioná-la no painel da Shopee.
