# PM2 Manager

Painel web para administrar muitos processos PM2 com autenticação, backup do `dump.pm2`, controle de acesso, auditoria e ferramentas de diagnóstico do servidor.

## Recursos

- Múltiplos usuários
- Perfis `admin`, `operator` e `viewer`
- Senhas protegidas com `scrypt`
- Sessão assinada com expiração
- Cookie `HttpOnly` + `SameSite=Strict`
- Proteção CSRF nas ações administrativas
- Bloqueio temporário após tentativas repetidas de login
- Auditoria por usuário, IP, data, ação e resultado
- Lista de processos PM2
- Busca por nome, namespace e caminho
- CPU, RAM, restarts e uptime
- Start, Stop e Restart
- Delete restrito a administradores
- Logs stdout e stderr
- `PM2 Save` pelo painel
- Backup automático do `dump.pm2` antes de cada save
- Backup automático antes de excluir um processo
- Histórico, download e preparação de restore
- Proteção do próprio processo `pm2-manager`
- Encontrador de `ecosystem.config.*`
- Relação entre ecosystems encontrados e processos PM2 atuais
- Gerador de comandos PM2, inclusive `--update-env`
- Terminal seguro e auditado para diagnóstico

## Páginas

```text
/              Processos
/backups.html  Backups
/users.html    Usuários
/audit.html    Auditoria
/tools.html    Ferramentas do servidor (admin)
```

## Perfis de acesso

### Viewer

Pode consultar processos, status, CPU/RAM, logs e lista de backups. Não pode executar comandos nem baixar dumps.

### Operator

Possui tudo do Viewer e também pode executar Start, Stop, Restart, PM2 Save e criar backup manual.

Não pode executar Delete, baixar dumps, restaurar backup, gerenciar usuários, acessar auditoria administrativa ou Ferramentas do servidor.

### Admin

Possui acesso completo, incluindo Delete, download de `dump.pm2`, preparação de restore, criação/edição de usuários, auditoria e Ferramentas do servidor.

O sistema sempre exige pelo menos um administrador ativo.

## Onde ficam as credenciais

As credenciais não ficam no Git nem nas variáveis de ambiente salvas pelo PM2.

Por padrão:

```text
~/.pm2/pm2-manager-auth.json
```

O arquivo contém chave aleatória de sessão, lista de usuários, perfis, hashes `scrypt` e versões de sessão.

No Linux, o arquivo deve possuir permissão `600`.

## Configuração inicial

```bash
cd /caminho/pm2-manager
npm install
npm run auth:setup
npm run check
pm2 start ecosystem.config.js
pm2 save
```

O assistente `auth:setup` cria ou atualiza um administrador. A senha deve possuir pelo menos 12 caracteres.

## Gerenciamento de usuários pelo terminal

```bash
npm run users -- list
npm run users -- add
npm run users -- password usuario
npm run users -- role usuario operator
npm run users -- disable usuario
npm run users -- enable usuario
npm run users -- remove usuario
```

Após alterações feitas pela CLI:

```bash
pm2 restart pm2-manager
```

Alterações feitas pelo painel entram em vigor imediatamente.

## Invalidação de sessões

Cada usuário possui uma versão de sessão. Ao alterar senha, perfil ou status, essa versão é incrementada e sessões antigas deixam de ser aceitas automaticamente.

## Auditoria

Por padrão:

```text
~/.pm2/pm2-manager-audit.jsonl
```

Cada evento inclui, quando aplicável, data/hora, usuário, perfil, ação, alvo, sucesso/falha, IP e User-Agent.

Além das ações normais do painel, as ferramentas registram:

```text
tools.ecosystem_scan
tools.command
```

A saída dos comandos não é gravada na auditoria. Senhas, cookies, hashes e tokens CSRF também não são gravados.

O arquivo ativo é rotacionado quando chega a aproximadamente 10 MB e, por padrão, são mantidos até 5 arquivos.

Configuração:

```text
PM2_MANAGER_AUDIT_MAX_BYTES
PM2_MANAGER_AUDIT_KEEP
```

## Backups do PM2

O PM2 Manager utiliza:

```text
~/.pm2/dump.pm2
~/.pm2/manager-backups/
```

Antes de cada `PM2 Save`, o dump anterior é copiado para `manager-backups`. Antes de Delete e antes de preparar um restore também são criados backups de segurança quando existe um dump atual.

## Restaurar um backup

Somente um `admin` pode preparar um restore. O painel substitui `~/.pm2/dump.pm2`, mas não mata o daemon automaticamente.

Para aplicar completamente:

```bash
pm2 kill && pm2 resurrect
```

Faça essa etapa em uma sessão SSH ativa.

## Encontrador de ecosystem

A página `Ferramentas` procura arquivos como:

```text
ecosystem.config.js
ecosystem.config.cjs
ecosystem.config.mjs
ecosystem.config.json
ecosystem.production.config.js
ecosystem.yml
ecosystem.yaml
```

Por padrão a busca considera diretórios existentes entre:

```text
~
/var/www
/srv
/opt
```

Para definir raízes diferentes, use uma lista separada por vírgulas:

```text
PM2_MANAGER_SCAN_ROOTS=/var/www,/home/apps,/dados/sistemas
```

Outras proteções:

```text
PM2_MANAGER_SCAN_MAX_DEPTH=7
PM2_MANAGER_SCAN_MAX_RESULTS=500
PM2_MANAGER_SCAN_TIMEOUT_MS=15000
```

A busca ignora diretórios pesados/comuns como `node_modules`, `.git`, `vendor`, logs, builds e links simbólicos.

Na tela, o browser compara o diretório de cada ecosystem aos `cwd`/scripts da lista atual do PM2 e marca arquivos que provavelmente estão relacionados a processos ativos.

## Gerador de comandos e --update-env

A página Ferramentas pode gerar, sem executar automaticamente, comandos como:

```bash
pm2 restart api --update-env
pm2 restart api
pm2 show api
pm2 logs api --lines 100 --nostream
pm2 start /var/www/app/ecosystem.config.js --env production
pm2 save
```

`--update-env` não significa automaticamente “ler o .env do projeto”. Ele atualiza as variáveis de ambiente utilizadas pelo PM2 no restart conforme a origem/configuração daquele processo. Por isso o gerenciador mantém `Restart` e a geração de `Restart + update-env` como operações distintas.

## Terminal seguro

O terminal da página Ferramentas é propositalmente limitado e disponível somente para `admin`.

Ele usa `execFile` sem shell e bloqueia:

```text
;
&&
|
>
<
`...`
$(...)
```

Também não disponibiliza comandos arbitrários como `rm`, `cat`, `curl`, `bash` ou `sh`.

Comandos permitidos incluem consultas como:

```bash
pwd
ls -la
whoami
hostname
uptime
df -h
node -v
npm -v
git status
git branch --show-current
git log -n10 --oneline
pm2 list
pm2 status
pm2 show api
pm2 env 12
pm2 logs api --nostream
```

Comandos PM2 operacionais/destrutivos devem ser feitos pelos controles próprios do painel ou por SSH. O gerador de comandos ajuda a montar a linha correta sem transformar a aplicação web em um shell irrestrito.

O diretório de trabalho do terminal também precisa estar dentro das raízes configuradas para o Finder.

Configuração do timeout:

```text
PM2_MANAGER_TERMINAL_TIMEOUT_MS=8000
PM2_MANAGER_TERMINAL_MAX_BUFFER=262144
```

## Servidor

O `ecosystem.config.js` inicia `bootstrap.js`, que carrega a extensão de Ferramentas e depois inicia o servidor principal. Isso mantém o código de diagnóstico separado do núcleo de autenticação/backups.

Para acesso remoto, coloque o painel atrás de Nginx, VPN, Tailscale ou Cloudflare Access e utilize HTTPS.

## Sessão

A sessão padrão dura 8 horas e pode ser alterada com:

```text
PM2_MANAGER_SESSION_HOURS
```

Valores aceitos: 1 a 24 horas. Após 5 tentativas inválidas a partir do mesmo IP, novas tentativas ficam temporariamente bloqueadas por até 15 minutos.

## Startup do PM2

```bash
pm2 startup
```

Execute o comando `sudo` retornado pelo PM2 e finalize com:

```bash
pm2 save
```

## Atualização

Antes de reiniciar, valide a sintaxe:

```bash
git pull
npm install
npm run check
npm run pm2:update
```

`npm run pm2:update` usa:

```bash
pm2 restart ecosystem.config.js --update-env
```

Se o PM2 Manager ainda estiver registrado apontando diretamente para `server.js` de uma versão antiga, execute uma vez:

```bash
pm2 delete pm2-manager
pm2 start ecosystem.config.js
pm2 save
```

A partir daí ele passa a iniciar por `bootstrap.js`.

## Importante

O PM2 Manager deve rodar com o mesmo usuário Linux que possui os processos PM2 administrados.

Confira com:

```bash
whoami
pm2 list
```
