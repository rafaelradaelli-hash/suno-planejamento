-- =============================================
-- Suno Planejamento Patrimonial - Supabase Setup
-- Execute este SQL no SQL Editor do Supabase
-- =============================================

-- 1. Criar a tabela
CREATE TABLE IF NOT EXISTS questionarios (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  nome TEXT,
  cidade TEXT,
  estado TEXT,
  consultor TEXT,
  patrimonio_investido TEXT,
  dados JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Habilitar RLS (Row Level Security)
ALTER TABLE questionarios ENABLE ROW LEVEL SECURITY;

-- 3. Permitir que qualquer pessoa insira (cliente preenchendo o form)
CREATE POLICY "Permitir insert público"
  ON questionarios FOR INSERT
  TO anon
  WITH CHECK (true);

-- 4. Permitir leitura pública (protegida por senha no frontend)
CREATE POLICY "Permitir select público"
  ON questionarios FOR SELECT
  TO anon
  USING (true);

-- 5. Permitir exclusão pública (protegida por senha no frontend)
CREATE POLICY "Permitir delete público"
  ON questionarios FOR DELETE
  TO anon
  USING (true);
