# PM2 Manager

Painel web simples para organizar e gerenciar muitos processos PM2.

## Recursos

- Lista todos os processos
- Busca por nome, namespace e caminho
- Filtro por status
- Filtro por namespace
- CPU e RAM
- Número de reinícios
- Uptime
- Start
- Stop
- Restart
- Delete
- Visualização dos logs stdout/stderr
- Atualização automática a cada 5 segundos

## Instalação

```bash
npm install
npm start
```

Por padrão:

```text
http://127.0.0.1:3333
```

## Importante

O processo do painel precisa rodar com o mesmo usuário do Linux que possui os processos PM2.

Exemplo:

```bash
whoami
pm2 list
node server.js
```

Se quiser deixar o próprio painel no PM2:

```bash
pm2 start server.js --name pm2-manager
pm2 save
```

## Acesso remoto

Por segurança, o servidor inicia em `127.0.0.1`.

Prefira expor via Nginx com autenticação, VPN, Tailscale ou Cloudflare Access.

Não exponha diretamente a porta 3333 na internet sem autenticação.
