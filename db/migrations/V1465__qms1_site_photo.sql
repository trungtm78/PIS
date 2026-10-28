-- QMS-1, ST-QMS-003: the site photo register. The table site_photo comes from the generated schema (V002). This adds what the register relies on: the zones of a site that the place of a photo is compared to, the rule that
-- a place is kept only with the consent to it (without exception, the place in the EXIF of the file included), one registration for one stored file, and a register that nobody edits or erases (the photos are evidence).

-- The zones of a site, as a centre and a radius (R-QMS-04): a project may have several (a stretch of road is a chain of them). PRJ owns the shape of a site; until it offers a command for it the rows are written by the
-- owner of the data, and a project with no zone has no place to compare a photo to (the check says MISSING).
CREATE TABLE machvon.project_site_zone (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  project_id uuid NOT NULL,
  label text NOT NULL CHECK (label = btrim(label) AND label <> ''),
  center_lat numeric(9, 6) NOT NULL CHECK (center_lat BETWEEN -90 AND 90),
  center_lng numeric(9, 6) NOT NULL CHECK (center_lng BETWEEN -180 AND 180),
  radius_m integer NOT NULL DEFAULT 500 CHECK (radius_m BETWEEN 1 AND 50000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT project_site_zone_project_fk FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id)
);
CREATE INDEX project_site_zone_project_idx ON machvon.project_site_zone (tenant_id, project_id);

ALTER TABLE machvon.project_site_zone ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.project_site_zone FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.project_site_zone AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.project_site_zone AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- A place is kept only with the consent to it: with no consent there is no latitude, no longitude, no accuracy and no source (V002 let a place that came from the EXIF through without it).
ALTER TABLE machvon.site_photo ADD CONSTRAINT site_photo_place_chk CHECK (
  (gps_lat IS NULL) = (gps_lng IS NULL)
  AND (gps_lat IS NULL OR (geo_consent AND gps_lat BETWEEN -90 AND 90 AND gps_lng BETWEEN -180 AND 180 AND gps_source <> 'NONE'))
  AND (gps_lat IS NOT NULL OR (gps_accuracy_m IS NULL AND gps_source = 'NONE'))
  AND (gps_accuracy_m IS NULL OR gps_accuracy_m >= 0)
);
-- The review flags and the facts they were drawn from do not contradict each other.
ALTER TABLE machvon.site_photo ADD CONSTRAINT site_photo_checks_chk CHECK (
  (check_geofence <> 'INSIDE' AND check_geofence <> 'OUTSIDE') OR gps_lat IS NOT NULL
);
ALTER TABLE machvon.site_photo ADD CONSTRAINT site_photo_sha256_chk CHECK (file_sha256 ~ '^[0-9a-f]{64}$');
-- One stored file is registered once (another registration of the same file is a mistake of the client, not a repeated photo: the repeated photo is another file with the same hash).
CREATE UNIQUE INDEX site_photo_object_uq ON machvon.site_photo (tenant_id, object_key);

-- A registered photo is evidence: nothing edits it, and the runtime role cannot erase it.
CREATE FUNCTION machvon.guard_site_photo() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'a registered photo is kept as it was registered' USING ERRCODE = '23514';
END;
$fn$;
CREATE TRIGGER site_photo_guard BEFORE UPDATE ON machvon.site_photo
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_site_photo();
REVOKE DELETE, TRUNCATE ON TABLE machvon.site_photo FROM machvon_app;
