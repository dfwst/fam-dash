# rlyfe — our life, one calm page

One calm page for Jason and Blake: who needs a reply, what's due, what's coming.

**Stack:** Vite · React · TypeScript · Supabase (Postgres, Auth with 2FA, Edge Functions) · Netlify
**Supabase project:** `fam-dash` (ref `obubqqolwnglbafaqdbp`, DFWST org)
**Plan:** https://claude.ai/artifact/Yb4qxCAq4a38UVhSGUZc57

## Run locally
```
npm install
cp .env.example .env.local   # fill in the publishable key
npm run dev
```

## Deploy
`git push` → Netlify builds (`npm run build`) and publishes `dist/`.
Netlify env vars: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`.

## Database
Migrations in `supabase/migrations/`, run in order. Every table:
row-level security on, readable only when `private.has_2fa()` and `private.is_member(household_id)`.
Secrets (Google tokens, Claude key) live only in Edge Function secrets — never in the browser or the repo.
