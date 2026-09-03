# PM2 Manager

Painel web para administrar muitos processos PM2 com autenticação, backup do `dump.pm2`, controle de acesso e auditoria de uso.

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

## Perfis de acesso

### Viewer

Pode consultar:

- processos;
- status;
- CPU/RAM;
- logs;
- lista de backups.

Não pode executar comandos nem baixar dumps.

### Operator

Possui tudo do Viewer e também pode:

- Start;
- Stop;
- Restart;
- PM2 Save;
- criar backup manual.

Não pode executar Delete, baixar dumps, restaurar backup, gerenciar usuários ou acessar a auditoria administrativa.

### Admin

Possui acesso completo, incluindo:

- Delete;
- download de `dump.pm2`;
- preparação de restore;
- criação e edição de usuários;
- auditoria.

O sistema sempre exige pelo menos um administrador ativo.

## Onde ficam as credenciais

As credenciais não ficam no Git nem nas variáveis de ambiente salvas pelo PM2.

Por padrão:

```text
~/.pm2/pm2-manager-auth.json
```

O arquivo contém:

- chave aleatória de sessão;
- lista de usuários;
- perfil de cada usuário;
- hash `scrypt` da senha;
- versão de sessão para invalidação de acessos antigos.

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

O assistente `auth:setup` cria ou atualiza um administrador.

A senha deve possuir pelo menos 12 caracteres.

## Criar usuários pelo painel

Entre com um usuário `admin` e abra:

```text
Usuários > Novo usuário
```

Informe:

- usuário;
- perfil;
- senha temporária.

Cada pessoa deve possuir seu próprio login. Não compartilhe uma conta administrativa se a intenção é ter auditoria confiável.

## Gerenciamento de usuários pelo terminal

Existe também uma CLI de recuperação, útil caso você perca acesso administrativo ao painel.

Listar usuários:

```bash
npm run users -- list
```

Criar usuário:

```bash
npm run users -- add
```

Trocar senha:

```bash
npm run users -- password usuario
```

Alterar perfil:

```bash
npm run users -- role usuario operator
```

Desativar:

```bash
npm run users -- disable usuario
```

Ativar:

```bash
npm run users -- enable usuario
```

Remover:

```bash
npm run users -- remove usuario
```

Após alterações feitas pela CLI, reinicie o processo para recarregar o arquivo:

```bash
pm2 restart pm2-manager
```

Alterações feitas pelo próprio painel entram em vigor imediatamente.

## Invalidação de sessões

Cada usuário possui uma versão de sessão.

Ao alterar senha, perfil ou status de um usuário, essa versão é incrementada e sessões antigas deixam de ser aceitas automaticamente.

Isso permite revogar acesso sem alterar a chave de sessão de todos os demais usuários.

## Auditoria

Por padrão, os registros ficam em:

```text
~/.pm2/pm2-manager-audit.jsonl
```

Cada evento inclui, quando aplicável:

- data/hora;
- usuário;
- perfil;
- ação;
- processo ou backup afetado;
- sucesso/falha;
- IP;
- User-Agent.

São registrados eventos como:

```text
auth.login_success
auth.login_failed
auth.login_blocked
auth.logout
process.start
process.stop
process.restart
process.delete
process.logs_viewed
pm2.save
backup.create
backup.download
backup.restore_prepared
user.create
user.update
user.delete
```

Senhas, cookies, hashes de senha e tokens CSRF não são gravados na auditoria.

A tela `Auditoria` é visível apenas para administradores.

### Rotação do log

O arquivo ativo é rotacionado quando chega a aproximadamente 10 MB.

Por padrão são mantidos até 5 arquivos.

Pode ser ajustado através de:

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

Antes de cada `PM2 Save`, o dump anterior é copiado para `manager-backups`.

Antes de Delete e antes de preparar um restore também são criados backups de segurança quando existe um dump atual.

## Restaurar um backup

Somente um `admin` pode preparar um restore.

No painel, escolha o backup e confirme digitando:

```text
RESTAURAR
```

O painel substitui `~/.pm2/dump.pm2`, mas não mata o daemon automaticamente.

Para aplicar completamente o estado salvo:

```bash
pm2 kill && pm2 resurrect
```

Faça essa etapa em uma sessão SSH ativa.

## Servidor

Por padrão o painel escuta apenas em:

```text
http://127.0.0.1:4333
```

Para acesso remoto, coloque o painel atrás de Nginx, VPN, Tailscale ou Cloudflare Access e utilize HTTPS.

## Sessão

A sessão padrão dura 8 horas.

Pode ser alterada com:

```text
PM2_MANAGER_SESSION_HOURS
```

Valores aceitos: 1 a 24 horas.

Após 5 tentativas inválidas a partir do mesmo IP, novas tentativas ficam temporariamente bloqueadas por até 15 minutos.

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
pm2 restart pm2-manager
```

Se for a primeira atualização a partir de uma versão sem autenticação:

```bash
npm run auth:setup
```

## Importante

O PM2 Manager deve rodar com o mesmo usuário Linux que possui os processos PM2 administrados.

Confira com:

```bash
whoami
pm2 list
```
