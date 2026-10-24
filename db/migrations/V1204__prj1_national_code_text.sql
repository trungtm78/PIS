-- Authored by hand (not generated): the national project code of a project (ST-PRJ-004, PRJ 3.1 F7, BR-PRJ-02).
-- The column national_project_code and the unique index project_national_code_uq (one code to one project in a tenant) come from the generated schema (V002).
-- The code is a text that two systems compare as it was typed: a code that differs only by a space would defeat the unique index, so it is stored trimmed,
-- never blank, and as short as the contract says (50). Format and whether it is required are rule data (NATIONAL_CODE_FORMAT, NATIONAL_CODE_REQUIRED),
-- judged by the commands against the rule in force on the day, not frozen here.

ALTER TABLE machvon.project
  ADD CONSTRAINT project_national_code_text_chk CHECK (
    national_project_code IS NULL
    OR (national_project_code = btrim(national_project_code) AND national_project_code <> '' AND length(national_project_code) <= 50 AND national_project_code !~ '[[:cntrl:]]')
  );
