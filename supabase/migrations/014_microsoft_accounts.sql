-- Microsoft (Outlook / Microsoft 365) accounts alongside Gmail
alter table public.email_threads add column web_link text;
comment on column public.email_threads.web_link is 'Outlook on the web link to the latest message (Microsoft accounts only)';
comment on column public.email_threads.gmail_history_id is 'Thread version: Gmail historyId, or for Microsoft the newest inbox change stamp + count';
comment on column public.sender_prefs.gmail_filters is '{ account_id: rule id } — Gmail filter id or Outlook inbox rule id';
