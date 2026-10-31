-- Authored by hand (not generated): the work breakdown and the milestones of a project (ST-PRJ-009, PRJ 3.1 BR-PRJ-08, PRJ-05, PRJ-07).
-- V002 gave `project_component` and `project_milestone` their columns, the unique code inside a project and the check that a done milestone names the day it was done. This adds what the screens and the
-- commands rely on: the shape of the words, the keys that keep a component under a parent of the same project and a milestone on a component and a dependency of the same project, the reason a milestone was
-- delayed or cancelled, a guard that keeps the baseline for good, an ended milestone as it was and the dependencies free of loops, and the loss of the right to delete.

ALTER TABLE machvon.project_component
  ADD CONSTRAINT project_component_words_chk CHECK (
    code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$' AND name = btrim(name) AND char_length(name) BETWEEN 2 AND 300
  ),
  ADD CONSTRAINT project_component_sort_chk CHECK (sort_order BETWEEN 0 AND 100000),
  ADD CONSTRAINT project_component_parent_chk CHECK (parent_component_id IS NULL OR parent_component_id <> id);

-- A key on (tenant, project, id) lets a component name its parent, and a milestone its component and its dependency, only inside the project.
CREATE UNIQUE INDEX project_component_scope_uq ON machvon.project_component (tenant_id, project_id, id);
CREATE UNIQUE INDEX project_milestone_scope_uq ON machvon.project_milestone (tenant_id, project_id, id);

ALTER TABLE machvon.project_component
  ADD CONSTRAINT project_component_project_fk FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  ADD CONSTRAINT project_component_parent_fk FOREIGN KEY (tenant_id, project_id, parent_component_id) REFERENCES machvon.project_component (tenant_id, project_id, id);

ALTER TABLE machvon.project_milestone ADD COLUMN status_reason text;

ALTER TABLE machvon.project_milestone
  ADD CONSTRAINT project_milestone_words_chk CHECK (
    code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$' AND name = btrim(name) AND char_length(name) BETWEEN 2 AND 300
  ),
  ADD CONSTRAINT project_milestone_actual_chk CHECK ((status = 'DONE') = (actual_date IS NOT NULL)),
  ADD CONSTRAINT project_milestone_reason_chk CHECK ((status NOT IN ('DELAYED', 'CANCELLED') OR status_reason IS NOT NULL) AND (status <> 'PLANNED' OR status_reason IS NULL)),
  ADD CONSTRAINT project_milestone_reason_len_chk CHECK (status_reason IS NULL OR char_length(status_reason) BETWEEN 5 AND 2000),
  ADD CONSTRAINT project_milestone_self_chk CHECK (depends_on_milestone_id IS NULL OR depends_on_milestone_id <> id),
  ADD CONSTRAINT project_milestone_project_fk FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  ADD CONSTRAINT project_milestone_component_fk FOREIGN KEY (tenant_id, project_id, component_id) REFERENCES machvon.project_component (tenant_id, project_id, id),
  ADD CONSTRAINT project_milestone_depends_fk FOREIGN KEY (tenant_id, project_id, depends_on_milestone_id) REFERENCES machvon.project_milestone (tenant_id, project_id, id);

CREATE INDEX project_component_list_idx ON machvon.project_component (tenant_id, project_id, parent_component_id, sort_order, code);
CREATE INDEX project_milestone_list_idx ON machvon.project_milestone (tenant_id, project_id, planned_date, code);
CREATE INDEX project_milestone_depends_idx ON machvon.project_milestone (tenant_id, depends_on_milestone_id) WHERE depends_on_milestone_id IS NOT NULL;

-- A milestone keeps its project, code, baseline day and author for good; a milestone that is done or cancelled changes no more; what a milestone waits for never closes a loop.
CREATE FUNCTION machvon.guard_project_milestone_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  cursor_id uuid;
  steps int := 0;
BEGIN
  IF OLD.status IN ('DONE', 'CANCELLED') THEN
    RAISE EXCEPTION 'a done or cancelled milestone is never changed' USING ERRCODE = '23514';
  END IF;
  IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.code IS DISTINCT FROM OLD.code OR NEW.baseline_date IS DISTINCT FROM OLD.baseline_date
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a milestone keeps its project, code and baseline day' USING ERRCODE = '23514';
  END IF;
  cursor_id := NEW.depends_on_milestone_id;
  WHILE cursor_id IS NOT NULL AND steps < 10000 LOOP
    IF cursor_id = NEW.id THEN
      RAISE EXCEPTION 'a milestone dependency would form a loop' USING ERRCODE = '23514';
    END IF;
    SELECT m.depends_on_milestone_id INTO cursor_id FROM machvon.project_milestone m WHERE m.tenant_id = NEW.tenant_id AND m.id = cursor_id;
    steps := steps + 1;
  END LOOP;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER project_milestone_update_guard BEFORE UPDATE ON machvon.project_milestone
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_project_milestone_update();

REVOKE DELETE, TRUNCATE ON TABLE machvon.project_component FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.project_milestone FROM machvon_app;
