-- Schema: initial tables per spec

create table if not exists students (
  id uuid primary key default gen_random_uuid(),
  username text unique not null,
  display_number int not null,
  class_letter text not null,
  family_pin text,
  is_active boolean default true
);

create table if not exists activities (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  type text not null check (type in ('pdf','video','photo')),
  pdf_url text,
  is_book boolean default false,
  per_page_recording boolean default false,
  audio_limit_sec int default 180,
  settings jsonb default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now()
);

create table if not exists template_page_audio (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid references activities(id) on delete cascade,
  page int not null,
  audio_url text,
  hotspots jsonb default '[]'::jsonb,
  unique (activity_id, page)
);

create table if not exists assignments (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid references activities(id) on delete cascade,
  class_letter text not null,
  date date not null,
  windows jsonb default '[]'::jsonb,
  allow_outside_window boolean default false,
  audio_limit_sec int,
  per_page_recording boolean,
  created_at timestamptz default now()
);

create table if not exists assignment_page_audio (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid references assignments(id) on delete cascade,
  page int not null,
  audio_url text,
  hotspots jsonb default '[]'::jsonb,
  unique (assignment_id, page)
);

create table if not exists submissions (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid references assignments(id) on delete cascade,
  student_id uuid references students(id) on delete cascade,
  attempt int not null,
  created_at timestamptz default now(),
  pdf_url text,
  strokes_manifest jsonb default '{"pages":[]}'::jsonb,
  has_audio boolean default false,
  video_url text,
  inked_pdf_url text,
  duration_sec int
);
create index if not exists submissions_asg_std on submissions (assignment_id, student_id);

create table if not exists comments (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid references submissions(id) on delete cascade,
  teacher_id uuid references auth.users(id) on delete set null,
  type text not null check (type in ('text','audio','video')),
  text text,
  media_url text,
  created_at timestamptz default now()
);

create table if not exists peer_comments (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid references submissions(id) on delete cascade,
  page int,
  author_id uuid references students(id) on delete cascade,
  audience text not null check (audience in ('class','group','pair','direct')),
  video_url text not null,
  duration_sec int not null,
  is_hidden boolean default false,
  is_pinned boolean default false,
  created_at timestamptz default now()
);

create table if not exists collab_sessions (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid references assignments(id) on delete cascade,
  page int not null,
  scope text not null check (scope in ('class','group','one_to_one')),
  groups jsonb default '[]'::jsonb,
  active boolean default false,
  created_at timestamptz default now()
);

-- Minimal RLS examples (adjust to your roles)
alter table students enable row level security;
alter table submissions enable row level security;

create policy students_self on students for select using (auth.uid() = id);

create policy submissions_self on submissions for select using (
  exists(select 1 from students s where s.id = auth.uid() and s.id = student_id)
);
