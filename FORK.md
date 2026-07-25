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

| Feature | Branch | O que faz | Candidata a PR upstream? |
|---------|--------|-----------|--------------------------|
| `TESSERA_PORT` | feat/fixed-port | Fixa a porta do servidor Electron (sem scan a partir de 32123); erro claro se ocupada. Uso: link estável p/ Tailscale no celular | Sim — complementa o TESSERA_HOST que o upstream já documenta p/ tailnet |

## Estado em 2026-07-17

- Fork criado a partir de upstream/main `0ed9b71` (pós v0.2.1).
- Hotfix v0.2.1-hotfix.1 (#151, collapsible Tasks box) ainda NÃO estava na main
  do upstream — chega na próxima release.
- Upstream: main ~8 commits à frente / dev ~20 commits exclusivos (fluxo deles:
  PR → dev, release → main).
