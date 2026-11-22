-- =========================================================
-- AI LECTURER: DATABASE SETUP (run this ONCE in Supabase)
-- Supabase > SQL Editor > New query > paste all of this > Run
-- It is safe to run again: nothing is deleted.
-- =========================================================

-- Every uploaded document (its text and contents). One row per file, shared by everybody.
create table if not exists docs (
  id text primary key,
  hash text,
  name text not null,
  course_title text,
  pages int,
  data jsonb not null,
  created_at timestamptz default now()
);
create index if not exists docs_hash_idx on docs (hash);

-- Which documents belong to which account (the X button removes only this link)
create table if not exists user_docs (
  user_id uuid not null references auth.users (id) on delete cascade,
  doc_id text not null references docs (id) on delete cascade,
  added_at timestamptz default now(),
  last_opened timestamptz default now(),
  primary key (user_id, doc_id)
);

-- Which topics an account has already generated
create table if not exists progress (
  user_id uuid not null references auth.users (id) on delete cascade,
  doc_id text not null,
  section_id text not null,
  done_at timestamptz default now(),
  primary key (user_id, doc_id, section_id)
);

-- Finished lessons, answers and quizzes, so the same request never asks Gemini twice
create table if not exists cache (
  key text primary key,
  value jsonb not null,
  created_at timestamptz default now()
);

-- LOCK THE TABLES: with no policies, only our server (using the secret key) can read or write them.
alter table docs enable row level security;
alter table user_docs enable row level security;
alter table progress enable row level security;
alter table cache enable row level security;

-- The private folder for the original PDFs
insert into storage.buckets (id, name, public)
values ('pdfs', 'pdfs', false)
on conflict (id) do nothing;
