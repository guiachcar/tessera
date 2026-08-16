# Fork pessoal do Tessera (guiachcar/tessera)

Este clone é um fork de https://github.com/horang-labs/tessera configurado para
manter melhorias pessoais SEM perder a capacidade de absorver as atualizações da
comunidade. Este arquivo existe apenas na branch `custom` e não deve ir em PRs
para o upstream.

## Mapa de remotes e branches

| Ref       | Aponta para                | Papel                                          |
|-----------|----------------------------|------------------------------------------------|
| `origin`  | github.com/guiachcar/tessera | Meu fork (onde meus pushes vão)              |
| `upstream`| github.com/horang-labs/tessera | Comunidade (só leitura)                    |
| `main`    | espelho de `upstream/main` | Releases estáveis. NUNCA comitar aqui          |
| `dev`     | espelho de `upstream/dev`  | Desenvolvimento do upstream. NUNCA comitar aqui|
| `custom`  | `main` + minhas melhorias  | A "minha versão" — é daqui que sai o build     |
| `feat/*`  | uma melhoria isolada       | Nasce de `custom` (uso próprio) ou `dev` (PR)  |

Config já aplicada no repo: `remote.pushDefault=origin` (push vai pro fork mesmo
quando a branch rastreia upstream) e `main`/`dev` rastreiam o upstream (então
`git pull` nelas puxa da comunidade).

## Regras de ouro

1. NUNCA comitar em `main` ou `dev` — são espelhos do upstream.
2. Toda melhoria pessoal entra na `custom` (idealmente via branch `feat/x` curta,
   para poder descartar ou upstreamar depois).
3. Manter o delta pessoal enxuto: quanto menor a diferença `main..custom`, mais
   fácil absorver as atualizações da comunidade. Ver o delta: `git log --oneline main..custom`.

## Fazer uma melhoria pessoal

```bash
git checkout custom
git checkout -b feat/minha-melhoria
# ... trabalho, commits ...
git checkout custom && git merge --no-ff feat/minha-melhoria
git push
```

## Absorver atualizações da comunidade (fazer a cada release nova)

```bash
git fetch upstream --tags
git checkout main && git merge --ff-only upstream/main   # atualiza o espelho
git checkout custom && git rebase main                   # reaplica minhas melhorias por cima
# resolver conflitos se houver; depois:
git push --force-with-lease                              # fork pessoal: force-push da custom é ok
```

Racional do rebase: as customizações ficam sempre "por cima" da release, o delta
pessoal permanece explícito e os conflitos aparecem pontualmente, commit a commit.

Ver o que a comunidade mudou antes de absorver: `git log --oneline main..upstream/main`.

## Contribuir uma melhoria de volta para a comunidade

O upstream aceita PRs contra `dev` (ver CONTRIBUTING.md). Manter o commit isolado
em `feat/x` facilita:

```bash
git fetch upstream
git checkout -b pr/minha-melhoria upstream/dev
git cherry-pick <commits da feat/minha-melhoria>
git push -u origin pr/minha-melhoria
gh pr create -R horang-labs/tessera -B dev
```

Checks que o upstream pede antes de PR: `npm run lint`, `npx tsc --noEmit`,
`NODE_ENV=production npm run build`. UI: incluir screenshot/recording.

## Build da minha versão para Windows

O app que eu uso é o build portable Windows (dados em `C:\Users\User\.tessera`).

```bash
npm install
npm run electron:build:win   # electron-builder --win portable --x64
```

Atenção (WSL2): o electron-builder gerando alvo Windows a partir do Linux precisa
de wine para editar os recursos do .exe. Se falhar no WSL, rodar o build no
Windows nativo (Node instalado no Windows, mesmo repo via \\wsl$ ou clone
espelho) é o caminho mais confiável.

## Customizações ativas na custom

| Feature | Commit em split/features | O que faz | PR upstream? |
|---------|--------------------------|-----------|--------------|
| `TESSERA_PORT` | (feat/fixed-port, já na custom) | Porta fixa do servidor Electron; erro claro se ocupada | Sim |
| `TESSERA_HOST` no Electron | d2c8139 | Servidor embutido aceita bind fora do loopback (tailnet) | Sim — par com TESSERA_PORT |
| model-config.local.json | 60899dd | Overlay local editável sobre o catálogo remoto de modelos | Sim |
| Provider Kimi Code (ACP) | 360c5b1 | Adapter + parser ACP com testes | Sim (abrir issue antes — CONTRIBUTING pede p/ provider novo) |
| Provider Z.ai GLM | b3b4322 | Subclasse do ClaudeCodeAdapter com env overrides | Sim (idem) |
| Side chat | 073cd24 | Sessão paralela de discussão anexa à principal (parent_session_id) | Sim |
| Workspace file nav + WSL IO | 31e73a7 + 529386f (retrabalho do 839c85d) | Integrada à custom sobre a base 0.2.2: find/stat/head via wsl.exe --exec com fallback (complementa a inotify bridge do upstream), deadlines/erros reais na rota files, fix do spinner preso, paths clicáveis no chat, preview de PDF/imagem, aba Files default sem git. Peças superadas pela 0.2.2 (explorer tree, refactor do file panel) descartadas. | Sim (dividir: WSL IO / spinner fix / chat links) |

Atenção (migração de banco): o fork usa migração **v30** idempotente que
re-garante terminal_provider_sessions + parent_session_id, porque o build
custom pré-0.2.2 gravou v29=parent enquanto o upstream 0.2.2 usou
v29=terminal. Ao portar o side chat para PR upstream, renumerar para a
próxima versão livre do upstream na hora.

Para abrir PR upstream: cherry-pick do commit da feature em branch nova
baseada em `upstream/dev` (`git checkout -b pr/<nome> upstream/dev &&
git cherry-pick <sha>`), rodar os checks do CONTRIBUTING e abrir contra `dev`.

## Estado em 2026-07-17

- Fork criado a partir de upstream/main `0ed9b71` (pós v0.2.1).
- Hotfix v0.2.1-hotfix.1 (#151, collapsible Tasks box) ainda NÃO estava na main
  do upstream — chega na próxima release.
- Upstream: main ~8 commits à frente / dev ~20 commits exclusivos (fluxo deles:
  PR → dev, release → main).

## Análise da v0.2.3 (2026-08-16) — só levantamento, nada aplicado

Upstream `v0.2.3` (publicada 15/08/2026): **668 commits / 1041 arquivos** sobre a
v0.2.2. Nosso delta: **15 commits / 97 arquivos**. Interseção de 57 arquivos;
`git merge-tree --write-tree v0.2.3 custom` → **28 arquivos em conflito**.

### O que a 0.2.3 tornou nativo (candidato a descarte no fork)

| Nativo na 0.2.3 | Nosso equivalente | Situação |
|---|---|---|
| Tessera CLI (`src/lib/control/*`, 19 arquivos + `skills/tessera-cli/SKILL.md`): `status`, `worktree create`, `session launch/wait/read/prompt/send-keys`, toggle em Settings → Development | `src/lib/orchestrator/*` (MCP HTTP in-process, 515 linhas, fase 1 read-only) | Colisão direta. Diferença de modelo de confiança: nosso MCP é acessível por qualquer processo local (token + loopback); a CLI deles só roda dentro de sessão gerenciada (`TESSERA_ENV=1`). |
| Mobile + pairing Tailscale (`electron/remote-access-status.ts`, `tailscale-firewall-capability.ts`, `api/pairing/*`, QR, rate limit, firewall) | patch `TESSERA_HOST` no Electron (d2c8139) | Superado. (`TESSERA_HOST` no `server.ts` já era upstream desde a 0.2.2.) |
| `ELECTRON_DEFAULT_PORT = 32123` + `resolveElectronServerPort` | `TESSERA_PORT` (261cbd7) | Porta já é fixa por padrão — checar se o env ainda faz falta. |
| Custom models (`custom-model-settings.tsx`, `provider-session-custom-models.ts`) — só `claude-code` e `codex`, só o ID | `model-config.local.json` overlay (60899dd) | Sobreposição parcial. |
| Git workflow reescrito (seleção em massa, mensagem gerada, pull/push/PR, conflitos) | git panel typed errors (529386f) | Painel refeito; conflito em `git-panel.tsx` + `use-git-panel-controller.ts`. |
| WSL: `wsl-path-probe`, `wsl-inotify-bridge`, overlays Codex/OpenCode | WSL exec fast path (31e73a7) | Parcial — medir se o fast path ainda ganha algo. |

Ganho puro (nada nosso concorre): file editing, worktree setup scripts, PTY Chat
View, slash discovery, sub-session reorder, archive individual de sessão.
Novidade a observar: telemetria de uso (tem opt-out em Settings e por env,
`telemetryDisabledByEnv`).

### O que continua exclusivo do fork

Providers **Kimi (ACP)**, **Z.ai GLM** e **AVI** (upstream segue só
claude-code/codex/opencode) e o **side chat** — `parent_session_id` tem 0
ocorrências em `src/lib/db` da v0.2.3; o "Sub-Session" deles é agrupamento de
board, conceito diferente. São ~40 arquivos que o upstream nem tocou.

### Banco: risco menor que o registrado acima

Upstream está em `SCHEMA_VERSION = 39`; nós em 30. Bancos carimbados 30 pelo
build custom fazem o upstream pular só o bloco `fromVersion < 30`, que apenas
adiciona `projects.preparation_script` — recriado de forma idempotente por
`ensureLatestSchema()` no boot. Os blocos 31→39 rodam normalmente. Ação na
atualização: renumerar nossa migração v30 → **v40**, mantendo-a idempotente.

### Caminho recomendado (não executado)

Replantar sobre `v0.2.3` em branch nova em vez de rebase/merge: recolocar só
providers + side chat (+ o que sobreviver de chat links/WSL) e descartar o que
virou nativo. Delta cai de 97 para ~40 arquivos, quase todos exclusivos.
Regra que se confirmou na prática: feature em **arquivo novo** com 1-2 linhas de
registro em arquivo do upstream não conflita (providers); feature que edita
componente do upstream conflita (git panel). Encolhimento permanente do delta =
PR upstream dos providers (CONTRIBUTING pede issue antes p/ provider novo).
