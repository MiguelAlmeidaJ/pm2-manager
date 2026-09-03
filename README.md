# PM2 Manager

Painel web para administrar muitos processos PM2 sem depender de uma lista extensa no terminal.

## Recursos

- Autenticação por usuário e senha
- Senha armazenada com `scrypt`, nunca em texto puro
- Sessão assinada com expiração
- Cookie `HttpOnly` + `SameSite=Strict`
- Proteção CSRF nas ações administrativas
- Bloqueio temporário após tentativas repetidas de login
- Headers de segurança e proteção contra iframe
- Lista de processos PM2
- Busca por nome, namespace e caminho
- Filtro por status e namespace
- CPU, RAM, restarts e uptime
- Start, Stop, Restart e Delete
- Logs stdout e stderr
- Proteção do próprio processo `pm2-manager`
- Indicador de alterações ainda não salvas
- `PM2 Save` pelo painel
- Backup automático do `dump.pm2` antes de cada save
- Backup automático antes de excluir um processo
- Backup manual
- Histórico de backups
- Download dos dumps
- Preparação segura de restauração
- Retenção automática dos 30 backups mais recentes

## Autenticação

As credenciais não ficam no Git e não são colocadas nas variáveis do processo PM2.

Por padrão, o arquivo de autenticação fica em:

```text
~/.pm2/pm2-manager-auth.json
```

Esse arquivo contém o nome de usuário, o hash `scrypt` da senha e uma chave aleatória usada para assinar as sessões. A senha original não é armazenada.

Para criar ou trocar as credenciais, execute com o mesmo usuário Linux que roda o PM2:

```bash
npm run auth:setup
```

O assistente pedirá:

```text
Usuário [admin]:
Senha:
Confirme a senha:
```

A senha precisa ter pelo menos 12 caracteres.

No Linux, o arquivo é salvo com permissão `600`. O PM2 Manager se recusa a iniciar caso o arquivo esteja ausente ou esteja acessível por outros usuários.

Depois de criar ou alterar a senha:

```bash
pm2 restart pm2-manager
```

Trocar as credenciais gera uma nova chave de sessão, então sessões antigas deixam de ser válidas automaticamente.

## Instalação inicial

```bash
cd /caminho/pm2-manager
npm install
npm run auth:setup
pm2 start ecosystem.config.js
pm2 save
```

Por padrão o painel escuta apenas localmente em:

```text
http://127.0.0.1:4333
```

Use Nginx, VPN, Tailscale ou Cloudflare Access para acesso remoto. Para acesso por navegador fora do próprio servidor, prefira HTTPS.

## Proteções do login

A sessão padrão dura 8 horas.

Pode ser alterada com:

```text
PM2_MANAGER_SESSION_HOURS
```

O valor aceito fica entre 1 e 24 horas.

Após 5 tentativas de login inválidas a partir do mesmo IP, novas tentativas ficam bloqueadas temporariamente por até 15 minutos.

Quando o painel é servido por HTTPS através de um proxy reverso, o cookie de sessão recebe também a flag `Secure`.

## Inicialização automática do PM2

Execute:

```bash
pm2 startup
```

O PM2 mostrará um comando com `sudo`. Execute exatamente o comando informado e depois:

```bash
pm2 save
```

## Onde ficam os backups

O PM2 Manager usa o mesmo `PM2_HOME` do usuário que executa o processo.

Por padrão:

```text
~/.pm2/dump.pm2
~/.pm2/manager-backups/
```

Os backups são mantidos fora do repositório para não serem perdidos durante um `git pull` ou novo deploy.

A retenção padrão é de 30 dumps. Pode ser alterada em `ecosystem.config.js` através de:

```text
PM2_MANAGER_BACKUP_KEEP
```

## Como funciona o PM2 Save

Ao clicar em `PM2 Save`:

1. Se já existir `~/.pm2/dump.pm2`, ele é copiado para `~/.pm2/manager-backups/`.
2. Depois o painel executa o equivalente ao `pm2 save` através da API do PM2.
3. O novo `dump.pm2` passa a representar o estado atual dos processos.

Assim, um save incorreto não elimina imediatamente o estado anterior.

## Exclusão protegida

Antes de executar `Delete` em qualquer processo, o gerenciador cria automaticamente um backup do dump atual.

O próprio processo `pm2-manager` não pode receber Start, Stop, Restart ou Delete pelo painel. Isso evita que o gerenciador derrube a si próprio.

## Recuperação após reboot

Com o `pm2 startup` configurado, o PM2 usa o estado salvo na inicialização.

Para recuperar manualmente o `dump.pm2` atual:

```bash
pm2 resurrect
```

## Restaurar um backup antigo

No painel, clique em `Preparar restore` no backup desejado e confirme digitando:

```text
RESTAURAR
```

O painel:

1. cria um backup emergencial do dump atual;
2. copia o backup escolhido para `~/.pm2/dump.pm2`;
3. não reinicia o daemon automaticamente.

Para aplicar completamente a restauração, mantenha uma sessão SSH aberta e execute:

```bash
pm2 kill && pm2 resurrect
```

Essa etapa é propositalmente manual porque `pm2 kill` derruba também o próprio PM2 Manager. Depois do `resurrect`, o gerenciador voltará automaticamente se estiver presente no dump restaurado.

## Atualizar o gerenciador

Como a autenticação é obrigatória, configure-a antes do primeiro restart após atualizar uma instalação antiga:

```bash
git pull
npm install
npm run auth:setup
pm2 restart pm2-manager
```

Nas próximas atualizações, se o arquivo `~/.pm2/pm2-manager-auth.json` já existir, não é necessário executar `auth:setup` novamente:

```bash
git pull
npm install
pm2 restart pm2-manager
```

Se a alteração mudar a lista de processos que deve sobreviver a um reboot, finalize com:

```bash
pm2 save
```

## Observação importante

O painel deve rodar com o mesmo usuário Linux que possui os processos PM2 que você deseja administrar.

Confira com:

```bash
whoami
pm2 list
```
