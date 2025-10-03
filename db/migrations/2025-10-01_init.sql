-- db/migrations/2025-10-01_init.sql
DO $$ BEGIN
  CREATE TYPE artifact_kind AS ENUM ('strokes','audio','thumbnail','draft-strokes','draft-audio');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  is_archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id uuid NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  page_index int NOT NULL,
  title text,
  pdf_path text NOT NULL
);
CREATE INDEX IF NOT EXISTS pages_assignment_idx ON pages(assignment_id, page_index);

CREATE TABLE IF NOT EXISTS students (
  id uuid PRIMARY KEY,
  username text UNIQUE NOT NULL,
  display_number int,
  class_letter text,
  family_pin text,
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  assignment_id uuid NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  page_id uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS submissions_lookup ON submissions(student_id, assignment_id, page_id, created_at DESC);

CREATE TABLE IF NOT EXISTS artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  kind artifact_kind NOT NULL,
  storage_path text,
  strokes_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifacts_submission_kind ON artifacts(submission_id, kind, created_at DESC);
