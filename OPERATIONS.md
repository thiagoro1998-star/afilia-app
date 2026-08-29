# Afilia — Operação e recuperação

Este arquivo é a fonte rápida para manter o Afilia funcionando sem depender de memória ou de uma pessoa específica.

## Arquitetura oficial

- **Código fonte:** GitHub `thiagoro1998-star/afilia-app`, branch `main`.
- **Frontend / PWA:** GitHub Pages, publicado automaticamente por GitHub Actions.
- **URL oficial do MVP:** `https://thiagoro1998-star.github.io/afilia-app/`
- **Autenticação, banco e backend:** Supabase projeto `afilia-app`, ref `yjgwlofhordbmjomxcdx`.
- **Telegram:** `@afiliaapp_bot`, webhook no backend Supabase.
- **Vercel:** não é parte obrigatória da arquitetura atual.
- **Lovable:** não é parte obrigatória da arquitetura atual.

## Regra principal

O repositório GitHub é a única fonte de verdade do frontend. Não manter versões paralelas do mesmo app em hosts diferentes.

## Publicação

1. Alterar arquivos na branch `main`.
2. O workflow `.github/workflows/pages.yml` publica automaticamente no GitHub Pages.
3. Confirmar no GitHub Actions que o job `Deploy Afilia` terminou em `success`.
4. Abrir a URL oficial em aba privada e testar login, Home e perfil.

## Teste mínimo após qualquer alteração

1. Abrir `auth.html` sem sessão e confirmar tela Entrar / Criar conta.
2. Fazer login.
3. Confirmar redirecionamento para Home.
4. Tocar no avatar e confirmar `Minha conta`.
5. Tocar em `Sair da conta` e confirmar retorno ao login.
6. Reabrir o app e confirmar que a sessão persiste após novo login.
7. Abrir Integrações e confirmar que Telegram e marketplaces carregam.

## Recuperação rápida

Se uma atualização quebrar o frontend:

1. Abrir o histórico de commits no GitHub.
2. Identificar o último commit conhecido como estável.
3. Reverter o commit problemático ou restaurar os arquivos a partir do commit estável.
4. Aguardar o GitHub Actions publicar novamente.
5. Nunca apagar o projeto Supabase para corrigir problema visual do frontend.

## Service worker / cache

O `sw.js` deve apenas cuidar de cache/offline. Regras de autenticação e perfil devem ficar no código normal do app (`app.js`). Isso evita versões fantasma e lógica diferente entre Safari e PWA instalada.

Quando houver mudança estrutural no cache, aumentar `CACHE` em `sw.js` (`afilia-v8`, `v9`, etc.).

## Segurança

- Nunca colocar service-role key, token do Telegram, senha ou sessão WhatsApp no GitHub.
- A chave publishable do Supabase pode existir no frontend; RLS deve permanecer habilitado.
- Funções que acessam dados privados devem validar o usuário.
- Tokens de marketplace e Telegram ficam apenas no backend/cofre.

## Telegram

Bot oficial: `@afiliaapp_bot`.

Se o bot parar de responder:

1. Verificar se o webhook está ativo.
2. Verificar logs da Edge Function do Telegram.
3. Confirmar que o token ainda corresponde a `@afiliaapp_bot`.
4. Não gerar outro bot sem necessidade.

## Identificação da versão

A versão do frontend está em `AFILIA_VERSION` dentro de `app.js` e aparece em `Minha conta`. Sempre aumentar a versão em mudanças relevantes.

## O que NÃO fazer

- Não criar outro Supabase para corrigir um bug visual.
- Não publicar cópias diferentes do frontend em vários hosts.
- Não usar service worker para implementar autenticação.
- Não expor telas técnicas de GitHub, Supabase ou Vercel ao usuário final.
- Não remover RLS para “fazer funcionar”.

## Estado de referência

A partir da versão **0.3.0**, a autenticação é validada diretamente por `app.js`, o avatar abre `Minha conta`, logout é real e o service worker é apenas cache/offline.
