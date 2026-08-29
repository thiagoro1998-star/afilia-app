# Afilia — Operação e recuperação

Este arquivo é a fonte rápida para manter o Afilia funcionando sem depender de memória ou de uma pessoa específica.

## Arquitetura oficial

- **Código fonte:** GitHub `thiagoro1998-star/afilia-app`, branch `main`.
- **Frontend / PWA:** GitHub Pages, publicado automaticamente por GitHub Actions.
- **URL oficial do MVP:** `https://thiagoro1998-star.github.io/afilia-app/`
- **Autenticação, banco e backend:** Supabase projeto `afilia-app`, ref `yjgwlofhordbmjomxcdx`.
- **Telegram:** `@afiliaapp_bot`, webhook no backend Supabase.
- **Vercel:** não faz parte da arquitetura oficial atual.
- **Lovable:** não faz parte da arquitetura oficial atual.

## Divisão de responsabilidades — regra de produto

### Telegram = operação diária

O usuário deve conseguir operar o Afilia sem precisar abrir o painel web a cada oferta.

Responsabilidades do bot:

- receber links de produtos;
- registrar ofertas na conta correta;
- mostrar fila;
- colocar oferta na fila;
- mostrar agendamentos;
- controlar espelhamentos e automações;
- mostrar regras rápidas;
- exibir estatísticas operacionais;
- exibir logs rápidos;
- levar o usuário ao painel web quando precisar de credenciais ou análises mais completas.

### Web/PWA = gestão e análise

O painel web não deve competir com o Telegram como central operacional.

Responsabilidades do painel:

- visão geral da operação;
- resultados e indicadores;
- evolução de volume;
- desempenho por marketplace;
- atividade/histórico;
- integração de contas e APIs;
- gestão da conta Afilia;
- diagnóstico e saúde da operação.

### Supabase = cérebro comum

Telegram e painel web usam o mesmo banco. Não criar estado paralelo para a mesma oferta.

Principais tabelas:

- `offers`: ofertas recebidas e seu estado;
- `queue_items`: fila e agendamentos;
- `templates`: modelos de texto;
- `automation_rules`: espelhamentos/regras;
- `marketplace_integrations`: estado público das integrações;
- cofre/RPCs: segredos das integrações;
- `telegram_user_links`: vínculo entre conta Afilia e Telegram;
- `audit_events`: eventos relevantes sem guardar segredos.

## Fluxo operacional alvo

`mensagem/link recebido → identificar marketplace → registrar oferta → converter quando possível → filtrar/aplicar regras → template → fila/agendamento/publicação → log → resultado`

Nunca marcar uma etapa como concluída se o motor correspondente ainda não estiver implementado.

## Estado atual — versão 0.4

- login e sessão reais pelo Supabase Auth;
- painel web focado em gestão, resultados, integrações e atividade;
- bot Telegram é a interface operacional principal;
- links enviados ao bot viram registros reais em `offers`;
- botão `Colocar na fila` grava em `queue_items` e muda a oferta para `queued`;
- estatísticas do bot consultam dados reais do Supabase;
- logs rápidos consultam ofertas reais;
- integrações são consultadas por usuário;
- controles de ativar/pausar automações usam `automation_rules`;
- credenciais continuam protegidas no backend/cofre;
- espelhamento real origem → destino ainda depende do worker de mensageria e NÃO deve ser anunciado como concluído.

## Próximo componente crítico

### Worker de espelhamento

É a peça que falta para automação completa.

Deve:

1. receber/observar mensagens de uma origem autorizada;
2. detectar links e marketplace;
3. aplicar filtros/regras do usuário;
4. tentar conversão do link pela integração disponível;
5. aplicar template;
6. respeitar intervalo, horário e limite diário;
7. enviar ao destino autorizado;
8. registrar sucesso/falha sem armazenar conversa desnecessariamente.

Para WhatsApp, qualquer solução baseada em sessão vinculada deve ser tratada como modo avançado/opcional e com risco operacional explícito. Não prometer risco zero de banimento.

## Publicação

1. Alterar arquivos na branch `main`.
2. O workflow `.github/workflows/pages.yml` publica automaticamente no GitHub Pages.
3. Confirmar no GitHub Actions que `Deploy Afilia` terminou em `success`.
4. Testar a URL oficial em aba privada e com sessão existente.

## Teste mínimo após alterações no painel

1. Abrir sem sessão e confirmar tela de login.
2. Fazer login.
3. Confirmar `Visão`, `Resultados`, `Integrações` e `Atividade`.
4. Tocar no avatar e confirmar `Minha conta`.
5. Fazer logout e confirmar retorno ao login.
6. Confirmar que nenhum segredo aparece no HTML, localStorage ou logs.

## Teste mínimo após alterações no bot

1. `/menu` responde.
2. Conta vinculada é reconhecida.
3. Enviar um link cria uma oferta em `offers`.
4. `Colocar na fila` cria item em `queue_items` sem duplicar.
5. `Filas`, `Estatísticas` e `Logs` retornam dados reais.
6. `Conta e integrações` não exibe segredos.
7. Usuário A nunca consegue ver dados do usuário B.

## Recuperação rápida

Se uma atualização quebrar o frontend:

1. abrir o histórico de commits;
2. identificar o último commit estável;
3. reverter o commit problemático;
4. aguardar o GitHub Actions publicar novamente;
5. nunca apagar o projeto Supabase para corrigir problema visual.

Se o bot quebrar:

1. verificar a Edge Function `telegram-webhook`;
2. confirmar webhook secret e token no cofre;
3. verificar se `telegram_user_links` continua íntegra;
4. reverter para a versão anterior da Edge Function se necessário;
5. não criar outro bot como primeira tentativa.

## Segurança

- Nunca colocar service-role key, bot token, senha, Secret de marketplace ou sessão WhatsApp no GitHub.
- A chave publishable do Supabase pode ficar no frontend; RLS deve permanecer habilitado.
- Dados de usuário no frontend devem passar por RLS.
- Edge Functions administrativas usam service role apenas no backend.
- Segredos de marketplace ficam no cofre/RPCs de serviço.
- Não salvar conteúdo bruto de conversas quando metadados forem suficientes.
- Logs devem ser redigidos e não conter tokens.

## Service worker / cache

`sw.js` cuida apenas de cache/offline. Autenticação e regras de negócio ficam fora dele.

## Identificação da versão

A versão atual de produto está em `AFILIA_VERSION` dentro de `app.js`.

## O que NÃO fazer

- não criar outro Supabase para corrigir bug visual;
- não manter frontends oficiais diferentes em vários hosts;
- não usar service worker para autenticação;
- não expor telas técnicas ao usuário final;
- não remover RLS para “fazer funcionar”;
- não guardar senha pessoal de marketplace;
- não declarar espelhamento como ativo antes de existir worker de mensageria funcionando e testado.
