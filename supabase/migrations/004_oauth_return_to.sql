-- Where to send the browser after Google sign-in (rlyfe.app, the Netlify URL, or
-- localhost while developing). Checked against an allowlist in google-oauth-start.
alter table public.oauth_states add column return_to text not null default 'https://rlyfe.app';
