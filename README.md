# Suno Planejamento Patrimonial

Plataforma de questionário para planejamento de risco, vida e sucessão.

## Setup Rápido

### 1. Configurar Supabase

1. Acesse o painel do Supabase: https://supabase.com/dashboard
2. Abra o projeto `zjowgamtmfqzievqnrhg`
3. Vá em **SQL Editor** e cole o conteúdo do arquivo `supabase-setup.sql`
4. Clique em **Run** para criar a tabela

### 2. Pegar a Anon Key do Supabase

1. No painel do Supabase, vá em **Settings** → **API**
2. Copie a **anon public** key (começa com `eyJ...`)
3. Guarde essa chave para o próximo passo

### 3. Deploy no Vercel

1. Crie um novo repositório no GitHub (ex: `suno-planejamento`)
2. Faça upload de todos os arquivos deste projeto para o repositório
3. No Vercel, importe o repositório
4. **Antes de fazer deploy**, vá em **Settings** → **Environment Variables** e adicione:

| Variável | Valor |
|---|---|
| `VITE_SUPABASE_URL` | `https://zjowgamtmfqzievqnrhg.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | *(cole a anon key do passo 2)* |
| `VITE_CONSULTOR_PASSWORD` | `suno2026` *(ou outra senha que preferir)* |

5. Faça o deploy

### 4. Compartilhar com Clientes

Envie o link do Vercel (ex: `suno-planejamento.vercel.app`) via WhatsApp.
O cliente preenche o formulário e você acessa as respostas pelo botão **Consultor**.

## Estrutura

```
├── index.html
├── package.json
├── vite.config.js
├── vercel.json
├── supabase-setup.sql    ← Execute no Supabase
├── public/
│   └── favicon.svg
└── src/
    ├── main.jsx
    ├── App.jsx           ← Componente principal
    ├── supabase.js       ← Conexão com Supabase
    └── styles.css
```

## Senha do Painel

A senha padrão do painel do consultor é `suno2026`.
Para alterá-la, mude a variável `VITE_CONSULTOR_PASSWORD` no Vercel.
