-- =============================================
-- Suno Planejamento Patrimonial - Supabase Setup v3 (DEFINITIVO)
-- Execute este SQL INTEIRO no SQL Editor do Supabase
-- Resolve o erro "new row violates row-level security policy"
-- =============================================

-- 1. Remover TODAS as políticas antigas (nomes possíveis das versões v1 e v2)
DROP POLICY IF EXISTS "Permitir insert público" ON questionarios;
DROP POLICY IF EXISTS "Permitir select público" ON questionarios;
DROP POLICY IF EXISTS "Permitir delete público" ON questionarios;
DROP POLICY IF EXISTS "anon_insert" ON questionarios;
DROP POLICY IF EXISTS "auth_select" ON questionarios;
DROP POLICY IF EXISTS "auth_delete" ON questionarios;

-- 2. Garantir que a tabela existe
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

-- 3. Habilitar RLS
ALTER TABLE questionarios ENABLE ROW LEVEL SECURITY;

-- 4. INSERT liberado para qualquer pessoa (cliente anônimo preenchendo o form)
--    IMPORTANTE: "WITH CHECK (true)" garante que qualquer linha pode ser inserida
CREATE POLICY "public_insert"
  ON questionarios
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

-- 5. SELECT apenas para usuários autenticados (consultor logado vê as respostas)
CREATE POLICY "auth_select"
  ON questionarios
  FOR SELECT
  TO authenticated
  USING (true);

-- 6. DELETE apenas para usuários autenticados
CREATE POLICY "auth_delete"
  ON questionarios
  FOR DELETE
  TO authenticated
  USING (true);

-- 7. Verificação final: liste as políticas criadas para confirmar
-- (opcional — pode rodar separadamente no SQL Editor)
-- SELECT policyname, cmd, roles FROM pg_policies WHERE tablename = 'questionarios';
