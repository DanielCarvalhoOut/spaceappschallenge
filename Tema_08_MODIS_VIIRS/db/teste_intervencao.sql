-- Teste de schema_intervencao.sql: rodar depois de teste_projecao.sql. Valores SINTÉTICOS (região 1 dos testes).
-- ATENÇÃO: escrito em 15/11 com o PostGIS fora do ar; ainda NÃO foi executado. Rodar antes de confiar na função.
\set ON_ERROR_STOP 1
INSERT INTO fire.intervention (region_id, happened_on, kind, source_ref, registered_by)
VALUES (1, DATE '2022-03-10', 'brigada municipal (teste)', 'https://example.org/teste', 'equipe de teste')
ON CONFLICT ON CONSTRAINT intervention_ux DO NOTHING;

-- antes = temporadas de 2019 a 2021, depois = de 2022 em diante; cada lado traz o seu n
SELECT 'antes_depois', b.*
FROM fire.intervention i, fire.intervention_before_after(i.id) b
WHERE i.region_id = 1 AND i.happened_on = DATE '2022-03-10';

DO $$
DECLARE r record;
BEGIN
  SELECT b.* INTO r FROM fire.intervention i, fire.intervention_before_after(i.id) b
  WHERE i.region_id = 1 AND i.happened_on = DATE '2022-03-10';
  IF r.first_season_after <> 2022 THEN RAISE EXCEPTION 'primeira temporada depois deveria ser 2022, veio %', r.first_season_after; END IF;
  IF r.before_n > 3 THEN RAISE EXCEPTION 'antes deveria ter no maximo 3 anos, veio %', r.before_n; END IF;
END $$;

-- negativos esperados (cada um deve falhar)
DO $$ BEGIN
  BEGIN INSERT INTO fire.intervention (region_id, happened_on, kind, source_ref, registered_by)
        VALUES (1, CURRENT_DATE + 30, 'aceiro', 'https://example.org/x', 'equipe'); RAISE EXCEPTION 'data futura aceita';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok: data futura recusada'; END;
  BEGIN INSERT INTO fire.intervention (region_id, happened_on, kind, source_ref, registered_by)
        VALUES (1, DATE '2021-06-01', 'aceiro', '', 'equipe'); RAISE EXCEPTION 'sem fonte aceito';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok: intervencao sem fonte recusada'; END;
  BEGIN INSERT INTO fire.intervention (region_id, happened_on, kind, source_ref, registered_by)
        VALUES (1, DATE '2021-06-01', 'aceiro', 'https://example.org/x', 'fulano@example.org'); RAISE EXCEPTION 'contato aceito';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok: dado de contato recusado'; END;
END $$;

SET ROLE fire_api_ro;
SELECT 'api_le_intervencao', count(*) FROM fire.intervention;
DO $$ BEGIN
  BEGIN INSERT INTO fire.intervention (region_id, happened_on, kind, source_ref, registered_by)
        VALUES (1, DATE '2020-06-01', 'aceiro', 'https://example.org/x', 'equipe'); RAISE EXCEPTION 'api escreveu';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok: API sem escrita'; END;
END $$;
RESET ROLE;
